import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultChromeUserDataDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

export function dataDir(): string {
  return path.join(os.homedir(), '.yt-liked');
}

export function ensureDataDir(): string {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function videosJsonlPath(): string {
  return path.join(dataDir(), 'videos.jsonl');
}

export function videosDbPath(): string {
  return path.join(dataDir(), 'videos.db');
}

export function videosMetaPath(): string {
  return path.join(dataDir(), 'videos-meta.json');
}

export function backfillStatePath(): string {
  return path.join(dataDir(), 'videos-backfill-state.json');
}

export function syncDebugDirPath(): string {
  return path.join(dataDir(), 'sync-debug');
}
