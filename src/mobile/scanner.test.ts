import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The scanner resolves its data directory at module
 * load, so point it at a temp dir before importing.
 */
process.env.BOT_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'scanner-test-'),
);

type Scanner = typeof import('./scanner.js');

async function load(): Promise<Scanner> {
  return import('./scanner.js');
}

test('scanText records JSON paths and redacts secrets', async () => {
  const { scanText } = await load();

  const msg = JSON.stringify({
    payload: JSON.stringify({
      proxy: { host: '1.2.3.4', port: 1080, password: 'hunter2' },
    }),
    v2rayConfig: {
      outbounds: [
        {
          settings: {
            servers: [{ address: '5.6.7.8', password: 'x' }],
          },
        },
      ],
    },
  });

  const matches = scanText(
    msg,
    'test',
    'chat',
    'sender',
  );

  const ipv4 = matches.filter(m => m.type === 'IPv4');
  assert.ok(ipv4.some(m => m.value === '1.2.3.4' && m.path === '$.payload.proxy.host'));
  assert.ok(
    ipv4.some(
      m =>
        m.value === '5.6.7.8' &&
        m.path ===
          '$.v2rayConfig.outbounds[0].settings.servers[0].address',
    ),
  );

  const redacted = matches.filter(
    m => m.type === 'CREDENTIAL_REDACTED',
  );
  assert.ok(redacted.length >= 2);

  for (const match of redacted) {
    const info = match.redacted;
    assert.ok(info, 'redacted metadata present');
    assert.equal(typeof info.fingerprint, 'string');
    assert.equal(info.fingerprint?.length, 16);
  }

  /*
   * The serialized output must never contain the
   * secret values.
   */
  const serialized = JSON.stringify(matches);
  assert.ok(!serialized.includes('hunter2'));
});

test('scanText strips URL credentials and redacts query tokens', async () => {
  const { scanText } = await load();

  const matches = scanText(
    'connect via https://user:pw@evil.com/get?token=abc123 now',
    'test',
    'chat',
    'sender',
  );

  const url = matches.find(m => m.type === 'URL');
  assert.ok(url);
  assert.ok(!url.value.includes('user:pw'));
  assert.ok(url.value.includes('token=REDACTED'));

  /*
   * The URL login part must not surface as a
   * USERNAME match (it would capture the password).
   */
  const usernames = matches.filter(
    m => m.type === 'USERNAME',
  );
  assert.ok(
    !usernames.some(
      u => u.value.includes('pw@') || u.value.includes('user'),
    ),
  );
});

test('saveMatches dedupes and prunes old entries', async () => {
  const { scanText, saveMatches, scannerFile, clearMatches } =
    await load();

  clearMatches();

  const text = 'server 10.0.0.9:8080';
  const first = saveMatches(
    scanText(text, 'test', 'chat', 'sender'),
  );
  assert.ok(first.length > 0);

  const second = saveMatches(
    scanText(text, 'test', 'chat', 'sender'),
  );
  assert.equal(second.length, 0);

  /*
   * Forge an entry older than the 48h retention
   * window; the next save must prune it.
   */
  const lines = fs
    .readFileSync(scannerFile(), 'utf8')
    .trim()
    .split('\n');
  const stale = JSON.parse(lines[0]);
  stale.ts = Date.now() - 49 * 60 * 60 * 1000;
  fs.writeFileSync(
    scannerFile(),
    JSON.stringify(stale) + '\n',
  );

  saveMatches(
    scanText('other 10.0.0.10:9090', 'test', 'chat', 'sender'),
  );

  const after = fs
    .readFileSync(scannerFile(), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as { value: string });

  assert.ok(
    !after.some(m => m.value === '10.0.0.9:8080'),
    'stale match pruned',
  );
  assert.ok(
    after.some(m => m.value === '10.0.0.10:9090'),
    'fresh match kept',
  );
});

test('savePayloadRecord keeps sanitized history forever', async () => {
  const {
    savePayloadRecord,
    readPayloadRecords,
    payloadFile,
  } = await load();

  fs.rmSync(payloadFile(), { force: true });

  savePayloadRecord(
    JSON.stringify({
      proxy: {
        host: 'proxy.example.com',
        port: 1080,
        password: 'topsecret',
      },
    }),
    'HC decrypted',
    'chat@g.us',
    'sender',
  );

  savePayloadRecord(
    'password: hunter2 connect to 1.2.3.4:22',
    'HAT decrypted',
    'chat@g.us',
    'sender',
  );

  const records = readPayloadRecords(10);
  assert.equal(records.length, 2);

  const raw = fs.readFileSync(payloadFile(), 'utf8');
  assert.ok(!raw.includes('topsecret'));
  assert.ok(!raw.includes('hunter2'));
  assert.ok(raw.includes('proxy.example.com'));
  assert.ok(raw.includes('[REDACTED]'));
  assert.ok(raw.includes('1.2.3.4:22'));
});

test('fingerprints are stable across calls', async () => {
  const { scanText } = await load();

  const msg = JSON.stringify({ password: 'samepass' });

  const [a] = scanText(
    msg,
    't1',
    'c',
    's',
  ).filter(m => m.type === 'CREDENTIAL_REDACTED');
  const [b] = scanText(
    msg,
    't2',
    'c',
    's',
  ).filter(m => m.type === 'CREDENTIAL_REDACTED');

  assert.ok(a.redacted?.fingerprint);
  assert.equal(a.redacted?.fingerprint, b.redacted?.fingerprint);

  const [c] = scanText(
    JSON.stringify({ password: 'different' }),
    't3',
    'c',
    's',
  ).filter(m => m.type === 'CREDENTIAL_REDACTED');

  assert.notEqual(
    a.redacted?.fingerprint,
    c.redacted?.fingerprint,
  );
});
