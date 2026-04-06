import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, pbkdf2Sync, randomUUID } from 'node:crypto';

interface RawCookie {
  name: string;
  host_key: string;
  value: string;
  encrypted_value_hex: string;
}

export interface ChromeCookieBundle {
  cookies: Map<string, string>;
  cookieHeader: string;
  sapisid: string;
}

function getMacOSChromeKey(): Buffer {
  const candidates = [
    { service: 'Chrome Safe Storage', account: 'Chrome' },
    { service: 'Chrome Safe Storage', account: 'Google Chrome' },
    { service: 'Google Chrome Safe Storage', account: 'Chrome' },
    { service: 'Google Chrome Safe Storage', account: 'Google Chrome' },
  ];

  for (const candidate of candidates) {
    try {
      const password = execFileSync(
        'security',
        ['find-generic-password', '-w', '-s', candidate.service, '-a', candidate.account],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (password) {
        return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
      }
    } catch {
      // Try the next naming pair.
    }
  }

  throw new Error(
    'Could not read Chrome Safe Storage from the macOS Keychain.\n' +
    'Open Google Chrome once, confirm it is installed normally, and try again.'
  );
}

function decryptCookieValue(encryptedValue: Buffer, key: Buffer, dbVersion: number): string {
  if (encryptedValue.length === 0) return '';

  if (encryptedValue[0] === 0x76 && encryptedValue[1] === 0x31 && encryptedValue[2] === 0x30) {
    const iv = Buffer.alloc(16, 0x20);
    const ciphertext = encryptedValue.subarray(3);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    if (dbVersion >= 24 && decrypted.length > 32) {
      decrypted = decrypted.subarray(32);
    }
    return decrypted.toString('utf8');
  }

  return encryptedValue.toString('utf8');
}

function runSqliteQuery(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  }).trim();
}

function withReadableDb<T>(dbPath: string, fn: (path: string) => T): T {
  try {
    return fn(dbPath);
  } catch {
    const tmpDb = join(tmpdir(), `ytl-cookies-${randomUUID()}.db`);
    try {
      copyFileSync(dbPath, tmpDb);
      return fn(tmpDb);
    } finally {
      try {
        unlinkSync(tmpDb);
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
}

function queryDbVersion(dbPath: string): number {
  return withReadableDb(dbPath, (readablePath) => {
    const value = execFileSync('sqlite3', [readablePath, "SELECT value FROM meta WHERE key='version';"], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    return Number.parseInt(value, 10) || 0;
  });
}

function queryYoutubeCookies(dbPath: string): RawCookie[] {
  if (!existsSync(dbPath)) {
    throw new Error(`Chrome Cookies database not found at ${dbPath}`);
  }

  const sql = `
    SELECT
      name,
      host_key,
      value,
      hex(encrypted_value) AS encrypted_value_hex
    FROM cookies
    WHERE host_key LIKE '%youtube.com'
    ORDER BY host_key DESC, name ASC;
  `;

  const raw = withReadableDb(dbPath, (readablePath) => runSqliteQuery(readablePath, sql));
  if (!raw || raw === '[]') return [];
  return JSON.parse(raw) as RawCookie[];
}

function sanitizeCookieValue(name: string, value: string): string {
  const cleaned = value.replace(/\0+$/g, '').trim();
  if (!cleaned) {
    throw new Error(`Cookie ${name} was empty after decryption.`);
  }
  return cleaned;
}

export function extractChromeYoutubeCookies(
  chromeUserDataDir: string,
  profileDirectory = 'Default'
): ChromeCookieBundle {
  const dbPath = join(chromeUserDataDir, profileDirectory, 'Cookies');
  const key = getMacOSChromeKey();
  const dbVersion = queryDbVersion(dbPath);
  const rawCookies = queryYoutubeCookies(dbPath);

  const cookies = new Map<string, string>();
  for (const cookie of rawCookies) {
    const hexValue = cookie.encrypted_value_hex;
    const value = hexValue
      ? decryptCookieValue(Buffer.from(hexValue, 'hex'), key, dbVersion)
      : cookie.value;

    if (!value) continue;
    cookies.set(cookie.name, sanitizeCookieValue(cookie.name, value));
  }

  const sapisid = cookies.get('SAPISID') ?? cookies.get('__Secure-1PAPISID') ?? cookies.get('__Secure-3PAPISID');
  if (!sapisid) {
    throw new Error(
      'No authenticated YouTube SAPISID cookie was found in Chrome.\n' +
      'Open Google Chrome, make sure you are logged into YouTube, and try again.'
    );
  }

  const cookieHeader = Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

  return { cookies, cookieHeader, sapisid };
}
