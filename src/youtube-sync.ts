import fs from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { buildIndex } from './videos-db.js';
import { mergeArchiveRecords } from './videos-import.js';
import { backfillStatePath, ensureDataDir, syncDebugDirPath } from './paths.js';
import { saveSyncReport } from './report.js';
import type { SyncCaptureMethod, SyncMethodReport, SyncReport, VideoRecord, YtBootstrapConfig, YtBootstrapPayload } from './types.js';
import { createSapisidAuthHeader } from './youtube-web.js';

const YOUTUBE_ORIGIN = 'https://www.youtube.com';
const LIKES_URL = `${YOUTUBE_ORIGIN}/playlist?list=LL`;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface SyncOptions {
  cookieHeader: string;
  sapisid: string;
  maxPages: number;
  delayMs: number;
  maxMinutes: number;
  chromeUserDataDir: string;
  chromeProfileDirectory: string;
  debugNetwork: boolean;
  full?: boolean;
}

interface BootstrapDocument {
  html: string;
  initialData: Record<string, any>;
  payload: YtBootstrapPayload;
}

interface ParsedRendererRecord {
  record: VideoRecord;
  sourceId: string | null;
}

interface CollectContext {
  startedAt: number;
  baselineCeiling: number;
  importedAt: string;
  debugDir: string | null;
  debugArtifacts: string[];
  methodStats: Map<SyncCaptureMethod, {
    ids: Set<string>;
    discoveredCount: number;
    storedCount: number;
    maxIndex: number | null;
    stopReason: string;
  }>;
}

interface StoreBatchOptions {
  page: number;
  method: SyncCaptureMethod;
  surface: string;
  records: VideoRecord[];
  sourceIds?: Array<string | null>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractBalancedJson(text: string, marker: string): string {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Could not find marker: ${marker}`);
  }

  const start = text.indexOf('{', markerIndex);
  if (start < 0) {
    throw new Error(`Could not find opening brace after marker: ${marker}`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  throw new Error(`Could not extract balanced JSON for marker: ${marker}`);
}

function textFromRuns(node: any): string | null {
  if (!node) return null;
  if (typeof node.simpleText === 'string') return node.simpleText.trim() || null;
  if (Array.isArray(node.runs)) {
    const text = node.runs.map((run: any) => typeof run?.text === 'string' ? run.text : '').join('').trim();
    return text || null;
  }
  return null;
}

function parseCount(text: string | undefined): number | null {
  if (!text) return null;
  const digits = text.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return Number.parseInt(digits, 10);
}

function collectValuesByKey(value: any, key: string, out: any[] = []): any[] {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectValuesByKey(item, key, out);
    return out;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) out.push(entryValue);
    collectValuesByKey(entryValue, key, out);
  }
  return out;
}

function firstString(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeUrl(input: string | null): string | null {
  if (!input) return null;
  try {
    return new URL(input, YOUTUBE_ORIGIN).toString();
  } catch {
    return null;
  }
}

function uniqueStrings(values: Array<string | null | undefined>): string[] | null {
  const cleaned = values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean);
  return cleaned.length ? Array.from(new Set(cleaned)) : null;
}

function derivePrivacyStatus(renderer: any): string | null {
  if (renderer?.isPlayable === false) return 'unavailable';
  const title = textFromRuns(renderer?.title)?.toLowerCase() ?? '';
  if (title.includes('private video')) return 'private';
  if (title.includes('deleted video')) return 'deleted';
  return 'public';
}

export function parseRendererToRecord(renderer: any, method: SyncCaptureMethod, page: number, importedAt: string): ParsedRendererRecord | null {
  const videoId = firstString([
    renderer?.videoId,
    renderer?.navigationEndpoint?.watchEndpoint?.videoId,
  ]);
  const url = normalizeUrl(firstString([
    renderer?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url,
    videoId ? `/watch?v=${videoId}` : null,
  ]));
  if (!videoId && !url) return null;

  const sourceId = firstString([
    renderer?.setVideoId,
    renderer?.navigationEndpoint?.watchEndpoint?.playlistId,
  ]);

  const channelRuns = renderer?.shortBylineText?.runs ?? [];
  const channelTitle = channelRuns
    .map((run: any) => typeof run?.text === 'string' ? run.text : '')
    .join('')
    .trim() || null;
  const channelId = firstString(
    channelRuns.map((run: any) => run?.navigationEndpoint?.browseEndpoint?.browseId ?? null)
  );
  const index = renderer?.index?.simpleText ? Number.parseInt(renderer.index.simpleText, 10) : null;

  const viewCountText = firstString(
    (renderer?.videoInfo?.runs ?? [])
      .map((run: any) => typeof run?.text === 'string' ? run.text : null)
      .filter((text: string | null) => text && text !== ' • ' && !/ago$/i.test(text))
  );

  const thumbnails = uniqueStrings((renderer?.thumbnail?.thumbnails ?? []).map((thumb: any) => thumb?.url ?? null));
  const duration = firstString([
    textFromRuns(renderer?.lengthText),
    renderer?.lengthSeconds ? `${renderer.lengthSeconds}s` : null,
  ]);

  const record: VideoRecord = {
    id: videoId ?? url ?? sourceId ?? `${method}-${page}-${Math.random()}`,
    video_id: videoId,
    playlist_item_id: null,
    url: url ?? `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    title: textFromRuns(renderer?.title) ?? '(untitled)',
    description: null,
    channel_id: channelId,
    channel_title: channelTitle,
    liked_at: null,
    video_published_at: null,
    duration,
    privacy_status: derivePrivacyStatus(renderer),
    position: index,
    categories: null,
    primary_category: null,
    domains: null,
    primary_domain: null,
    classification_reason: null,
    classification_engine: null,
    classification_model: null,
    classified_at: null,
    thumbnails,
    view_count_text: viewCountText,
    sync_capture_method: method,
    sync_surface: 'youtube.com/playlist?list=LL',
    sync_page: page,
    sync_index: index,
    sync_source_id: sourceId,
    first_seen_at: importedAt,
    last_seen_at: importedAt,
    imported_at: importedAt,
  };

  return { record, sourceId };
}

function parseBootstrapDocument(html: string): BootstrapDocument {
  const cfg = JSON.parse(extractBalancedJson(html, 'ytcfg.set({')) as YtBootstrapConfig;
  const initialData = JSON.parse(extractBalancedJson(html, 'var ytInitialData = ')) as Record<string, any>;
  const continuationToken = (html.match(/"continuationCommand":\{"token":"([^"]+)"/)?.[1] ?? null);
  if (!continuationToken) {
    throw new Error('Could not find a continuation token in ytInitialData.');
  }

  const statedVideoCount = parseCount(
    initialData?.header?.playlistHeaderRenderer?.numVideosText?.runs?.map((run: { text: string }) => run.text).join('')
      ?? initialData?.sidebar?.playlistSidebarRenderer?.items?.[0]?.playlistSidebarPrimaryInfoRenderer?.stats?.[0]?.runs?.map((run: { text: string }) => run.text).join('')
  );

  const alerts = (initialData?.alerts ?? [])
    .map((alert: any) => alert?.alertWithButtonRenderer?.text?.simpleText)
    .filter((value: unknown): value is string => typeof value === 'string');

  return {
    html,
    initialData,
    payload: {
      apiKey: cfg.INNERTUBE_API_KEY,
      clientVersion: cfg.INNERTUBE_CLIENT_VERSION,
      visitorData: cfg.VISITOR_DATA,
      sessionIndex: String(cfg.SESSION_INDEX ?? 0),
      hl: String(cfg.HL ?? 'en'),
      gl: String(cfg.GL ?? 'US'),
      dataSyncId: String(initialData?.responseContext?.mainAppWebResponseContext?.datasyncId ?? '').split('||')[0],
      continuationToken,
      pageTitle: String(initialData?.metadata?.playlistMetadataRenderer?.title ?? 'Liked videos'),
      statedVideoCount,
      alerts,
    },
  };
}

async function fetchBootstrapDocument(cookieHeader: string): Promise<BootstrapDocument> {
  const response = await fetch(LIKES_URL, {
    headers: {
      cookie: cookieHeader,
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Could not load YouTube Likes page (${response.status}).`);
  }

  return parseBootstrapDocument(await response.text());
}

async function fetchContinuationJson(
  payload: YtBootstrapPayload,
  cookieHeader: string,
  sapisid: string,
  continuationToken: string
): Promise<Record<string, any>> {
  const timestampSec = Math.floor(Date.now() / 1000);
  const response = await fetch(`${YOUTUBE_ORIGIN}/youtubei/v1/browse?prettyPrint=false&key=${payload.apiKey}`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
      authorization: createSapisidAuthHeader(sapisid, payload.dataSyncId, timestampSec),
      'x-youtube-client-name': '1',
      'x-youtube-client-version': payload.clientVersion,
      'x-goog-visitor-id': payload.visitorData,
      'x-goog-authuser': payload.sessionIndex,
      'x-youtube-bootstrap-logged-in': 'true',
      'x-origin': YOUTUBE_ORIGIN,
      origin: YOUTUBE_ORIGIN,
      referer: LIKES_URL,
      'user-agent': USER_AGENT,
      accept: '*/*',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: payload.clientVersion,
          visitorData: payload.visitorData,
          hl: payload.hl,
          gl: payload.gl,
        },
        user: { lockedSafetyMode: false },
        request: { useSsl: true },
      },
      continuation: continuationToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Continuation request failed (${response.status}).`);
  }

  const json = await response.json() as Record<string, any>;
  if (json?.responseContext?.mainAppWebResponseContext?.loggedOut) {
    throw new Error('YouTube continuation request came back logged out.');
  }
  return json;
}

function extractContinuationToken(json: Record<string, any>): string | null {
  const tokens = collectValuesByKey(json, 'continuationCommand')
    .map((entry: any) => entry?.token ?? null)
    .filter((entry: string | null): entry is string => typeof entry === 'string');
  return tokens[0] ?? null;
}

export function parseRendererBatch(
  renderers: any[],
  method: SyncCaptureMethod,
  page: number,
  importedAt: string
): ParsedRendererRecord[] {
  const seen = new Set<string>();
  const parsed: ParsedRendererRecord[] = [];
  for (const renderer of renderers) {
    const normalized = parseRendererToRecord(renderer, method, page, importedAt);
    if (!normalized) continue;
    if (seen.has(normalized.record.id)) continue;
    seen.add(normalized.record.id);
    parsed.push(normalized);
  }
  return parsed.sort((a, b) => (a.record.sync_index ?? Number.MAX_SAFE_INTEGER) - (b.record.sync_index ?? Number.MAX_SAFE_INTEGER));
}

function makeMethodReport(method: SyncCaptureMethod, stats: CollectContext['methodStats']): SyncMethodReport {
  const current = stats.get(method);
  return {
    method,
    storedCount: current?.storedCount ?? 0,
    discoveredCount: current?.discoveredCount ?? 0,
    maxIndex: current?.maxIndex ?? null,
    stopReason: current?.stopReason ?? 'not attempted',
    beatBaseline: false,
  };
}

function noteMethodStop(context: CollectContext, method: SyncCaptureMethod, stopReason: string): void {
  const current = context.methodStats.get(method) ?? {
    ids: new Set<string>(),
    discoveredCount: 0,
    storedCount: 0,
    maxIndex: null,
    stopReason: 'not attempted',
  };
  current.stopReason = stopReason;
  context.methodStats.set(method, current);
}

async function persistDebugArtifact(context: CollectContext, fileName: string, payload: string): Promise<void> {
  if (!context.debugDir) return;
  fs.mkdirSync(context.debugDir, { recursive: true });
  const filePath = path.join(context.debugDir, fileName);
  fs.writeFileSync(filePath, payload);
  context.debugArtifacts.push(filePath);
}

async function storeBatch(context: CollectContext, options: StoreBatchOptions): Promise<{ inserted: number; total: number }> {
  if (!options.records.length) return { inserted: 0, total: 0 };
  const stat = context.methodStats.get(options.method) ?? {
    ids: new Set<string>(),
    discoveredCount: 0,
    storedCount: 0,
    maxIndex: null,
    stopReason: 'in progress',
  };

  for (const record of options.records) {
    stat.ids.add(record.id);
    stat.discoveredCount = stat.ids.size;
    if (typeof record.sync_index === 'number') {
      stat.maxIndex = Math.max(stat.maxIndex ?? record.sync_index, record.sync_index);
    }
  }

  const merged = await mergeArchiveRecords(options.records);
  stat.storedCount = merged.total;
  context.methodStats.set(options.method, stat);
  return merged;
}

function elapsedMinutes(startedAt: number): number {
  return (Date.now() - startedAt) / 60000;
}

function chromeExecutablePath(): string {
  if (!existsSync(CHROME_EXECUTABLE)) {
    throw new Error(`Google Chrome was not found at ${CHROME_EXECUTABLE}`);
  }
  return CHROME_EXECUTABLE;
}

async function collectViaHttpReplay(
  bootstrapDoc: BootstrapDocument,
  options: SyncOptions,
  context: CollectContext
): Promise<void> {
  const initialRenderers = collectValuesByKey(bootstrapDoc.initialData, 'playlistVideoRenderer');
  const initialRecords = parseRendererBatch(initialRenderers, 'http_replay', 0, context.importedAt);
  await storeBatch(context, {
    page: 0,
    method: 'http_replay',
    surface: LIKES_URL,
    records: initialRecords.map((entry) => entry.record),
    sourceIds: initialRecords.map((entry) => entry.sourceId),
  });

  await persistDebugArtifact(context, 'bootstrap-summary.json', JSON.stringify({
    pageTitle: bootstrapDoc.payload.pageTitle,
    statedVideoCount: bootstrapDoc.payload.statedVideoCount,
    alerts: bootstrapDoc.payload.alerts,
    initialRendererCount: initialRecords.length,
  }, null, 2));
  if (options.debugNetwork) {
    await persistDebugArtifact(context, 'bootstrap.html', bootstrapDoc.html);
  }

  let continuationToken: string | null = bootstrapDoc.payload.continuationToken;
  let stalePages = 0;

  for (let pageNumber = 1; pageNumber <= options.maxPages; pageNumber += 1) {
    if (!continuationToken) {
      noteMethodStop(context, 'http_replay', 'continuation ended');
      return;
    }
    if (elapsedMinutes(context.startedAt) >= options.maxMinutes) {
      noteMethodStop(context, 'http_replay', 'max runtime reached during http replay');
      return;
    }

    const json = await fetchContinuationJson(bootstrapDoc.payload, options.cookieHeader, options.sapisid, continuationToken);
    if (options.debugNetwork) {
      await persistDebugArtifact(context, `http-page-${pageNumber}.json`, JSON.stringify(json, null, 2));
    }
    const renderers = collectValuesByKey(json, 'playlistVideoRenderer');
    const parsed = parseRendererBatch(renderers, 'http_replay', pageNumber, context.importedAt);
    const stored = await storeBatch(context, {
      page: pageNumber,
      method: 'http_replay',
      surface: 'youtubei/v1/browse',
      records: parsed.map((entry) => entry.record),
      sourceIds: parsed.map((entry) => entry.sourceId),
    });
    continuationToken = extractContinuationToken(json);

    if (!options.full) {
      stalePages = stored.inserted === 0 ? stalePages + 1 : 0;
      if (stalePages >= 3) {
        noteMethodStop(context, 'http_replay', 'incremental stop after repeated already-known pages');
        return;
      }
    }

    if ((context.methodStats.get('http_replay')?.storedCount ?? 0) > context.baselineCeiling) {
      noteMethodStop(context, 'http_replay', 'http replay exceeded baseline ceiling');
      return;
    }

    if (options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  noteMethodStop(context, 'http_replay', 'max pages reached during http replay');
}

function parseDomSnapshotRows(rows: any[], importedAt: string): VideoRecord[] {
  const deduped = new Map<string, VideoRecord>();
  for (const row of rows) {
    const url = normalizeUrl(typeof row?.url === 'string' ? row.url : null);
    const videoId = firstString([row?.videoId ?? null, url ? new URL(url).searchParams.get('v') : null]);
    const id = videoId ?? url;
    if (!id) continue;
    const index = typeof row?.index === 'number' ? row.index : null;
    deduped.set(id, {
      id,
      video_id: videoId,
      playlist_item_id: null,
      url: url ?? `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
      title: firstString([row?.title ?? null]) ?? '(untitled)',
      description: null,
      channel_id: null,
      channel_title: firstString([row?.channelTitle ?? null]),
      liked_at: null,
      video_published_at: null,
      duration: firstString([row?.duration ?? null]),
      privacy_status: firstString([row?.privacyStatus ?? null]) ?? 'public',
      position: index,
      categories: null,
      primary_category: null,
      domains: null,
      primary_domain: null,
      classification_reason: null,
      classification_engine: null,
      classification_model: null,
      classified_at: null,
      thumbnails: uniqueStrings([row?.thumbnail ?? null]),
      view_count_text: firstString([row?.viewCountText ?? null]),
      sync_capture_method: 'browser_dom',
      sync_surface: LIKES_URL,
      sync_page: null,
      sync_index: index,
      sync_source_id: null,
      first_seen_at: importedAt,
      last_seen_at: importedAt,
      imported_at: importedAt,
    });
  }
  return Array.from(deduped.values()).sort((a, b) => (a.sync_index ?? Number.MAX_SAFE_INTEGER) - (b.sync_index ?? Number.MAX_SAFE_INTEGER));
}

async function collectViaBrowserFallback(
  options: SyncOptions,
  context: CollectContext
): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: chromeExecutablePath(),
    headless: true,
    args: ['--no-first-run', '--disable-sync', '--disable-background-networking'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ cookie: options.cookieHeader });

  const networkSeen = new Set<string>();
  const inflight = new Set<Promise<void>>();

  page.on('response', (response) => {
    if (!response.url().includes('/youtubei/v1/browse')) return;
    const task = (async () => {
      try {
        const postData = response.request().postData();
        const requestToken = postData ? JSON.parse(postData).continuation ?? response.url() : response.url();
        if (networkSeen.has(requestToken)) return;
        networkSeen.add(requestToken);
        const json = await response.json() as Record<string, any>;
        const renderers = collectValuesByKey(json, 'playlistVideoRenderer');
        const parsed = parseRendererBatch(renderers, 'browser_network', networkSeen.size, context.importedAt);
        await storeBatch(context, {
          page: networkSeen.size,
          method: 'browser_network',
          surface: 'youtubei/v1/browse (browser)',
          records: parsed.map((entry) => entry.record),
          sourceIds: parsed.map((entry) => entry.sourceId),
        });
        if (options.debugNetwork) {
          await persistDebugArtifact(context, `browser-network-${networkSeen.size}.json`, JSON.stringify(json, null, 2));
        }
      } catch {
        // Ignore malformed or duplicate browser responses.
      }
    })();
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  });

  try {
    await page.goto(LIKES_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    let staleIterations = 0;
    let lastMaxIndex = 0;

    for (let iteration = 1; iteration <= Math.max(30, options.maxPages); iteration += 1) {
      if (elapsedMinutes(context.startedAt) >= options.maxMinutes) {
        noteMethodStop(context, 'browser_network', 'max runtime reached during browser fallback');
        noteMethodStop(context, 'browser_dom', 'max runtime reached during browser fallback');
        break;
      }

      const rows = await page.evaluate(() => {
        const linkFrom = (selector: string, root: Element): HTMLAnchorElement | null => root.querySelector(selector);
        const textFrom = (selector: string, root: Element): string | null => {
          const node = root.querySelector(selector);
          return node?.textContent?.trim() || null;
        };
        const all = Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));
        return all.map((root) => {
          const titleLink = linkFrom('a#video-title', root);
          const channelLink = linkFrom('ytd-channel-name a, #channel-name a, a.yt-simple-endpoint.style-scope.yt-formatted-string', root);
          const meta = Array.from(root.querySelectorAll('#metadata-line span, .metadata-snippet-container span'))
            .map((node) => node.textContent?.trim() || '')
            .filter(Boolean)
            .filter((value) => value !== '•');
          const indexText = textFrom('#index', root) ?? textFrom('div#index', root);
          const thumb = root.querySelector('img')?.getAttribute('src') ?? null;
          const videoId = titleLink?.href ? new URL(titleLink.href, location.origin).searchParams.get('v') : null;
          return {
            videoId,
            url: titleLink?.href ?? null,
            title: titleLink?.textContent?.trim() || null,
            channelTitle: channelLink?.textContent?.trim() || null,
            duration: textFrom('ytd-thumbnail-overlay-time-status-renderer span', root),
            viewCountText: meta.find((value) => /views?/i.test(value)) ?? null,
            privacyStatus: null,
            thumbnail: thumb,
            index: indexText ? Number.parseInt(indexText, 10) : null,
          };
        });
      });

      const domRecords = parseDomSnapshotRows(rows, context.importedAt);
      await storeBatch(context, {
        page: iteration,
        method: 'browser_dom',
        surface: 'youtube.com DOM',
        records: domRecords,
      });

      const domMaxIndex = Math.max(0, ...domRecords.map((record) => record.sync_index ?? 0));
      if (domMaxIndex <= lastMaxIndex) {
        staleIterations += 1;
      } else {
        staleIterations = 0;
        lastMaxIndex = domMaxIndex;
      }

      if ((context.methodStats.get('browser_network')?.storedCount ?? 0) > context.baselineCeiling) {
        noteMethodStop(context, 'browser_network', 'browser network capture exceeded baseline ceiling');
        noteMethodStop(context, 'browser_dom', 'browser DOM capture exceeded baseline ceiling');
        break;
      }

      if (staleIterations >= 8) {
        noteMethodStop(context, 'browser_network', 'browser fallback plateaued');
        noteMethodStop(context, 'browser_dom', 'browser fallback plateaued');
        break;
      }

      await page.mouse.wheel({ deltaY: 5000 });
      await sleep(Math.max(500, options.delayMs || 1200));
    }

    await Promise.all(Array.from(inflight));
    if ((context.methodStats.get('browser_network')?.stopReason ?? 'not attempted') === 'not attempted') {
      noteMethodStop(context, 'browser_network', 'no browser continuation responses captured');
    }
    if ((context.methodStats.get('browser_dom')?.stopReason ?? 'not attempted') === 'not attempted') {
      noteMethodStop(context, 'browser_dom', 'browser DOM capture completed');
    }
  } finally {
    await browser.close();
  }
}

export async function runYouTubeSync(options: SyncOptions): Promise<SyncReport> {
  ensureDataDir();
  const importedAt = new Date().toISOString();
  const bootstrapDoc = await fetchBootstrapDocument(options.cookieHeader);
  const baselineCeiling = Math.max(bootstrapDoc.payload.statedVideoCount ?? 0, 4953);
  const debugDir = options.debugNetwork
    ? path.join(syncDebugDirPath(), importedAt.replace(/[:.]/g, '-'))
    : null;
  const context: CollectContext = {
    startedAt: Date.now(),
    baselineCeiling,
    importedAt,
    debugDir,
    debugArtifacts: [],
    methodStats: new Map(),
  };

  try {
    await collectViaHttpReplay(bootstrapDoc, options, context);
    if ((context.methodStats.get('http_replay')?.storedCount ?? 0) <= baselineCeiling && elapsedMinutes(context.startedAt) < options.maxMinutes) {
      await collectViaBrowserFallback(options, context);
    }
    await buildIndex({ force: true });
  } catch (error) {
    noteMethodStop(context, 'http_replay', error instanceof Error ? error.message : 'sync failed');
  }

  const methods = [
    makeMethodReport('http_replay', context.methodStats),
    makeMethodReport('browser_network', context.methodStats),
    makeMethodReport('browser_dom', context.methodStats),
  ].map((method) => ({
    ...method,
    beatBaseline: method.storedCount > baselineCeiling || (method.maxIndex ?? 0) > baselineCeiling,
  }));

  const winner = methods.find((method) => method.beatBaseline) ?? null;
  const totalStored = Math.max(...methods.map((method) => method.storedCount), 0);
  const latestSuccessfulIndex = Math.max(...methods.map((method) => method.maxIndex ?? 0), 0) || null;
  const report: SyncReport = {
    generatedAt: new Date().toISOString(),
    chromeUserDataDir: options.chromeUserDataDir,
    chromeProfileDirectory: options.chromeProfileDirectory,
    pageTitle: bootstrapDoc.payload.pageTitle,
    statedVideoCount: bootstrapDoc.payload.statedVideoCount,
    alertMessages: bootstrapDoc.payload.alerts,
    baselineCeiling,
    proofPassed: Boolean(winner),
    winningMethod: winner?.method ?? null,
    totalStored,
    latestSuccessfulIndex,
    stopReason: winner
      ? `${winner.method} beat the baseline ceiling`
      : 'strict youtube web sync did not beat the current baseline ceiling',
    methods,
    debugArtifacts: context.debugArtifacts,
  };

  saveSyncReport(report);
  return report;
}
