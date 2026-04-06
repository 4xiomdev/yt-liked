import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { geminiEnvLocalPath, loadEnv, writeGeminiApiKeyToEnvLocal } from '../src/config.js';

function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ytl-config-home-'));
  process.env.HOME = tempHome;
  delete process.env.GEMINI_API_KEY;
  return fn(tempHome).finally(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;

    if (originalGeminiKey) process.env.GEMINI_API_KEY = originalGeminiKey;
    else delete process.env.GEMINI_API_KEY;
  });
}

test('writeGeminiApiKeyToEnvLocal writes and updates the ytl env file', async () => {
  await withTempHome(async () => {
    const envPath = writeGeminiApiKeyToEnvLocal('first-key');
    assert.equal(envPath, geminiEnvLocalPath());
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'GEMINI_API_KEY=first-key\n');

    writeGeminiApiKeyToEnvLocal('second-key');
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'GEMINI_API_KEY=second-key\n');
  });
});

test('loadEnv reads GEMINI_API_KEY from ~/.yt-liked/.env.local', async () => {
  await withTempHome(async () => {
    const envPath = writeGeminiApiKeyToEnvLocal('loaded-key');
    assert.equal(envPath, geminiEnvLocalPath());
    loadEnv();
    assert.equal(process.env.GEMINI_API_KEY, 'loaded-key');
  });
});
