import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importVideoArchive } from '../src/videos-import.js';
import { enrichChannels } from '../src/channel-enrich.js';
import { readVideoArchive } from '../src/jsonl.js';
import { getVideoVizView } from '../src/videos-db.js';

function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ytl-enrich-home-'));
  process.env.HOME = tempHome;
  return fn(tempHome).finally(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });
}

test('enrichChannels repairs collapsed uploader metadata from oEmbed', async () => {
  await withTempHome(async (home) => {
    const archivePath = path.join(home, 'liked_videos.json');
    fs.writeFileSync(archivePath, JSON.stringify([
      {
        playlist_item_id: 'LL-1',
        video_id: 'vid-1',
        title: 'One',
        description: 'First',
        channel_title: 'J',
        channel_id: 'UC-owner-fallback',
        url: 'https://www.youtube.com/watch?v=vid-1',
      },
      {
        playlist_item_id: 'LL-2',
        video_id: 'vid-2',
        title: 'Two',
        description: 'Second',
        channel_title: 'J',
        channel_id: 'UC-owner-fallback',
        url: 'https://www.youtube.com/watch?v=vid-2',
      },
    ], null, 2));

    await importVideoArchive(archivePath);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('vid-1')) {
        return new Response(JSON.stringify({
          author_name: 'Powfu',
          author_url: 'https://www.youtube.com/@Powfu',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        author_name: 'The PrimeTime',
        author_url: 'https://www.youtube.com/@ThePrimeTimeagen',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const result = await enrichChannels({ concurrency: 2 });
      assert.equal(result.attempted, 2);
      assert.equal(result.updated, 2);
      assert.equal(result.failed, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const records = await readVideoArchive();
    assert.equal(records[0]?.channel_title, 'Powfu');
    assert.equal(records[0]?.channel_id, '@Powfu');
    assert.equal(records[1]?.channel_title, 'The PrimeTime');
    assert.equal(records[1]?.channel_id, '@ThePrimeTimeagen');

    const viz = await getVideoVizView();
    assert.equal(viz.channelMetadataLikelyOwnerFallback, false);
    assert.equal(viz.distinctChannelTitles, 2);
  });
});

test('enrichChannels falls back to the watch page when oEmbed is unavailable', async () => {
  await withTempHome(async (home) => {
    const archivePath = path.join(home, 'liked_videos.json');
    fs.writeFileSync(archivePath, JSON.stringify([
      {
        playlist_item_id: 'LL-1',
        video_id: 'vid-1',
        title: 'One',
        description: 'First',
        channel_title: 'J',
        channel_id: 'UC-owner-fallback',
        url: 'https://www.youtube.com/watch?v=vid-1',
      },
    ], null, 2));

    await importVideoArchive(archivePath);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/oembed?')) {
        return new Response('Unauthorized', { status: 401 });
      }
      return new Response(
        '<html>"ownerChannelName":"Lex Fridman","channelId":"UCSHZKyawb77ixDdsGog4iWA","canonicalBaseUrl":"/@lexfridman","ownerProfileUrl":"http://www.youtube.com/@lexfridman"</html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }) as typeof fetch;

    try {
      const result = await enrichChannels({ concurrency: 1 });
      assert.equal(result.updated, 1);
      assert.equal(result.failed, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const records = await readVideoArchive();
    assert.equal(records[0]?.channel_title, 'Lex Fridman');
    assert.equal(records[0]?.channel_id, '@lexfridman');
  });
});
