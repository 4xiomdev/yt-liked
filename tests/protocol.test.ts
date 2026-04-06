import test from 'node:test';
import assert from 'node:assert/strict';

function sampleContinuationResponse() {
  return {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            {
              playlistVideoRenderer: {
                videoId: 'abc123',
                index: { simpleText: '101' },
              },
            },
            {
              playlistVideoRenderer: {
                videoId: 'def456',
                index: { simpleText: '102' },
              },
            },
            {
              continuationItemRenderer: {
                continuationEndpoint: {
                  continuationCommand: {
                    token: 'NEXT_TOKEN',
                  },
                },
              },
            },
          ],
        },
      },
    ],
  };
}

test('sample continuation fixture shape stays aligned with the parser assumptions', () => {
  const json = sampleContinuationResponse();
  const items = json.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems;
  const indexes = items
    .map((item) => item.playlistVideoRenderer?.index?.simpleText ?? null)
    .filter(Boolean);
  const next = items.find((item) => item.continuationItemRenderer)?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;

  assert.deepEqual(indexes, ['101', '102']);
  assert.equal(next, 'NEXT_TOKEN');
});
