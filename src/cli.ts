#!/usr/bin/env node
import { Command } from 'commander';
import type { Engine } from './types.js';
import {
  backfillStatePath,
  dataDir,
  defaultChromeUserDataDir,
  ensureDataDir,
  syncDebugDirPath,
  videosDbPath,
  videosJsonlPath,
  videosMetaPath,
} from './paths.js';
import { extractChromeYoutubeCookies } from './chrome-cookies.js';
import { classifyCategories, classifyDomains, GEMINI_DEFAULT_MODEL } from './gemini-classify.js';
import { resolveClassifySetup } from './classify-setup.js';
import { geminiEnvLocalPath, loadEnv } from './config.js';
import { importVideoArchive } from './videos-import.js';
import { getVideoByLookupKey, getVideoStatusView, getVideoVizView, listVideos, requireVideoData, searchVideos } from './videos-db.js';
import { readSyncReport } from './report.js';
import { renderVideoViz } from './videos-viz.js';
import { enrichChannels } from './channel-enrich.js';
import { runYouTubeSync } from './youtube-sync.js';

const R = '\x1b[38;5;196m';
const R2 = '\x1b[38;5;203m';
const W = '\x1b[97m';
const D = '\x1b[2m';
const X = '\x1b[0m';

const LOGO = `
   ${R}┌──────────────────────────────┐${X}
   ${R}│${X}  ${W}Y T${X}  ${R2}L i k e d${X}            ${R}│${X}
   ${R}│${X}  ${D}youtube-native sync CLI${X}  ${R}│${X}
   ${R}└──────────────────────────────┘${X}`;

function stringifyDate(value: string | null | undefined): string {
  return value?.slice(0, 10) ?? '?';
}

function showIntro(): void {
  console.log(`
  Sync your YouTube liked videos from Chrome, then search, classify,
  and inspect them locally with no hosted sync service.
  Your data stays on your machine.
`);
}

function showClassifyPlan(plan: {
  engine: Engine;
  profileLabel: string;
  model?: string;
  batchSize: number;
  concurrency: number;
}): void {
  console.log(`
  Launch plan:
    Engine: ${plan.engine}
    Profile: ${plan.profileLabel}
    Model: ${plan.model ?? 'managed by local CLI'}
    Batch size: ${plan.batchSize}
    Workers: ${plan.concurrency}

  Resume-safe:
    Re-run the same command any time to continue filling missing labels.
`);
}

function safe(fn: (...args: any[]) => Promise<void>): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(`\n  Error: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  };
}

function showPaths(): void {
  ensureDataDir();
  console.log(`
  Data directory:
    ${dataDir()}

  Local files:
    ${videosJsonlPath()}
    ${videosDbPath()}
    ${videosMetaPath()}
    ${backfillStatePath()}
    ${syncDebugDirPath()}
    ${geminiEnvLocalPath()}
`);
}

function renderRecordSummary(record: {
  id: string;
  title: string;
  channel_title: string | null;
  liked_at: string | null;
  primary_category: string | null;
  primary_domain: string | null;
  url: string;
  description: string | null;
}): void {
  const tags = [record.primary_category, record.primary_domain].filter(Boolean).join(' · ');
  const summary = record.description && record.description.length > 140
    ? `${record.description.slice(0, 137)}...`
    : record.description;
  console.log(`${record.id}  ${record.channel_title ?? 'Unknown channel'}  ${stringifyDate(record.liked_at)}${tags ? `  ${tags}` : ''}`);
  console.log(`  ${record.title}`);
  if (summary) console.log(`  ${summary}`);
  console.log(`  ${record.url}`);
  console.log();
}

function formatPct(count: number, total: number): string {
  if (total <= 0) return '0.0%';
  return `${((count / total) * 100).toFixed(1)}%`;
}

function renderCountRows(rows: Array<{ label: string; count: number }>, total: number, indent = '  '): void {
  if (rows.length === 0) {
    console.log(`${indent}none yet`);
    return;
  }

  const labelWidth = Math.max(...rows.map((row) => row.label.length), 4);
  const countWidth = Math.max(...rows.map((row) => row.count.toLocaleString().length), 1);
  for (const row of rows) {
    console.log(
      `${indent}${row.label.padEnd(labelWidth)}  ${row.count.toLocaleString().padStart(countWidth)}  (${formatPct(row.count, total)})`
    );
  }
}

async function requireImportedData(): Promise<boolean> {
  const hasData = await requireVideoData();
  if (!hasData) {
    console.log(`
  No local video archive synced yet.

  Run:
    ytl sync
`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function showStatus(): Promise<void> {
  const view = await getVideoStatusView();
  const report = readSyncReport();
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

  console.log(LOGO);
  showIntro();
  console.log(`
  Synced videos: ${view.importedCount.toLocaleString()}
  Categorized: ${view.categorizedCount.toLocaleString()}
  Domain-tagged: ${view.domainCount.toLocaleString()}
  Last classification engine: ${view.lastClassificationEngine ?? 'never'}
  Last classification model: ${view.lastClassificationModel ?? 'n/a'}
  Last sync method: ${view.lastSyncMethod ?? 'never'}
  Last sync at: ${view.lastSyncAt ?? 'never'}
  Gemini key: ${geminiConfigured ? 'configured' : 'not configured'}
`);

  if (report) {
    console.log(`
  Last sync report: ${report.generatedAt}
  Stored records: ${report.totalStored.toLocaleString()}
  ${report.baselineLabel}: ${report.baselineCeiling.toLocaleString()}
  Latest successful index: ${report.latestSuccessfulIndex ?? 'unknown'}
  Proof passed: ${report.proofPassed ? 'yes' : 'no'}
  Stop reason: ${report.stopReason}
`);

    if (report.statedVideoCount != null) {
      console.log(`  YouTube page header count: ${report.statedVideoCount.toLocaleString()}`);
    }

    if (report.alertMessages?.length) {
      console.log(`  Alerts: ${report.alertMessages.join(' | ')}`);
    }
    if (report.methods.length) {
      console.log('  Methods:');
      for (const method of report.methods) {
        console.log(`    ${method.method}: stored ${method.storedCount.toLocaleString()} · max index ${method.maxIndex ?? 'unknown'} · ${method.stopReason}`);
      }
    }
  }

  console.log(`
  Saved files:
    ${videosJsonlPath()}
    ${videosDbPath()}
    ${videosMetaPath()}
    ${backfillStatePath()}
    ${geminiEnvLocalPath()}
`);
}

async function showViz(): Promise<void> {
  if (!await requireImportedData()) return;

  const view = await getVideoVizView();
  console.log(renderVideoViz(view));
}

async function runSearchCommand(query: string, options: {
  channel?: string;
  category?: string;
  domain?: string;
  limit?: number;
  json?: boolean;
}): Promise<void> {
  if (!await requireImportedData()) return;
  const results = await searchVideos({
    query,
    channel: options.channel,
    category: options.category,
    domain: options.domain,
    limit: options.limit,
  });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log('\n  No matching videos found.\n');
    return;
  }

  for (const result of results) {
    renderRecordSummary({
      id: result.id,
      title: result.title,
      channel_title: result.channelTitle,
      liked_at: result.likedAt,
      primary_category: result.primaryCategory,
      primary_domain: result.primaryDomain,
      url: result.url,
      description: result.description,
    });
  }
}

async function runListCommand(options: {
  query?: string;
  channel?: string;
  category?: string;
  domain?: string;
  privacy?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
  json?: boolean;
}): Promise<void> {
  if (!await requireImportedData()) return;
  const items = await listVideos({
    query: options.query,
    channel: options.channel,
    category: options.category,
    domain: options.domain,
    privacy: options.privacy,
    after: options.after,
    before: options.before,
    limit: options.limit,
    offset: options.offset,
  });

  if (options.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  if (items.length === 0) {
    console.log('\n  No videos matched those filters.\n');
    return;
  }

  for (const item of items) {
    renderRecordSummary(item);
  }
}

async function runShowCommand(id: string, options: { json?: boolean }): Promise<void> {
  if (!await requireImportedData()) return;
  const item = await getVideoByLookupKey(id);
  if (!item) {
    console.log(`\n  Video not found: ${id}\n`);
    console.log('  Tip: ytl show accepts the stored id, a YouTube video id, or the full URL.\n');
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(item, null, 2));
    return;
  }

  console.log(`${item.id} · ${item.channel_title ?? 'Unknown channel'}`);
  console.log(item.url);
  console.log(`title: ${item.title}`);
  if (item.description) console.log(`description: ${item.description}`);
  console.log(`liked_at: ${item.liked_at ?? 'unknown'}`);
  if (item.video_published_at) console.log(`video_published_at: ${item.video_published_at}`);
  if (item.duration) console.log(`duration: ${item.duration}`);
  if (item.privacy_status) console.log(`privacy: ${item.privacy_status}`);
  if (item.categories?.length) console.log(`categories: ${item.categories.join(', ')}`);
  if (item.domains?.length) console.log(`domains: ${item.domains.join(', ')}`);
  if (item.classification_reason) console.log(`reason: ${item.classification_reason}`);
  if (item.classification_engine) {
    console.log(`classified_by: ${item.classification_engine}${item.classification_model ? ` (${item.classification_model})` : ''}`);
  }
}

async function runSyncCommand(options: {
  full?: boolean;
  maxPages: number;
  delayMs: number;
  maxMinutes: number;
  chromeUserDataDir: string;
  chromeProfileDirectory: string;
  debugNetwork: boolean;
}): Promise<void> {
  console.log(LOGO);
  showIntro();
  console.log(`
  Using Chrome profile:
    ${options.chromeProfileDirectory}
`);

  const cookies = extractChromeYoutubeCookies(options.chromeUserDataDir, options.chromeProfileDirectory);
  const report = await runYouTubeSync({
    cookieHeader: cookies.cookieHeader,
    sapisid: cookies.sapisid,
    full: options.full,
    maxPages: options.maxPages,
    delayMs: options.delayMs,
    maxMinutes: options.maxMinutes,
    chromeUserDataDir: options.chromeUserDataDir,
    chromeProfileDirectory: options.chromeProfileDirectory,
    debugNetwork: options.debugNetwork,
  });

  console.log(`
  Sync complete.

  Liked page title: ${report.pageTitle}
  YouTube page header count: ${report.statedVideoCount ?? 'unknown'}
  Stored locally: ${report.totalStored.toLocaleString()}
  ${report.baselineLabel}: ${report.baselineCeiling.toLocaleString()}
  Stop reason: ${report.stopReason}
`);

  if (!report.proofPassed) {
    console.log(`
  Web history plateaued.

  ytl saved the records it could reach from the current YouTube web
  surfaces, but YouTube stopped exposing more history before a full
  backfill. See the saved sync report for the exact stop reasons.
`);
    process.exitCode = 1;
    return;
  }

  console.log(`
  Native sync beat the previous wall.
`);
}

async function runImportCommand(filePath: string): Promise<void> {
  console.log(LOGO);
  showIntro();
  console.log(`
  Importing fallback archive:
    ${filePath}
`);

  const result = await importVideoArchive(filePath);
  console.log(`
  ✓ ${result.imported.toLocaleString()} input videos imported
  ✓ ${result.total.toLocaleString()} total videos in local archive
  ✓ JSONL: ${videosJsonlPath()}
  ✓ SQLite: ${videosDbPath()}
`);

  console.log(`
  Next steps:
        ytl enrich-channels
        ytl classify
        ytl search "something"
        ytl status
`);
}

async function runEnrichChannelsCommand(options: {
  limit?: number;
  concurrency?: number;
  force?: boolean;
}): Promise<void> {
  if (!await requireImportedData()) return;

  console.log(LOGO);
  showIntro();
  console.log(`
  Repairing uploader metadata from YouTube's public oEmbed endpoint.
  This updates suspicious channel fields in place so search, show,
  and viz reflect each video's actual uploader rather than the likes
  playlist owner.
`);

  const started = Date.now();
  process.stderr.write('Enriching channel metadata...\n');
  const result = await enrichChannels({
    limit: options.limit,
    concurrency: options.concurrency ?? 8,
    force: options.force,
    onProgress: (done, total) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const elapsed = Math.round((Date.now() - started) / 1000);
      process.stderr.write(`  Channels: ${done}/${total} (${pct}%) │ ${elapsed}s elapsed\n`);
    },
  });

  console.log(`
Attempted: ${result.attempted.toLocaleString()}
Updated: ${result.updated.toLocaleString()}
Skipped: ${result.skipped.toLocaleString()}
Failed: ${result.failed.toLocaleString()}
${result.dominantFallbackTitle ? `Detected fallback importer signal: ${result.dominantFallbackTitle}${result.dominantFallbackId ? ` (${result.dominantFallbackId})` : ''}\n` : ''}Next:
  ytl viz
  ytl search "your query"
  ytl show <video-id>
`);
}

async function runClassifyCommand(options: {
  engine?: Engine;
  model?: string;
  batchSize?: number;
  concurrency?: number;
  limit?: number;
}): Promise<void> {
  if (!await requireImportedData()) return;

  console.log(LOGO);
  showIntro();
  const setup = await resolveClassifySetup({
    engine: options.engine,
    model: options.model,
    batchSize: options.batchSize,
    concurrency: options.concurrency,
    limit: options.limit,
    defaultGeminiModel: GEMINI_DEFAULT_MODEL,
    defaultBatchSize: 50,
    defaultConcurrency: 10,
  });
  if (!setup) {
    return;
  }
  showClassifyPlan(setup);

  const categoryStart = Date.now();
  process.stderr.write(`Classifying categories with ${setup.engine === 'gemini' ? `Gemini (${setup.model}, batches of ${setup.batchSize})` : `${setup.engine} CLI (batches of ${setup.batchSize})`}...\n`);
  const categories = await classifyCategories({
    engine: setup.engine,
    model: setup.model,
    batchSize: setup.batchSize,
    concurrency: setup.concurrency,
    limit: setup.limit,
    onBatch: (done, total) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const elapsed = Math.round((Date.now() - categoryStart) / 1000);
      process.stderr.write(`  Categories: ${done}/${total} (${pct}%) │ ${elapsed}s elapsed\n`);
    },
  });

  console.log(`
Engine: ${categories.engine}
${categories.model ? `Model: ${categories.model}\n` : ''}Categories: ${categories.classified}/${categories.totalPending} classified
`);

  const domainStart = Date.now();
  process.stderr.write(`Classifying domains with ${setup.engine === 'gemini' ? `Gemini (${setup.model}, batches of ${setup.batchSize})` : `${setup.engine} CLI (batches of ${setup.batchSize})`}...\n`);
  const domains = await classifyDomains({
    engine: setup.engine,
    model: setup.model,
    batchSize: setup.batchSize,
    concurrency: setup.concurrency,
    limit: setup.limit,
    onBatch: (done, total) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const elapsed = Math.round((Date.now() - domainStart) / 1000);
      process.stderr.write(`  Domains: ${done}/${total} (${pct}%) │ ${elapsed}s elapsed\n`);
    },
  });

  console.log(`
Domains: ${domains.classified}/${domains.totalPending} classified
`);
}

async function runClassifyDomainsCommand(options: {
  engine?: Engine;
  model?: string;
  batchSize?: number;
  concurrency?: number;
  limit?: number;
  all?: boolean;
}): Promise<void> {
  if (!await requireImportedData()) return;

  console.log(LOGO);
  showIntro();
  const setup = await resolveClassifySetup({
    engine: options.engine,
    model: options.model,
    batchSize: options.batchSize,
    concurrency: options.concurrency,
    limit: options.limit,
    defaultGeminiModel: GEMINI_DEFAULT_MODEL,
    defaultBatchSize: 50,
    defaultConcurrency: 10,
  });
  if (!setup) {
    return;
  }
  showClassifyPlan(setup);

  const start = Date.now();
  process.stderr.write(`Classifying domains with ${setup.engine === 'gemini' ? `Gemini (${setup.model}, batches of ${setup.batchSize})` : `${setup.engine} CLI (batches of ${setup.batchSize})`}...\n`);
  const result = await classifyDomains({
    engine: setup.engine,
    all: options.all,
    model: setup.model,
    batchSize: setup.batchSize,
    concurrency: setup.concurrency,
    limit: setup.limit,
    onBatch: (done, total) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stderr.write(`  Domains: ${done}/${total} (${pct}%) │ ${elapsed}s elapsed\n`);
    },
  });

  console.log(`
Engine: ${result.engine}
${result.model ? `Model: ${result.model}\n` : ''}Domains: ${result.classified}/${result.totalPending} classified
`);
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name('ytl')
    .description('Sync, search, classify, and inspect your YouTube liked videos locally.')
    .version('0.2.0-alpha.0')
    .showHelpAfterError()
    .action(() => {
      console.log(LOGO);
      showIntro();
      showPaths();
      console.log(`
  Get started:
        ytl sync
        ytl classify
        ytl search "something"
        ytl status
`);
    });

  program
    .command('sync')
    .description('Sync your YouTube liked videos from the logged-in Chrome session.')
    .option('--full', 'Keep crawling instead of stopping after repeated already-known pages.', false)
    .option('--classify', 'Accepted for FT-style compatibility.', false)
    .option('--max-pages <n>', 'Maximum continuation pages to request.', '120')
    .option('--delay-ms <ms>', 'Delay between continuation requests.', '0')
    .option('--max-minutes <n>', 'Maximum runtime in minutes.', '10')
    .option('--chrome-user-data-dir <path>', 'Chrome user data dir.', defaultChromeUserDataDir())
    .option('--chrome-profile-directory <name>', 'Chrome profile directory.', 'Default')
    .option('--debug-network', 'Save raw sync artifacts for protocol debugging.', false)
    .action(safe(async (options) => {
      await runSyncCommand({
        full: Boolean(options.full),
        maxPages: Number.parseInt(options.maxPages, 10),
        delayMs: Number.parseInt(options.delayMs, 10),
        maxMinutes: Number.parseInt(options.maxMinutes, 10),
        chromeUserDataDir: options.chromeUserDataDir,
        chromeProfileDirectory: options.chromeProfileDirectory,
        debugNetwork: Boolean(options.debugNetwork),
      });
    }));

  program
    .command('import')
    .description('Import a YouTube liked-videos JSON archive as a fallback/compatibility path.')
    .argument('<path>', 'Path to a JSON archive like liked_videos.json')
    .action(safe(async (filePath: string) => {
      await runImportCommand(filePath);
    }));

  program
    .command('classify')
    .description('Classify synced local videos by category and domain using Gemini, Claude, or Codex.')
    .option('--engine <engine>', 'Engine: gemini, claude, or codex (omit to choose interactively)')
    .option('--model <name>', 'Gemini model name', GEMINI_DEFAULT_MODEL)
    .option('--batch-size <n>', 'Batch size', (v: string) => Number(v), 50)
    .option('--concurrency <n>', 'Concurrent Gemini batches (Gemini only)', (v: string) => Number(v), 10)
    .option('--limit <n>', 'Only classify the first N pending videos', (v: string) => Number(v))
    .action(safe(async (options) => {
      await runClassifyCommand({
        engine: options.engine ? String(options.engine) as Engine : undefined,
        model: options.model,
        batchSize: Number(options.batchSize) || 50,
        concurrency: Number(options.concurrency) || 10,
        limit: typeof options.limit === 'number' && !Number.isNaN(options.limit) ? options.limit : undefined,
      });
    }));

  program
    .command('enrich-channels')
    .description('Repair uploader channel metadata when playlist-owner fallback data leaked into local records.')
    .option('--limit <n>', 'Only enrich the first N candidate videos', (v: string) => Number(v))
    .option('--concurrency <n>', 'Concurrent oEmbed requests', (v: string) => Number(v), 8)
    .option('--force', 'Re-check all synced videos, not just suspicious ones', false)
    .action(safe(async (options) => {
      await runEnrichChannelsCommand({
        limit: typeof options.limit === 'number' && !Number.isNaN(options.limit) ? options.limit : undefined,
        concurrency: Number(options.concurrency) || 8,
        force: Boolean(options.force),
      });
    }));

  program
    .command('classify-domains')
    .description('Classify synced local videos by subject domain using Gemini, Claude, or Codex.')
    .option('--all', 'Re-classify all videos, not just missing domains')
    .option('--engine <engine>', 'Engine: gemini, claude, or codex (omit to choose interactively)')
    .option('--model <name>', 'Gemini model name', GEMINI_DEFAULT_MODEL)
    .option('--batch-size <n>', 'Batch size', (v: string) => Number(v), 50)
    .option('--concurrency <n>', 'Concurrent Gemini batches (Gemini only)', (v: string) => Number(v), 10)
    .option('--limit <n>', 'Only classify the first N pending videos', (v: string) => Number(v))
    .action(safe(async (options) => {
      await runClassifyDomainsCommand({
        all: Boolean(options.all),
        engine: options.engine ? String(options.engine) as Engine : undefined,
        model: options.model,
        batchSize: Number(options.batchSize) || 50,
        concurrency: Number(options.concurrency) || 10,
        limit: typeof options.limit === 'number' && !Number.isNaN(options.limit) ? options.limit : undefined,
      });
    }));

  program
    .command('path')
    .description('Show local data paths.')
    .action(showPaths);

  program
    .command('status')
    .description('Show synced archive counts, last classification engine/model, and last sync result.')
    .action(safe(async () => {
      await showStatus();
    }));

  program
    .command('viz')
    .description('Show a terminal summary of archive coverage, labels, and top channels.')
    .action(safe(async () => {
      await showViz();
    }));

  program
    .command('stats')
    .description('Show the same summary dashboard as viz.')
    .action(safe(async () => {
      await showViz();
    }));

  program
    .command('search')
    .description('Search your synced local archive using local full-text search.')
    .argument('<query>', 'Search query')
    .option('--channel <name>', 'Filter by channel title')
    .option('--category <slug>', 'Filter by primary category')
    .option('--domain <slug>', 'Filter by primary domain')
    .option('--limit <n>', 'Limit results', (v: string) => Number(v), 20)
    .option('--json', 'JSON output')
    .action(safe(async (query: string, options) => {
      await runSearchCommand(query, {
        channel: options.channel,
        category: options.category,
        domain: options.domain,
        limit: Number(options.limit) || 20,
        json: Boolean(options.json),
      });
    }));

  program
    .command('list')
    .description('List synced local videos with filters.')
    .option('--query <q>', 'Optional full-text query')
    .option('--channel <name>', 'Filter by channel title')
    .option('--category <slug>', 'Filter by primary category')
    .option('--domain <slug>', 'Filter by primary domain')
    .option('--privacy <value>', 'Filter by privacy status')
    .option('--after <date>', 'Filter after YYYY-MM-DD')
    .option('--before <date>', 'Filter before YYYY-MM-DD')
    .option('--limit <n>', 'Limit results', (v: string) => Number(v), 30)
    .option('--offset <n>', 'Offset results', (v: string) => Number(v), 0)
    .option('--json', 'JSON output')
    .action(safe(async (options) => {
      await runListCommand({
        query: options.query,
        channel: options.channel,
        category: options.category,
        domain: options.domain,
        privacy: options.privacy,
        after: options.after,
        before: options.before,
        limit: Number(options.limit) || 30,
        offset: Number(options.offset) || 0,
        json: Boolean(options.json),
      });
    }));

  program
    .command('show')
    .description('Show one synced video in detail.')
    .argument('<id>', 'Stored id, YouTube video id, or full URL')
    .option('--json', 'JSON output')
    .action(safe(async (id: string, options) => {
      await runShowCommand(id, { json: Boolean(options.json) });
    }));

  return program;
}

export async function run(argv = process.argv): Promise<void> {
  loadEnv();
  await buildCli().parseAsync(argv);
}

const isEntrypoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  run(process.argv);
}
