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

test('scanner detects only IP addresses', async () => {
  const { scanText } = await load();

  const matches = scanText(
    'IP 1.2.3.4 and 2001:db8::1; URL https://example.com:8080 and host:9090',
    'test',
    'chat',
    'sender',
  );

  assert.deepEqual(
    matches.map(match => match.value).sort(),
    ['1.2.3.4', '2001:db8::1'].sort(),
  );
  assert.ok(matches.every(match => match.type === 'IPv4' || match.type === 'IPv6'));
});

test('saveMatches stores a deduplicated JSON array of IP strings only', async () => {
  const { scanText, saveMatches, scannerFile, clearMatches } = await load();

  clearMatches();

  const first = saveMatches(
    scanText('server 10.0.0.9:8080 and 192.0.2.4', 'test', 'chat', 'sender'),
  );
  assert.equal(first.length, 2);

  const second = saveMatches(
    scanText('again 10.0.0.9 and 198.51.100.7', 'another', 'different-chat', 'different-sender'),
  );
  assert.equal(second.length, 1);

  const raw = fs.readFileSync(scannerFile(), 'utf8');
  const data: unknown = JSON.parse(raw);

  assert.deepEqual(data, ['10.0.0.9', '192.0.2.4', '198.51.100.7']);
  assert.ok(Array.isArray(data));
  assert.ok(data.every((item: unknown) => typeof item === 'string'));
  assert.ok(!raw.includes('sender'));
  assert.ok(!raw.includes('different-chat'));
  assert.ok(!raw.includes('https://'));
});

test('readMatches returns IP strings and clearMatches resets the JSON array', async () => {
  const { scanText, saveMatches, readMatches, clearMatches, scannerFile } = await load();

  saveMatches(scanText('1.1.1.1 2001:db8::2', 'test', 'chat', 'sender'));
  assert.deepEqual(readMatches(10), ['1.1.1.1', '2001:db8::2']);

  clearMatches();
  assert.deepEqual(JSON.parse(fs.readFileSync(scannerFile(), 'utf8')), []);
  assert.deepEqual(readMatches(10), []);
});
