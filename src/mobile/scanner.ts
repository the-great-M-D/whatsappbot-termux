import fs from 'node:fs';
import path from 'node:path';

export type ScanMatch = {
  type: 'IPv4' | 'IPv6' | 'URL';
  value: string;
  ts: number;
  source: string;
  chat: string;
  sender: string;
};

const FILE = path.join(
  process.env.BOT_DATA_DIR || '/storage/1FC3-111D/discord',
  'scanner-matches.jsonl',
);

const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

const IPV6 =
  /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}(?![\w:])/g;

const URL =
  /\bhttps?:\/\/[^\s<>"'`]+/gi;

function ensure() {
  fs.mkdirSync(path.dirname(FILE), {
    recursive: true,
  });
}

function cleanUrl(value: string) {
  return value.replace(/[),.;!?]+$/g, '');
}

function unique(values: string[]) {
  return [...new Set(values)];
}

export function scanText(
  text: string,
  source: string,
  chat: string,
  sender: string,
): ScanMatch[] {
  const matches: ScanMatch[] = [];
  const seen = new Set<string>();

  for (const value of unique(text.match(IPV4) || [])) {
    const key = `IPv4:${value}`;

    if (seen.has(key)) continue;
    seen.add(key);

    matches.push({
      type: 'IPv4',
      value,
      ts: Date.now(),
      source,
      chat,
      sender,
    });
  }

  for (const value of unique(text.match(IPV6) || [])) {
    const key = `IPv6:${value}`;

    if (seen.has(key)) continue;
    seen.add(key);

    matches.push({
      type: 'IPv6',
      value,
      ts: Date.now(),
      source,
      chat,
      sender,
    });
  }

  for (const raw of unique(text.match(URL) || [])) {
    const value = cleanUrl(raw);
    const key = `URL:${value}`;

    if (seen.has(key)) continue;
    seen.add(key);

    matches.push({
      type: 'URL',
      value,
      ts: Date.now(),
      source,
      chat,
      sender,
    });
  }

  return matches;
}

function existingKey(match: ScanMatch) {
  return `${match.type}:${match.value}`;
}

export function saveMatches(
  matches: ScanMatch[],
): ScanMatch[] {
  if (!matches.length) return [];

  ensure();

  const existing = new Set<string>();

  if (fs.existsSync(FILE)) {
    for (
      const line of fs.readFileSync(FILE, 'utf8').split('\n')
    ) {
      if (!line.trim()) continue;

      try {
        const item = JSON.parse(line);
        if (item.type && item.value) {
          existing.add(
            `${item.type}:${item.value}`,
          );
        }
      } catch {}
    }
  }

  const fresh =
    matches.filter(match => {
      const key = existingKey(match);

      if (existing.has(key)) {
        return false;
      }

      existing.add(key);
      return true;
    });

  if (fresh.length) {
    fs.appendFileSync(
      FILE,
      fresh.map(x => JSON.stringify(x)).join('\n') +
        '\n',
    );
  }

  return fresh;
}

export function readMatches(
  limit = 50,
): string[] {
  ensure();

  if (!fs.existsSync(FILE)) {
    return [];
  }

  return fs.readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-Math.min(limit, 200));
}

export function clearMatches() {
  ensure();
  fs.writeFileSync(FILE, '');
}

export function scannerFile() {
  return FILE;
}
