import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCategories, classifyDomains, RetryableGeminiError } from '../src/gemini-classify.js';
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

class MockRunner {
  attempts = 0;

  async generateJson(prompt: string): Promise<string> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new RetryableGeminiError('429 rate limited', 'http');
    }
    const ids = Array.from(prompt.matchAll(/id=([^\s|]+)/g)).map((match) => match[1]);
    const isDomains = prompt.includes('subject domain');
    if (isDomains) {
      return JSON.stringify(ids.map((id) => ({
        id,
        domains: ['education'],
        primary: 'education',
        reason: 'Looks educational.',
      })));
    }
    return JSON.stringify(ids.map((id) => ({
      id,
      categories: ['music'],
      primary: 'music',
      reason: 'Looks musical.',
    })));
  }
}

class PartialDomainRunner {
  async generateJson(prompt: string): Promise<string> {
    const ids = Array.from(prompt.matchAll(/id=([^\s|]+)/g)).map((match) => match[1]);
    const isDomains = prompt.includes('subject domain');
    if (!isDomains) {
      return JSON.stringify(ids.map((id) => ({
        id,
        categories: ['music'],
        primary: 'music',
        reason: 'Looks musical.',
      })));
    }

    return JSON.stringify([
      {
        id: ids[0],
        domains: ['education'],
        primary: 'education',
        reason: 'Looks educational.',
      },
      {
        id: ids[1],
        domains: [],
        primary: '',
        reason: 'No idea.',
      },
    ]);
  }
}

test('Gemini classification updates archive and resumes through retries', async () => {
  await withTempHome(async (home) => {
    const archivePath = path.join(home, 'liked_videos.json');
    fs.writeFileSync(archivePath, JSON.stringify([
      {
        playlist_item_id: 'LL-1',
        video_id: 'vid-1',
        title: 'One',
        description: 'First',
        channel_title: 'Channel A',
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

    await importVideoArchive(archivePath);
    const runner = new MockRunner();

    const categoryResult = await classifyCategories({
      engine: 'gemini',
      limit: 2,
      batchSize: 2,
      concurrency: 1,
      model: 'mock-model',
      runner,
    });
    assert.equal(categoryResult.classified, 2);
    assert.equal(categoryResult.engine, 'gemini');

    const domainResult = await classifyDomains({
      engine: 'gemini',
      limit: 2,
      batchSize: 2,
      concurrency: 1,
      model: 'mock-model',
      runner,
    });
    assert.equal(domainResult.classified, 2);
    assert.equal(domainResult.engine, 'gemini');

    const records = await readVideoArchive();
    for (const record of records) {
      assert.deepEqual(record.categories, ['music']);
      assert.equal(record.primary_category, 'music');
      assert.deepEqual(record.domains, ['education']);
      assert.equal(record.primary_domain, 'education');
      assert.equal(record.classification_model, 'mock-model');
      assert.equal(record.classification_engine, 'gemini');
    }

    const status = await getVideoStatusView();
    assert.equal(status.categorizedCount, 2);
    assert.equal(status.domainCount, 2);
    assert.equal(status.lastClassificationEngine, 'gemini');
    assert.equal(status.lastClassificationModel, 'mock-model');
  });
});

test('Domain classification salvages valid rows when one row in the batch is empty', async () => {
  await withTempHome(async (home) => {
    const archivePath = path.join(home, 'liked_videos.json');
    fs.writeFileSync(archivePath, JSON.stringify([
      {
        playlist_item_id: 'LL-1',
        video_id: 'vid-1',
        title: 'One',
        description: 'First',
        channel_title: 'Channel A',
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

    await importVideoArchive(archivePath);
    const runner = new PartialDomainRunner();

    const categoryResult = await classifyCategories({
      engine: 'gemini',
      limit: 2,
      batchSize: 2,
      concurrency: 1,
      model: 'mock-model',
      runner,
    });
    assert.equal(categoryResult.classified, 2);

    const domainResult = await classifyDomains({
      engine: 'gemini',
      limit: 2,
      batchSize: 2,
      concurrency: 1,
      model: 'mock-model',
      runner,
    });
    assert.equal(domainResult.classified, 1);

    const status = await getVideoStatusView();
    assert.equal(status.domainCount, 1);
    assert.equal(status.lastClassificationEngine, 'gemini');

    const records = await readVideoArchive();
    const domainTagged = records.filter((record) => record.primary_domain === 'education');
    const stillPending = records.filter((record) => record.primary_domain == null);
    assert.equal(domainTagged.length, 1);
    assert.deepEqual(domainTagged[0]?.domains, ['education']);
    assert.equal(stillPending.length, 1);
  });
});

test('CLI-backed engines persist the selected engine without a Gemini model', async () => {
  await withTempHome(async (home) => {
    const archivePath = path.join(home, 'liked_videos.json');
    fs.writeFileSync(archivePath, JSON.stringify([
      {
        playlist_item_id: 'LL-1',
        video_id: 'vid-1',
        title: 'One',
        description: 'First',
        channel_title: 'Channel A',
        url: 'https://www.youtube.com/watch?v=vid-1',
      },
    ], null, 2));

    await importVideoArchive(archivePath);
    const runner = new MockRunner();

    const result = await classifyCategories({
      engine: 'claude',
      limit: 1,
      batchSize: 1,
      concurrency: 10,
      runner,
    });

    assert.equal(result.engine, 'claude');
    assert.equal(result.model, undefined);

    const [record] = await readVideoArchive();
    assert.equal(record?.classification_engine, 'claude');
    assert.equal(record?.classification_model, null);

    const status = await getVideoStatusView();
    assert.equal(status.lastClassificationEngine, 'claude');
    assert.equal(status.lastClassificationModel, null);
  });
});
