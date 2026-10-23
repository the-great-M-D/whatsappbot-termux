import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BOT_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'scanner-ip-test-'),
);

type Scanner = typeof import('./scanner.js');

async function load(): Promise<Scanner> {
  return import('./scanner.js');
}

test('scanner extracts IPs only from plain text and nested JSON', async () => {
  const { scanText } = await load();
  const matches = scanText(
    JSON.stringify({
      payload: JSON.stringify({ host: '192.0.2.10', url: 'https://example.com/path' }),
      nested: { address: '2001:db8::1', username: 'alice', password: 'secret' },
    }),
    'test',
    'chat',
    'sender',
  );

  assert.deepEqual(matches.map(match => match.value).sort(), [
    '192.0.2.10',
    '2001:db8::1',
  ]);
  assert.ok(matches.every(match => match.type === 'IPv4' || match.type === 'IPv6'));
});

test('saveMatches writes only unique IP strings as a JSON array', async () => {
  const { scanText, saveMatches, scannerFile, clearMatches } = await load();
  clearMatches();

  const first = saveMatches(scanText('proxy 10.0.0.9:8080 and 192.0.2.1', 'test', 'chat', 'sender'));
  assert.equal(first.length, 2);

  const second = saveMatches(scanText('again 10.0.0.9 and https://example.org', 'test', 'chat', 'sender'));
  assert.equal(second.length, 0);

  const raw = fs.readFileSync(scannerFile(), 'utf8');
  const stored: unknown = JSON.parse(raw);
  assert.deepEqual(stored, ['10.0.0.9', '192.0.2.1']);
  assert.ok(!raw.includes('example.org'));
  assert.ok(!raw.includes('sender'));
  assert.ok(!raw.includes('chat'));
});
