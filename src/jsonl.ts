import fs from 'node:fs';
import { ensureDataDir, videosJsonlPath } from './paths.js';
import type { VideoRecord } from './types.js';

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function writeJsonLines<T>(filePath: string, records: T[]): void {
  ensureDataDir();
  const payload = records.map((record) => JSON.stringify(record)).join('\n');
  fs.writeFileSync(filePath, payload.length > 0 ? `${payload}\n` : '');
}

export async function readVideoArchive(): Promise<VideoRecord[]> {
  return readJsonLines<VideoRecord>(videosJsonlPath());
}
