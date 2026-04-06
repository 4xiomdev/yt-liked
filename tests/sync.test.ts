import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRendererBatch } from '../src/youtube-sync.ts';

function sampleRenderer(index: string, videoId: string) {
  return {
    videoId,
    title: {
      runs: [{ text: `Video ${index}` }],
    },
    index: {
      simpleText: index,
    },
    shortBylineText: {
      runs: [
        {
          text: 'Example Channel',
          navigationEndpoint: {
            browseEndpoint: {
              browseId: 'UC123',
            },
          },
        },
      ],
    },
    lengthText: {
      simpleText: '12:34',
    },
    navigationEndpoint: {
      commandMetadata: {
        webCommandMetadata: {
          url: `/watch?v=${videoId}&list=LL&index=${index}`,
        },
      },
      watchEndpoint: {
        videoId,
      },
    },
    thumbnail: {
      thumbnails: [{ url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }],
    },
    videoInfo: {
      runs: [
        { text: '123K views' },
        { text: ' • ' },
        { text: '2 months ago' },
      ],
    },
    isPlayable: true,
  };
}

test('parseRendererBatch normalizes YouTube playlist renderers into synced records', () => {
  const importedAt = '2026-04-06T00:00:00.000Z';
  const records = parseRendererBatch(
    [sampleRenderer('101', 'abc123'), sampleRenderer('102', 'def456')],
    'http_replay',
    3,
    importedAt
  );

  assert.equal(records.length, 2);
  assert.equal(records[0].record.id, 'abc123');
  assert.equal(records[0].record.channel_title, 'Example Channel');
  assert.equal(records[0].record.channel_id, 'UC123');
  assert.equal(records[0].record.sync_capture_method, 'http_replay');
  assert.equal(records[0].record.sync_page, 3);
  assert.equal(records[0].record.sync_index, 101);
  assert.equal(records[0].record.view_count_text, '123K views');
  assert.deepEqual(records[0].record.thumbnails, ['https://i.ytimg.com/vi/abc123/hqdefault.jpg']);
});
