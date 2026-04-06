import type { Database } from 'sql.js';
import { openDb, saveDb } from './db.js';
import { readJsonLines, writeJsonLines } from './jsonl.js';
import { videosDbPath, videosJsonlPath } from './paths.js';
import type {
  ChannelCount,
  ClassificationItem,
  LabelCount,
  VideoRecord,
  VideoSearchResult,
  VideoStatusView,
  VideoTimelineFilters,
  VideoVizView,
} from './types.js';
import { readSyncReport } from './report.js';

const VIDEO_SELECT_COLUMNS = `
  id, video_id, playlist_item_id, url, title, description, channel_id, channel_title,
  liked_at, video_published_at, duration, privacy_status, position,
  categories, primary_category, domains, primary_domain,
  classification_reason, classification_engine, classification_model, classified_at,
  thumbnails, view_count_text, sync_capture_method, sync_surface, sync_page, sync_index,
  sync_source_id, first_seen_at, last_seen_at, imported_at
`;

function initSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      video_id TEXT,
      playlist_item_id TEXT,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      channel_id TEXT,
      channel_title TEXT,
      liked_at TEXT,
      video_published_at TEXT,
      duration TEXT,
      privacy_status TEXT,
      position INTEGER,
      categories TEXT,
      primary_category TEXT,
      domains TEXT,
      primary_domain TEXT,
      classification_reason TEXT,
      classification_engine TEXT,
      classification_model TEXT,
      classified_at TEXT,
      thumbnails TEXT,
      view_count_text TEXT,
      sync_capture_method TEXT,
      sync_surface TEXT,
      sync_page INTEGER,
      sync_index INTEGER,
      sync_source_id TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      imported_at TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts
    USING fts5(title, description, channel_title, content='videos', content_rowid='rowid');
  `);
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function insertRecord(db: Database, record: VideoRecord): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO videos (
      id, video_id, playlist_item_id, url, title, description, channel_id, channel_title,
      liked_at, video_published_at, duration, privacy_status, position,
      categories, primary_category, domains, primary_domain,
      classification_reason, classification_engine, classification_model, classified_at,
      thumbnails, view_count_text, sync_capture_method, sync_surface, sync_page, sync_index,
      sync_source_id, first_seen_at, last_seen_at, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run([
    record.id,
    record.video_id,
    record.playlist_item_id,
    record.url,
    record.title,
    record.description,
    record.channel_id,
    record.channel_title,
    record.liked_at,
    record.video_published_at,
    record.duration,
    record.privacy_status,
    record.position,
    record.categories ? JSON.stringify(record.categories) : null,
    record.primary_category,
    record.domains ? JSON.stringify(record.domains) : null,
    record.primary_domain,
    record.classification_reason,
    record.classification_engine,
    record.classification_model,
    record.classified_at,
    record.thumbnails ? JSON.stringify(record.thumbnails) : null,
    record.view_count_text,
    record.sync_capture_method,
    record.sync_surface,
    record.sync_page,
    record.sync_index,
    record.sync_source_id,
    record.first_seen_at,
    record.last_seen_at,
    record.imported_at,
  ]);

  stmt.free();
}

function rowToRecord(row: any[]): VideoRecord {
  return {
    id: row[0] as string,
    video_id: row[1] as string | null,
    playlist_item_id: row[2] as string | null,
    url: row[3] as string,
    title: row[4] as string,
    description: row[5] as string | null,
    channel_id: row[6] as string | null,
    channel_title: row[7] as string | null,
    liked_at: row[8] as string | null,
    video_published_at: row[9] as string | null,
    duration: row[10] as string | null,
    privacy_status: row[11] as string | null,
    position: typeof row[12] === 'number' ? row[12] as number : null,
    categories: row[13] ? JSON.parse(row[13] as string) as string[] : null,
    primary_category: row[14] as string | null,
    domains: row[15] ? JSON.parse(row[15] as string) as string[] : null,
    primary_domain: row[16] as string | null,
    classification_reason: row[17] as string | null,
    classification_engine: row[18] as string | null,
    classification_model: row[19] as string | null,
    classified_at: row[20] as string | null,
    thumbnails: row[21] ? JSON.parse(row[21] as string) as string[] : null,
    view_count_text: row[22] as string | null,
    sync_capture_method: row[23] as VideoRecord['sync_capture_method'],
    sync_surface: row[24] as string | null,
    sync_page: typeof row[25] === 'number' ? row[25] as number : null,
    sync_index: typeof row[26] === 'number' ? row[26] as number : null,
    sync_source_id: row[27] as string | null,
    first_seen_at: row[28] as string | null,
    last_seen_at: row[29] as string | null,
    imported_at: row[30] as string,
  };
}

export async function buildIndex(options?: { force?: boolean }): Promise<{ recordCount: number; newRecords: number }> {
  const db = await openDb(videosDbPath());
  const records = await readJsonLines<VideoRecord>(videosJsonlPath());

  try {
    if (options?.force) {
      db.run('DROP TABLE IF EXISTS videos_fts');
      db.run('DROP TABLE IF EXISTS videos');
    }

    initSchema(db);
    db.run('DELETE FROM videos');

    db.run('BEGIN TRANSACTION');
    for (const record of records) {
      insertRecord(db, record);
    }
    db.run('COMMIT');

    db.run(`INSERT INTO videos_fts(videos_fts) VALUES('rebuild')`);
    saveDb(db, videosDbPath());
    return { recordCount: records.length, newRecords: records.length };
  } finally {
    db.close();
  }
}

export async function exportDbToJsonl(db?: Database): Promise<void> {
  const localDb = db ?? await openDb(videosDbPath());
  const ownsDb = !db;
  try {
    initSchema(localDb);
    const rows = localDb.exec(`
      SELECT
        ${VIDEO_SELECT_COLUMNS}
      FROM videos
      ORDER BY COALESCE(position, 999999999) ASC, title ASC
    `);
    const records = (rows[0]?.values ?? []).map((row) => rowToRecord(row as any[]));
    writeJsonLines(videosJsonlPath(), records);
    if (ownsDb) {
      saveDb(localDb, videosDbPath());
    }
  } finally {
    if (ownsDb) localDb.close();
  }
}

export async function getVideoStatusView(): Promise<VideoStatusView> {
  const db = await openDb(videosDbPath());
  let lastSync = null;
  try {
    initSchema(db);
    const totals = db.exec(`
      SELECT
        COUNT(*) AS imported_count,
        SUM(CASE WHEN primary_category IS NOT NULL THEN 1 ELSE 0 END) AS categorized_count,
        SUM(CASE WHEN primary_domain IS NOT NULL THEN 1 ELSE 0 END) AS domain_count
      FROM videos
    `);
    const lastRunRows = db.exec(`
      SELECT classification_engine, classification_model
      FROM videos
      WHERE classification_engine IS NOT NULL OR classification_model IS NOT NULL
      ORDER BY classified_at DESC
      LIMIT 1
    `);
    const syncRows = db.exec(`
      SELECT sync_capture_method, last_seen_at, sync_index
      FROM videos
      WHERE sync_capture_method IS NOT NULL
      ORDER BY COALESCE(last_seen_at, imported_at) DESC
      LIMIT 1
    `);
    const values = totals[0]?.values?.[0] ?? [0, 0, 0];
    lastSync = readSyncReport();
    const reportPreferredMethod = lastSync?.winningMethod
      ?? lastSync?.methods.reduce((best, method) => {
        if (!best) return method;
        const bestScore = Math.max(best.storedCount, best.maxIndex ?? 0);
        const currentScore = Math.max(method.storedCount, method.maxIndex ?? 0);
        return currentScore > bestScore ? method : best;
      }, null as any)?.method
      ?? null;
    return {
      importedCount: Number(values[0] ?? 0),
      categorizedCount: Number(values[1] ?? 0),
      domainCount: Number(values[2] ?? 0),
      lastClassificationEngine: (lastRunRows[0]?.values?.[0]?.[0] as string | null) ?? null,
      lastClassificationModel: (lastRunRows[0]?.values?.[0]?.[1] as string | null) ?? null,
      lastSyncAt: (syncRows[0]?.values?.[0]?.[1] as string | null) ?? lastSync?.generatedAt ?? null,
      lastSyncMethod: reportPreferredMethod ?? (syncRows[0]?.values?.[0]?.[0] as VideoStatusView['lastSyncMethod']) ?? null,
      lastSyncModelStopReason: lastSync?.stopReason ?? null,
      lastSyncLatestIndex: typeof syncRows[0]?.values?.[0]?.[2] === 'number' ? Number(syncRows[0]?.values?.[0]?.[2]) : lastSync?.latestSuccessfulIndex ?? null,
      syncExceededWall: lastSync?.proofPassed ?? false,
      lastSync,
    };
  } finally {
    db.close();
  }
}

function rowsToLabelCounts(rows: any[][]): LabelCount[] {
  return rows.map((row) => ({
    label: String(row[0] ?? 'unknown'),
    count: Number(row[1] ?? 0),
  }));
}

function rowsToChannelCounts(rows: any[][]): ChannelCount[] {
  return rows.map((row) => ({
    channelTitle: String(row[0] ?? 'Unknown channel'),
    count: Number(row[1] ?? 0),
  }));
}

function rowToSearchResult(row: any[]): VideoSearchResult {
  return {
    id: row[0] as string,
    url: row[1] as string,
    title: row[2] as string,
    description: row[3] as string | null,
    channelTitle: row[4] as string | null,
    likedAt: row[5] as string | null,
    primaryCategory: row[6] as string | null,
    primaryDomain: row[7] as string | null,
    score: Number(row[8] ?? 0),
  };
}

function buildVideoWhereClause(filters: VideoTimelineFilters): {
  where: string;
  params: Array<string | number>;
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filters.query) {
    conditions.push(`v.rowid IN (SELECT rowid FROM videos_fts WHERE videos_fts MATCH ?)`);
    params.push(filters.query);
  }
  if (filters.channel) {
    conditions.push(`v.channel_title = ? COLLATE NOCASE`);
    params.push(filters.channel);
  }
  if (filters.after) {
    conditions.push(`COALESCE(v.liked_at, v.video_published_at, v.imported_at) >= ?`);
    params.push(filters.after);
  }
  if (filters.before) {
    conditions.push(`COALESCE(v.liked_at, v.video_published_at, v.imported_at) <= ?`);
    params.push(filters.before);
  }
  if (filters.category) {
    conditions.push(`v.primary_category = ? COLLATE NOCASE`);
    params.push(filters.category);
  }
  if (filters.domain) {
    conditions.push(`v.primary_domain = ? COLLATE NOCASE`);
    params.push(filters.domain);
  }
  if (filters.privacy) {
    conditions.push(`COALESCE(v.privacy_status, 'unknown') = ? COLLATE NOCASE`);
    params.push(filters.privacy);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function videoSortClause(direction: 'asc' | 'desc' = 'desc'): string {
  const normalized = direction === 'asc' ? 'ASC' : 'DESC';
  return `
    ORDER BY
      COALESCE(v.liked_at, v.video_published_at, v.imported_at) ${normalized},
      v.title ${normalized}
  `;
}

export async function getVideoVizView(): Promise<VideoVizView> {
  const db = await openDb(videosDbPath());
  try {
    initSchema(db);

    const totals = db.exec(`
      SELECT
        COUNT(*) AS imported_count,
        SUM(CASE WHEN primary_category IS NOT NULL THEN 1 ELSE 0 END) AS categorized_count,
        SUM(CASE WHEN primary_domain IS NOT NULL THEN 1 ELSE 0 END) AS domain_count
      FROM videos
    `);

    const categoryRows = db.exec(`
      SELECT primary_category, COUNT(*) AS n
      FROM videos
      WHERE primary_category IS NOT NULL
      GROUP BY primary_category
      ORDER BY n DESC, primary_category ASC
      LIMIT 12
    `);

    const domainRows = db.exec(`
      SELECT primary_domain, COUNT(*) AS n
      FROM videos
      WHERE primary_domain IS NOT NULL
      GROUP BY primary_domain
      ORDER BY n DESC, primary_domain ASC
      LIMIT 12
    `);

    const channelRows = db.exec(`
      SELECT COALESCE(NULLIF(channel_title, ''), 'Unknown channel') AS channel_title, COUNT(*) AS n
      FROM videos
      GROUP BY channel_title
      ORDER BY n DESC, channel_title ASC
      LIMIT 10
    `);

    const monthlyRows = db.exec(`
      SELECT substr(liked_at, 1, 7) AS ym, COUNT(*) AS n
      FROM videos
      WHERE liked_at IS NOT NULL AND liked_at != ''
      GROUP BY ym
      ORDER BY ym ASC
      LIMIT 18
    `);

    const privacyRows = db.exec(`
      SELECT COALESCE(NULLIF(privacy_status, ''), 'unknown') AS privacy_status, COUNT(*) AS n
      FROM videos
      GROUP BY privacy_status
      ORDER BY n DESC, privacy_status ASC
      LIMIT 6
    `);

    const distinctChannelRows = db.exec(`
      SELECT
        COUNT(DISTINCT COALESCE(NULLIF(channel_title, ''), '__missing__')) AS distinct_titles,
        COUNT(DISTINCT COALESCE(NULLIF(channel_id, ''), '__missing__')) AS distinct_ids
      FROM videos
    `);

    const values = totals[0]?.values?.[0] ?? [0, 0, 0];
    const importedCount = Number(values[0] ?? 0);
    const categorizedCount = Number(values[1] ?? 0);
    const domainCount = Number(values[2] ?? 0);
    const distinctValues = distinctChannelRows[0]?.values?.[0] ?? [0, 0];
    const distinctChannelTitles = Number(distinctValues[0] ?? 0);
    const distinctChannelIds = Number(distinctValues[1] ?? 0);
    const channelMetadataLikelyOwnerFallback =
      importedCount > 25 && (distinctChannelTitles <= 1 || distinctChannelIds <= 1);
    const dominantFallbackChannelTitle = String(channelRows[0]?.values?.[0]?.[0] ?? '') || null;
    const dominantFallbackChannelCount = Number(channelRows[0]?.values?.[0]?.[1] ?? 0);

    return {
      importedCount,
      categorizedCount,
      domainCount,
      uncategorizedCount: Math.max(0, importedCount - categorizedCount),
      undomainedCount: Math.max(0, importedCount - domainCount),
      topCategories: rowsToLabelCounts(categoryRows[0]?.values ?? []),
      topDomains: rowsToLabelCounts(domainRows[0]?.values ?? []),
      topChannels: rowsToChannelCounts(channelRows[0]?.values ?? []),
      monthlyLikes: rowsToLabelCounts(monthlyRows[0]?.values ?? []),
      privacyBreakdown: rowsToLabelCounts(privacyRows[0]?.values ?? []),
      distinctChannelTitles,
      distinctChannelIds,
      channelMetadataLikelyOwnerFallback,
      dominantFallbackChannelTitle,
      dominantFallbackChannelCount,
    };
  } finally {
    db.close();
  }
}

export async function searchVideos(filters: VideoTimelineFilters & { query: string; limit?: number }): Promise<VideoSearchResult[]> {
  const db = await openDb(videosDbPath());
  try {
    initSchema(db);
    const limit = filters.limit ?? 20;
    const { where, params } = buildVideoWhereClause(filters);
    const sql = `
      SELECT
        v.id,
        v.url,
        v.title,
        v.description,
        v.channel_title,
        v.liked_at,
        v.primary_category,
        v.primary_domain,
        bm25(videos_fts, 3.5, 1.5, 1.0) AS score
      FROM videos v
      JOIN videos_fts ON videos_fts.rowid = v.rowid
      ${where}
      ORDER BY bm25(videos_fts, 3.5, 1.5, 1.0) ASC,
               COALESCE(v.liked_at, v.video_published_at, v.imported_at) DESC
      LIMIT ?
    `;
    params.push(limit);
    const rows = db.exec(sql, params);
    return (rows[0]?.values ?? []).map((row) => rowToSearchResult(row as any[]));
  } finally {
    db.close();
  }
}

export async function listVideos(filters: VideoTimelineFilters = {}): Promise<VideoRecord[]> {
  const db = await openDb(videosDbPath());
  try {
    initSchema(db);
    const limit = filters.limit ?? 30;
    const offset = filters.offset ?? 0;
    const { where, params } = buildVideoWhereClause(filters);
    const sql = `
      SELECT
        v.id, v.video_id, v.playlist_item_id, v.url, v.title, v.description, v.channel_id, v.channel_title,
        v.liked_at, v.video_published_at, v.duration, v.privacy_status, v.position,
        v.categories, v.primary_category, v.domains, v.primary_domain,
        v.classification_reason, v.classification_engine, v.classification_model, v.classified_at,
        v.thumbnails, v.view_count_text, v.sync_capture_method, v.sync_surface, v.sync_page, v.sync_index,
        v.sync_source_id, v.first_seen_at, v.last_seen_at, v.imported_at
      FROM videos v
      ${where}
      ${videoSortClause(filters.sort)}
      LIMIT ?
      OFFSET ?
    `;
    params.push(limit, offset);
    const rows = db.exec(sql, params);
    return (rows[0]?.values ?? []).map((row) => rowToRecord(row as any[]));
  } finally {
    db.close();
  }
}

export async function getVideoById(id: string): Promise<VideoRecord | null> {
  const db = await openDb(videosDbPath());
  try {
    initSchema(db);
    const rows = db.exec(`
      SELECT
        v.id, v.video_id, v.playlist_item_id, v.url, v.title, v.description, v.channel_id, v.channel_title,
        v.liked_at, v.video_published_at, v.duration, v.privacy_status, v.position,
        v.categories, v.primary_category, v.domains, v.primary_domain,
        v.classification_reason, v.classification_engine, v.classification_model, v.classified_at,
        v.thumbnails, v.view_count_text, v.sync_capture_method, v.sync_surface, v.sync_page, v.sync_index,
        v.sync_source_id, v.first_seen_at, v.last_seen_at, v.imported_at
      FROM videos v
      WHERE v.id = ?
      LIMIT 1
    `, [id]);
    const row = rows[0]?.values?.[0];
    return row ? rowToRecord(row as any[]) : null;
  } finally {
    db.close();
  }
}

export async function getVideoByLookupKey(key: string): Promise<VideoRecord | null> {
  const db = await openDb(videosDbPath());
  try {
    initSchema(db);
    const rows = db.exec(`
      SELECT
        v.id, v.video_id, v.playlist_item_id, v.url, v.title, v.description, v.channel_id, v.channel_title,
        v.liked_at, v.video_published_at, v.duration, v.privacy_status, v.position,
        v.categories, v.primary_category, v.domains, v.primary_domain,
        v.classification_reason, v.classification_engine, v.classification_model, v.classified_at,
        v.thumbnails, v.view_count_text, v.sync_capture_method, v.sync_surface, v.sync_page, v.sync_index,
        v.sync_source_id, v.first_seen_at, v.last_seen_at, v.imported_at
      FROM videos v
      WHERE v.id = ?
         OR COALESCE(v.video_id, '') = ?
         OR v.url = ?
      LIMIT 1
    `, [key, key, key]);
    const row = rows[0]?.values?.[0];
    return row ? rowToRecord(row as any[]) : null;
  } finally {
    db.close();
  }
}

export async function loadClassificationItems(kind: 'categories' | 'domains', options: { all?: boolean; limit?: number } = {}): Promise<ClassificationItem[]> {
  const db = await openDb(videosDbPath());
  try {
    initSchema(db);
    const where = kind === 'categories'
      ? (options.all ? '1=1' : 'primary_category IS NULL')
      : (options.all ? '1=1' : 'primary_domain IS NULL');
    const limitClause = options.limit ? ` LIMIT ${Math.max(1, options.limit)}` : '';
    const rows = db.exec(`
      SELECT id, title, description, channel_title, duration, privacy_status, categories
      FROM videos
      WHERE ${where}
      ORDER BY RANDOM()
      ${limitClause}
    `);
    return (rows[0]?.values ?? []).map((row) => ({
      id: row[0] as string,
      title: row[1] as string,
      description: row[2] as string | null,
      channelTitle: row[3] as string | null,
      duration: row[4] as string | null,
      privacyStatus: row[5] as string | null,
      existingCategories: row[6] ? JSON.parse(row[6] as string) as string[] : null,
    }));
  } finally {
    db.close();
  }
}

export async function applyCategoryUpdates(
  updates: Array<{ id: string; categories: string[]; primary: string; reason: string | null; model?: string; engine: string }>
): Promise<void> {
  const db = await openDb(videosDbPath());
  try {
    initSchema(db);
    const stmt = db.prepare(`
      UPDATE videos
      SET categories = ?, primary_category = ?, classification_reason = ?, classification_engine = ?,
          classification_model = ?, classified_at = ?
      WHERE id = ?
    `);
    const classifiedAt = new Date().toISOString();
    for (const update of updates) {
      stmt.run([
        JSON.stringify(update.categories),
        update.primary,
        update.reason,
        update.engine,
        update.model ?? null,
        classifiedAt,
        update.id,
      ]);
    }
    stmt.free();
    saveDb(db, videosDbPath());
    await exportDbToJsonl(db);
  } finally {
    db.close();
  }
}

export async function applyDomainUpdates(
  updates: Array<{ id: string; domains: string[]; primary: string; reason: string | null; model?: string; engine: string }>
): Promise<void> {
  const db = await openDb(videosDbPath());
  try {
    initSchema(db);
    const stmt = db.prepare(`
      UPDATE videos
      SET domains = ?, primary_domain = ?, classification_reason = COALESCE(?, classification_reason),
          classification_engine = ?, classification_model = ?, classified_at = ?
      WHERE id = ?
    `);
    const classifiedAt = new Date().toISOString();
    for (const update of updates) {
      stmt.run([
        JSON.stringify(update.domains),
        update.primary,
        update.reason,
        update.engine,
        update.model ?? null,
        classifiedAt,
        update.id,
      ]);
    }
    stmt.free();
    saveDb(db, videosDbPath());
    await exportDbToJsonl(db);
  } finally {
    db.close();
  }
}

export async function requireVideoData(): Promise<boolean> {
  const records = await readJsonLines<VideoRecord>(videosJsonlPath());
  return records.length > 0;
}
