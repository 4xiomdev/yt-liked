import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importVideoArchive } from '../src/videos-import.js';
import { getVideoById, getVideoByLookupKey, listVideos, searchVideos } from '../src/videos-db.js';

function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ytl-query-home-'));
  process.env.HOME = tempHome;
  return fn(tempHome).finally(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });
}

test('search/list/show work against the imported archive', async () => {
  await withTempHome(async (home) => {
    const archivePath = path.join(home, 'liked_videos.json');
    fs.writeFileSync(archivePath, JSON.stringify([
      {
        playlist_item_id: 'LL-1',
        video_id: 'vid-1',
        title: 'Learn SQLite FTS5',
        description: 'Full text search tutorial for local archives.',
        channel_title: 'Channel Alpha',
        url: 'https://www.youtube.com/watch?v=vid-1',
        published_at: '2026-01-10T00:00:00.000Z',
        privacy_status: 'public',
        primary_category: 'tutorial',
        primary_domain: 'software',
      },
      {
        playlist_item_id: 'LL-2',
        video_id: 'vid-2',
        title: 'AI sermon clip',
        description: 'A theology discussion about AI and faith.',
        channel_title: 'Channel Beta',
        url: 'https://www.youtube.com/watch?v=vid-2',
        published_at: '2026-02-10T00:00:00.000Z',
        privacy_status: 'unlisted',
        primary_category: 'sermon',
        primary_domain: 'theology',
      },
    ], null, 2));

    await importVideoArchive(archivePath);

    const searchResults = await searchVideos({ query: 'sqlite', limit: 10 });
    assert.equal(searchResults.length, 1);
    assert.equal(searchResults[0]?.id, 'LL-1');

    const filteredList = await listVideos({ channel: 'Channel Beta', privacy: 'unlisted', limit: 10 });
    assert.equal(filteredList.length, 1);
    assert.equal(filteredList[0]?.id, 'LL-2');

    const item = await getVideoById('LL-1');
    assert.ok(item);
    assert.equal(item?.title, 'Learn SQLite FTS5');
    assert.equal(item?.primary_category, 'tutorial');
    assert.equal(item?.primary_domain, 'software');

    const byVideoId = await getVideoByLookupKey('vid-2');
    assert.equal(byVideoId?.id, 'LL-2');

    const byUrl = await getVideoByLookupKey('https://www.youtube.com/watch?v=vid-1');
    assert.equal(byUrl?.id, 'LL-1');
  });
});
