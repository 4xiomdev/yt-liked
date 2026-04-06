import fs from 'node:fs';
import { backfillStatePath, ensureDataDir, videosMetaPath } from './paths.js';
import type { SyncReport } from './types.js';

interface MetaFile {
  lastSyncAt: string;
  totalStored: number;
  stopReason: string;
  proofPassed: boolean;
  winningMethod: SyncReport['winningMethod'];
  baselineCeiling: number;
  latestSuccessfulIndex: number | null;
}

export function saveSyncReport(report: SyncReport): void {
  ensureDataDir();
  const meta: MetaFile = {
    lastSyncAt: report.generatedAt,
    totalStored: report.totalStored,
    stopReason: report.stopReason,
    proofPassed: report.proofPassed,
    winningMethod: report.winningMethod,
    baselineCeiling: report.baselineCeiling,
    latestSuccessfulIndex: report.latestSuccessfulIndex,
  };

  fs.writeFileSync(videosMetaPath(), JSON.stringify(meta, null, 2));
  fs.writeFileSync(backfillStatePath(), JSON.stringify(report, null, 2));
}

export function readMeta(): MetaFile | null {
  if (!fs.existsSync(videosMetaPath())) return null;
  return JSON.parse(fs.readFileSync(videosMetaPath(), 'utf8')) as MetaFile;
}

export function readSyncReport(): SyncReport | null {
  if (!fs.existsSync(backfillStatePath())) return null;
  return JSON.parse(fs.readFileSync(backfillStatePath(), 'utf8')) as SyncReport;
}
