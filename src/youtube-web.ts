import { createHash } from 'node:crypto';

const YOUTUBE_ORIGIN = 'https://www.youtube.com';

export function createSapisidAuthHeader(
  sapisid: string,
  dataSyncId: string,
  timestampSec: number,
  origin = YOUTUBE_ORIGIN
): string {
  const hashInput = [dataSyncId, timestampSec, sapisid, origin].join(' ');
  const digest = createHash('sha1').update(hashInput).digest('hex');
  const token = `${timestampSec}_${digest}_u`;
  return `SAPISIDHASH ${token} SAPISID1PHASH ${token} SAPISID3PHASH ${token}`;
}
