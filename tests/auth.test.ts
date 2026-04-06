import test from 'node:test';
import assert from 'node:assert/strict';
import { createSapisidAuthHeader } from '../src/youtube-web.js';

test('createSapisidAuthHeader matches the observed browser auth format', () => {
  const header = createSapisidAuthHeader(
    'EvRVsYDoWtxKISMZ/AnnN-Bxtv8vx_8PaS',
    '112529448507163669008',
    1775375535
  );

  assert.equal(
    header,
    'SAPISIDHASH 1775375535_946bb70f35196831028ab5be89512d00ef24c25f_u SAPISID1PHASH 1775375535_946bb70f35196831028ab5be89512d00ef24c25f_u SAPISID3PHASH 1775375535_946bb70f35196831028ab5be89512d00ef24c25f_u'
  );
});
