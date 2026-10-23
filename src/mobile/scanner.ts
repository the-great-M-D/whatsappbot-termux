import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';

export type ScanMatch = {
  type: 'IPv4' | 'IPv6';
  value: string;
  ts: number;
  source: string;
  chat: string;
  sender: string;
  path: string;
};

const DATA_DIR =
  process.env.BOT_DATA_DIR ||
  '/storage/1FC3-111D/discord';

/*
 * This file intentionally contains only an array of IP-address strings:
 * ["192.0.2.1", "2001:db8::1"]
 * No message text, URLs, credentials, sender/chat metadata, or timestamps.
 */
const FILE = path.join(DATA_DIR, 'scanner-ips.json');

const MAX_DEPTH = 24;

const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

const IPV6 =
  /(?<![0-9a-fA-F:])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?![0-9a-fA-F:])/g;

function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function validIPv4(value: string): boolean {
  return value.split('.').every(part => {
    const n = Number(part);
    return part.length > 0 && part.length <= 3 && n >= 0 && n <= 255;
  });
}

function addMatches(
  text: string,
  matches: ScanMatch[],
  seen: Set<string>,
  source: string,
  chat: string,
  sender: string,
  matchPath: string,
) {
  for (const value of new Set(text.match(IPV4) || [])) {
    if (!validIPv4(value)) continue;
    const key = `IPv4:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ type: 'IPv4', value, ts: Date.now(), source, chat, sender, path: matchPath });
  }

  for (const value of new Set(text.match(IPV6) || [])) {
    if (isIP(value) !== 6) continue;
    const normalized = value.toLowerCase();
    const key = `IPv6:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ type: 'IPv6', value: normalized, ts: Date.now(), source, chat, sender, path: matchPath });
  }
}

function walk(
  value: unknown,
  matches: ScanMatch[],
  seen: Set<string>,
  source: string,
  chat: string,
  sender: string,
  matchPath = '$',
  depth = 0,
) {
  if (value === null || value === undefined || depth > MAX_DEPTH) return;

  if (typeof value === 'string') {
    addMatches(value, matches, seen, source, chat, sender, matchPath);

    // Some decrypted payloads contain JSON encoded as a string.
    const trimmed = value.trim();
    if (
      depth < MAX_DEPTH &&
      trimmed.length >= 2 &&
      ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']')))
    ) {
      try {
        walk(JSON.parse(trimmed), matches, seen, source, chat, sender, matchPath, depth + 1);
      } catch {
        // Not JSON; the string itself has already been scanned.
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walk(item, matches, seen, source, chat, sender, `${matchPath}[${index}]`, depth + 1),
    );
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, matches, seen, source, chat, sender, `${matchPath}.${key}`, depth + 1);
    }
  }
}

export function scanText(
  text: string,
  source: string,
  chat: string,
  sender: string,
): ScanMatch[] {
  const matches: ScanMatch[] = [];
  const seen = new Set<string>();

  try {
    walk(JSON.parse(text), matches, seen, source, chat, sender);
  } catch {
    walk(text, matches, seen, source, chat, sender, '$');
  }

  return matches;
}

export function scanValueObject(
  value: unknown,
  source: string,
  chat: string,
  sender: string,
): ScanMatch[] {
  const matches: ScanMatch[] = [];
  walk(value, matches, new Set<string>(), source, chat, sender);
  return matches;
}

/*
 * Persist only unique IP strings as a JSON array. Metadata is used in-memory
 * by the notifier but is never written to disk.
 */
export function saveMatches(matches: ScanMatch[]): ScanMatch[] {
  if (!matches.length) return [];

  ensure();

  let stored: string[] = [];
  try {
    if (fs.existsSync(FILE)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (Array.isArray(parsed)) {
        stored = parsed.filter((item): item is string => typeof item === 'string');
      }
    }
  } catch {
    // Do not silently overwrite an unreadable file.
    throw new Error(`Cannot read scanner IP JSON file: ${FILE}`);
  }

  const known = new Set(stored);
  const fresh = matches.filter(match => {
    const value = match.type === 'IPv6' ? match.value.toLowerCase() : match.value;
    if (known.has(value)) return false;
    known.add(value);
    stored.push(value);
    return true;
  });

  if (fresh.length) {
    const tempFile = `${FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tempFile, FILE);
  } else if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, '[]\n', { mode: 0o600 });
  }

  return fresh;
}


export function readMatches(limit = 50): string[] {
  ensure();

  if (!fs.existsSync(FILE)) return [];

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .slice(-Math.min(Math.max(0, limit), 200));
  } catch {
    return [];
  }
}

export function clearMatches(): void {
  ensure();
  const tempFile = `${FILE}.tmp`;
  fs.writeFileSync(tempFile, '[]\n', { mode: 0o600 });
  fs.renameSync(tempFile, FILE);
}

export function scannerFile(): string {
  return FILE;
}
