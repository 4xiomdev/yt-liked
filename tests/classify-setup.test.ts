import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveClassifySetup } from '../src/classify-setup.js';
import { writeGeminiApiKeyToEnvLocal } from '../src/config.js';

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ytl-setup-home-'));
  process.env.HOME = tempHome;
  delete process.env.GEMINI_API_KEY;
  return fn().finally(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;

    if (originalGeminiKey) process.env.GEMINI_API_KEY = originalGeminiKey;
    else delete process.env.GEMINI_API_KEY;
  });
}

test('resolveClassifySetup uses saved env and default launch settings in non-interactive runs', async () => {
  await withTempHome(async () => {
    writeGeminiApiKeyToEnvLocal('saved-key');
    const setup = await resolveClassifySetup({
      defaultGeminiModel: 'models/gemini-3.1-flash-lite-preview',
      defaultBatchSize: 50,
      defaultConcurrency: 10,
    });

    assert.ok(setup);
    assert.equal(setup?.engine, 'gemini');
    assert.equal(setup?.model, 'models/gemini-3.1-flash-lite-preview');
    assert.equal(setup?.batchSize, 50);
    assert.equal(setup?.concurrency, 10);
    assert.equal(setup?.profileLabel, 'Rocket');
  });
});

test('resolveClassifySetup preserves explicit classify settings', async () => {
  await withTempHome(async () => {
    writeGeminiApiKeyToEnvLocal('saved-key');
    const setup = await resolveClassifySetup({
      model: 'models/custom-preview',
      batchSize: 30,
      concurrency: 4,
      limit: 99,
      defaultGeminiModel: 'models/gemini-3.1-flash-lite-preview',
      defaultBatchSize: 50,
      defaultConcurrency: 10,
    });

    assert.ok(setup);
    assert.equal(setup?.engine, 'gemini');
    assert.equal(setup?.model, 'models/custom-preview');
    assert.equal(setup?.batchSize, 30);
    assert.equal(setup?.concurrency, 4);
    assert.equal(setup?.limit, 99);
    assert.equal(setup?.profileLabel, 'Custom Gemini');
  });
});
