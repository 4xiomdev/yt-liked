import { buildIndex } from './videos-db.js';
import { readVideoArchive, writeJsonLines } from './jsonl.js';
import { videosJsonlPath } from './paths.js';
import type { ChannelEnrichmentSummary, VideoRecord } from './types.js';

interface OEmbedPayload {
  author_name?: string;
  author_url?: string;
}

interface WatchPageOwnerPayload {
  channelTitle: string | null;
  channelKey: string | null;
}

interface ChannelEnrichmentOptions {
  limit?: number;
  concurrency?: number;
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

interface FallbackSignature {
  title: string | null;
  id: string | null;
}

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function signatureKey(record: VideoRecord): string {
  return `${record.channel_title ?? ''}||${record.channel_id ?? ''}`;
}

function detectDominantFallback(records: VideoRecord[]): FallbackSignature {
  if (records.length === 0) {
    return { title: null, id: null };
  }

  const counts = new Map<string, { count: number; title: string | null; id: string | null }>();
  for (const record of records) {
    const key = signatureKey(record);
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, {
        count: 1,
        title: record.channel_title ?? null,
        id: record.channel_id ?? null,
      });
    }
  }

  const dominant = Array.from(counts.values()).sort((a, b) => b.count - a.count)[0];
  if (!dominant) {
    return { title: null, id: null };
  }

  const title = normalizeString(dominant.title);
  const suspiciousShare = dominant.count / Math.max(records.length, 1);
  const shortTitle = !title || title.length <= 2;

  if (suspiciousShare < 0.4 && !shortTitle) {
    return { title: null, id: null };
  }

  return {
    title,
    id: normalizeString(dominant.id),
  };
}

function parseChannelKey(authorUrl: string | null): string | null {
  if (!authorUrl) return null;
  try {
    const url = new URL(authorUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return authorUrl;
    if (parts[0]?.startsWith('@')) return parts[0];
    if ((parts[0] === 'channel' || parts[0] === 'user' || parts[0] === 'c') && parts[1]) {
      return parts[1];
    }
    return parts.join('/');
  } catch {
    return authorUrl;
  }
}

function shouldEnrich(record: VideoRecord, fallback: FallbackSignature, force: boolean): boolean {
  if (!record.video_id && !record.url) return false;
  if (force) return true;

  const title = normalizeString(record.channel_title);
  const id = normalizeString(record.channel_id);
  if (!title) return true;
  if (title.length <= 2) return true;
  if (fallback.title && title === fallback.title) {
    if (!fallback.id) return true;
    return id === fallback.id;
  }
  return false;
}

async function fetchOEmbed(url: string): Promise<OEmbedPayload> {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const response = await fetch(endpoint, {
    headers: {
      accept: 'application/json',
      'user-agent': 'yt-liked/0.2.0-alpha.0 (+https://github.com/4xiomdev/yt-liked)',
    },
  });

  if (!response.ok) {
    throw new Error(`oEmbed request failed (${response.status})`);
  }

  return await response.json() as OEmbedPayload;
}

function extractWatchPageOwner(html: string): WatchPageOwnerPayload {
  const ownerName = html.match(/"ownerChannelName":"([^"]+)"/)?.[1] ?? null;
  const canonicalBaseUrl = html.match(/"canonicalBaseUrl":"([^"]+)"/)?.[1] ?? null;
  const ownerProfileUrl = html.match(/"ownerProfileUrl":"([^"]+)"/)?.[1] ?? null;
  const channelId = html.match(/"channelId":"([^"]+)"/)?.[1] ?? null;

  const channelTitle = normalizeString(ownerName)
    ?? normalizeString(canonicalBaseUrl?.split('/').filter(Boolean).at(-1)?.replace(/^@/, ''))
    ?? normalizeString(ownerProfileUrl?.split('/').filter(Boolean).at(-1)?.replace(/^@/, ''));

  const channelKey = parseChannelKey(normalizeString(ownerProfileUrl))
    ?? parseChannelKey(normalizeString(canonicalBaseUrl))
    ?? normalizeString(channelId);

  return {
    channelTitle,
    channelKey,
  };
}

async function fetchWatchPageOwner(url: string): Promise<WatchPageOwnerPayload> {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`watch page request failed (${response.status})`);
  }

  const html = await response.text();
  return extractWatchPageOwner(html);
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      await worker(items[index]!, index);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => consume());
  await Promise.all(workers);
}

export async function enrichChannels(options: ChannelEnrichmentOptions = {}): Promise<ChannelEnrichmentSummary> {
  const records = await readVideoArchive();
  const fallback = detectDominantFallback(records);
  const candidates = records
    .filter((record) => shouldEnrich(record, fallback, Boolean(options.force)))
    .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER);

  let completed = 0;
  let updated = 0;
  let failed = 0;
  let skipped = 0;

  await runConcurrent(candidates, options.concurrency ?? 8, async (record) => {
    try {
      let nextTitle: string | null = null;
      let nextId: string | null = null;

      try {
        const payload = await fetchOEmbed(record.url);
        nextTitle = normalizeString(payload.author_name);
        nextId = parseChannelKey(normalizeString(payload.author_url));
      } catch {
        // Some public videos disable or break oEmbed; fall back to the watch page.
      }

      if (!nextTitle) {
        const watchPage = await fetchWatchPageOwner(record.url);
        nextTitle = watchPage.channelTitle;
        nextId = nextId ?? watchPage.channelKey;
      }

      if (!nextTitle) {
        skipped += 1;
      } else {
        let changed = false;
        if (record.channel_title !== nextTitle) {
          record.channel_title = nextTitle;
          changed = true;
        }
        if (nextId && record.channel_id !== nextId) {
          record.channel_id = nextId;
          changed = true;
        }
        if (changed) {
          updated += 1;
        } else {
          skipped += 1;
        }
      }
    } catch {
      failed += 1;
    } finally {
      completed += 1;
      options.onProgress?.(completed, candidates.length);
    }
  });

  if (updated > 0) {
    writeJsonLines(videosJsonlPath(), records);
    await buildIndex({ force: true });
  }

  return {
    attempted: candidates.length,
    updated,
    failed,
    skipped,
    dominantFallbackTitle: fallback.title,
    dominantFallbackId: fallback.id,
  };
}
