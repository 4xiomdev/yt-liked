import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { dataDir, ensureDataDir } from './paths.js';

let loadedEnvPath: string | null = null;

export function geminiEnvLocalPath(): string {
  return path.join(dataDir(), '.env.local');
}

export function loadEnv(): void {
  const envPath = geminiEnvLocalPath();
  if (loadedEnvPath === envPath) {
    return;
  }

  ensureDataDir();
  dotenv.config({ path: envPath, override: false, quiet: true });
  loadedEnvPath = envPath;
}

export function writeGeminiApiKeyToEnvLocal(apiKey: string): string {
  ensureDataDir();
  const envPath = geminiEnvLocalPath();
  const keyLine = `GEMINI_API_KEY=${apiKey}`;

  let lines: string[] = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
  }

  let updated = false;
  lines = lines.map((line) => {
    if (/^\s*GEMINI_API_KEY=/.test(line)) {
      updated = true;
      return keyLine;
    }
    return line;
  });

  if (!updated) {
    lines.push(keyLine);
  }

  fs.writeFileSync(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  return envPath;
}
