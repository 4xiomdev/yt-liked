import fs from 'node:fs';
import { videosJsonlPath } from './paths.js';
import { readVideoArchive, writeJsonLines } from './jsonl.js';
import { buildIndex } from './videos-db.js';
import type { ImportedVideoInput, VideoRecord } from './types.js';

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
      .filter(Boolean);
    return items.length > 0 ? Array.from(new Set(items)) : null;
  }
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    return parts.length > 0 ? Array.from(new Set(parts)) : null;
  }
  return null;
}

function normalizeUrl(input: ImportedVideoInput): string {
  const explicit = toStringOrNull(input.url);
  if (explicit) return explicit;
  const videoId = toStringOrNull(input.video_id);
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  throw new Error('Could not determine a video URL for one imported item.');
}

export function normalizeImportedVideo(input: ImportedVideoInput, importedAt = new Date().toISOString()): VideoRecord {
  const playlistItemId = toStringOrNull(input.playlist_item_id);
  const videoId = toStringOrNull(input.video_id);
  const url = normalizeUrl(input);
  const id = playlistItemId ?? videoId ?? url;
  const primaryCategory = toStringOrNull(input.primary_category)?.toLowerCase() ?? null;
  let categories = toStringArray(input.categories) ?? toStringArray(input.tags);
  if (!categories && primaryCategory) {
    categories = [primaryCategory];
  }
  const primaryDomain = toStringOrNull(input.primary_domain)?.toLowerCase() ?? null;
  let domains = toStringArray(input.domains);
  if (!domains && primaryDomain) {
    domains = [primaryDomain];
  }

  return {
    id,
    video_id: videoId,
    playlist_item_id: playlistItemId,
    url,
    title: toStringOrNull(input.title) ?? '(untitled)',
    description: toStringOrNull(input.description),
    channel_id: toStringOrNull(input.channel_id),
    channel_title: toStringOrNull(input.channel_title),
    liked_at: toStringOrNull(input.published_at),
    video_published_at: toStringOrNull(input.video_published_at),
    duration: toStringOrNull(input.duration),
    privacy_status: toStringOrNull(input.privacy_status),
    position: typeof input.position === 'number' ? input.position : null,
    categories,
    primary_category: primaryCategory,
    domains,
    primary_domain: primaryDomain,
    classification_reason: toStringOrNull(input.classification_reason),
    classification_engine: toStringOrNull(input.classification_engine),
    classification_model: toStringOrNull(input.classification_model),
    classified_at: toStringOrNull(input.classified_at),
    thumbnails: null,
    view_count_text: null,
    sync_capture_method: null,
    sync_surface: null,
    sync_page: null,
    sync_index: typeof input.position === 'number' ? input.position : null,
    sync_source_id: null,
    first_seen_at: importedAt,
    last_seen_at: importedAt,
    imported_at: importedAt,
  };
}

export function mergeVideoRecords(existing: VideoRecord, incoming: VideoRecord): VideoRecord {
  return {
    ...existing,
    ...incoming,
    url: incoming.url || existing.url,
    title: incoming.title !== '(untitled)' ? incoming.title : existing.title,
    description: incoming.description ?? existing.description,
    channel_id: incoming.channel_id ?? existing.channel_id,
    channel_title: incoming.channel_title ?? existing.channel_title,
    liked_at: incoming.liked_at ?? existing.liked_at,
    video_published_at: incoming.video_published_at ?? existing.video_published_at,
    duration: incoming.duration ?? existing.duration,
    privacy_status: incoming.privacy_status ?? existing.privacy_status,
    position: incoming.position ?? existing.position,
    categories: incoming.categories ?? existing.categories,
    primary_category: incoming.primary_category ?? existing.primary_category,
    domains: incoming.domains ?? existing.domains,
    primary_domain: incoming.primary_domain ?? existing.primary_domain,
    classification_reason: incoming.classification_reason ?? existing.classification_reason,
    classification_engine: incoming.classification_engine ?? existing.classification_engine,
    classification_model: incoming.classification_model ?? existing.classification_model,
    classified_at: incoming.classified_at ?? existing.classified_at,
    thumbnails: incoming.thumbnails ?? existing.thumbnails,
    view_count_text: incoming.view_count_text ?? existing.view_count_text,
    sync_capture_method: incoming.sync_capture_method ?? existing.sync_capture_method,
    sync_surface: incoming.sync_surface ?? existing.sync_surface,
    sync_page: incoming.sync_page ?? existing.sync_page,
    sync_index: incoming.sync_index ?? existing.sync_index,
    sync_source_id: incoming.sync_source_id ?? existing.sync_source_id,
    first_seen_at: existing.first_seen_at ?? incoming.first_seen_at,
    last_seen_at: incoming.last_seen_at ?? existing.last_seen_at,
    imported_at: incoming.imported_at ?? existing.imported_at,
  };
}

export async function mergeArchiveRecords(incoming: VideoRecord[]): Promise<{ inserted: number; total: number }> {
  const existing = await readVideoArchive();
  const merged = new Map<string, VideoRecord>();

  for (const record of existing) {
    merged.set(record.id, record);
  }

  let inserted = 0;
  for (const record of incoming) {
    const prior = merged.get(record.id);
    if (!prior) inserted += 1;
    merged.set(record.id, prior ? mergeVideoRecords(prior, record) : record);
  }

  const records = Array.from(merged.values());
  writeJsonLines(videosJsonlPath(), records);
  return { inserted, total: records.length };
}

export async function importVideoArchive(filePath: string): Promise<{ imported: number; total: number }> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as ImportedVideoInput[];
  if (!Array.isArray(parsed)) {
    throw new Error('Imported file must be a JSON array.');
  }

  const importedAt = new Date().toISOString();
  const incoming = parsed.map((item) => normalizeImportedVideo(item, importedAt));
  const result = await mergeArchiveRecords(incoming);
  await buildIndex({ force: true });
  return { imported: incoming.length, total: result.total };
}
