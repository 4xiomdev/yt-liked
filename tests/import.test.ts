import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importVideoArchive } from '../src/videos-import.js';
import { readVideoArchive } from '../src/jsonl.js';
import { getVideoStatusView } from '../src/videos-db.js';

function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ytl-home-'));
  process.env.HOME = tempHome;
  return fn(tempHome).finally(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });
}

test('importVideoArchive imports and dedupes archive records', async () => {
  await withTempHome(async (home) => {
    const archivePath = path.join(home, 'liked_videos.json');
    fs.writeFileSync(archivePath, JSON.stringify([
      {
        playlist_item_id: 'LL-1',
        video_id: 'vid-1',
        title: 'One',
        description: 'First',
        channel_title: 'Channel A',
        published_at: '2025-01-01T00:00:00Z',
        url: 'https://www.youtube.com/watch?v=vid-1',
      },
      {
        playlist_item_id: 'LL-1',
        video_id: 'vid-1',
        title: 'One updated',
        description: 'First updated',
        channel_title: 'Channel A',
        primary_category: 'music',
        url: 'https://www.youtube.com/watch?v=vid-1',
      },
      {
        playlist_item_id: 'LL-2',
        video_id: 'vid-2',
        title: 'Two',
        description: 'Second',
        channel_title: 'Channel B',
        url: 'https://www.youtube.com/watch?v=vid-2',
      },
    ], null, 2));

    const result = await importVideoArchive(archivePath);
    assert.equal(result.imported, 3);
    assert.equal(result.total, 2);

    const records = await readVideoArchive();
    assert.equal(records.length, 2);
    const first = records.find((record) => record.id === 'LL-1');
    assert.ok(first);
    assert.equal(first.title, 'One updated');
    assert.deepEqual(first.categories, ['music']);

    const status = await getVideoStatusView();
    assert.equal(status.importedCount, 2);
    assert.equal(status.categorizedCount, 1);
  });
});
