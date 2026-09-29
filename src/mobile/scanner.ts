import fs from 'node:fs';
import path from 'node:path';

export type RedactedInfo = {
  key: string;
  valueType: string;
  length?: number;
};

export type ScanMatch = {
  type:
    | 'IPv4'
    | 'IPv6'
    | 'URL'
    | 'HOST_PORT'
    | 'SSH_ENDPOINT'
    | 'PROXY_ENDPOINT'
    | 'USERNAME'
    | 'CREDENTIAL_REDACTED';

  value: string;
  ts: number;
  source: string;
  chat: string;
  sender: string;
  /*
   * JSON path where the match was found, e.g.
   * "$.v2rayConfig.outbounds[0].settings.servers[0].address".
   * Empty string for plain (non-JSON) text.
   */
  path: string;
  /*
   * CREDENTIAL_REDACTED only: metadata about what
   * was redacted. Never contains the secret value.
   */
  redacted?: RedactedInfo;
};

const FILE = path.join(
  process.env.BOT_DATA_DIR ||
    '/storage/1FC3-111D/discord',
  'scanner-matches.jsonl',
);

const MAX_DEPTH = 24;

const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

const IPV6 =
  /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}(?![\w:])/g;

const URL =
  /\bhttps?:\/\/[^\s<>"'`]+/gi;

const HOST_PORT =
  /(?<![\w.@-])(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}\b/g;

const SSH_URI =
  /\bssh:\/\/[^\s<>"'`]+/gi;

const PROXY_URI =
  /\b(?:http|https|socks4|socks5):\/\/[^\s<>"'`]+/gi;

const USERNAME =
  /\b(?:username|user|login|sshUser|sshUsername)\s*[:=]\s*["']?([A-Za-z0-9_.@-]{2,64})["']?/gi;

const SECRET_PAIR =
  /\b(?:password|passwd|pass|pwd|secret|token|apiKey|api_key|privateKey|private_key)\s*[:=]\s*["']?[^"',\s}]+["']?/gi;

/*
 * Authorization headers: "Bearer xyz...", "Basic dXNlcjpw...".
 * Basic auth embeds user:pass, so it is always
 * redacted whole.
 */
const AUTH_HEADER =
  /\b(?:authorization\s*[:=]\s*)?(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/*
 * PEM private-key blocks.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/*
 * Key/cert-ish field names whose values may be
 * PEM or base64 blobs. Errs toward redaction.
 */
const KEY_MATERIAL_KEY =
  /key|cert|pem|^ca$/i;

/*
 * Sensitive keys, compared after normalization
 * (lowercase, all non-alphanumerics stripped), so
 * "private_key", "privateKey" and "PRIVATE-KEY" all match.
 */
const SENSITIVE_KEY_EXACT = new Set([
  'password', 'passwd', 'pass', 'pwd', 'secret', 'token', 'apikey',
  'privatekey', 'accesstoken', 'refreshtoken', 'clientsecret',
  'authorization', 'auth', 'authkey', 'credential', 'credentials',
  'session', 'sessionid', 'cookie', 'cookies', 'otp', 'pin',
  'mnemonic', 'seed', 'seedphrase', 'authtoken', 'bearertoken',
  'bottoken', 'wstoken',
]);

const SENSITIVE_KEY_PARTS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey',
  'privatekey', 'credential', 'authorization', 'sessionid',
  'cookie', 'otp', 'mnemonic', 'seedphrase', 'authtoken',
];

function isSensitiveKey(key: string) {
  const k = key
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (!k) {
    return false;
  }

  if (SENSITIVE_KEY_EXACT.has(k)) {
    return true;
  }

  return SENSITIVE_KEY_PARTS.some(p => k.includes(p));
}

/*
 * Heuristic for base64 blobs under key/cert-ish names.
 * Heavily errs toward redaction: a false positive only
 * costs one unscanned field.
 */
function looksLikeEncodedBlob(value: string) {
  const compact = value.replace(/\s+/g, '');

  return (
    compact.length >= 96 &&
    /^[A-Za-z0-9+/=]+$/.test(compact)
  );
}

/*
 * Metadata about a redacted value: type and size only.
 */
function describeValue(value: unknown): RedactedInfo {
  if (value === null) {
    return { key: '', valueType: 'null' };
  }

  if (Array.isArray(value)) {
    return {
      key: '',
      valueType: 'array',
      length: value.length,
    };
  }

  switch (typeof value) {
    case 'string':
      return {
        key: '',
        valueType: 'string',
        length: value.length,
      };
    case 'number':
      return { key: '', valueType: 'number' };
    case 'boolean':
      return { key: '', valueType: 'boolean' };
    case 'object':
      return {
        key: '',
        valueType: 'object',
        length: Object.keys(
          value as Record<string, unknown>,
        ).length,
      };
    default:
      return { key: '', valueType: typeof value };
  }
}

function ensure() {
  fs.mkdirSync(path.dirname(FILE), {
    recursive: true,
  });
}

function cleanPunctuation(value: string) {
  return value.replace(
    /[),.;!?}\]"'`]+$/g,
    '',
  );
}

function cleanUrl(value: string) {
  const cleaned = cleanPunctuation(value);

  try {
    const url = new globalThis.URL(cleaned);

    /*
     * Redact sensitive query parameters
     * (?token=...&key=... -> [REDACTED]).
     */
    for (const name of [...url.searchParams.keys()]) {
      if (isSensitiveKey(name)) {
        url.searchParams.set(name, '[REDACTED]');
      }
    }

    /*
     * Strip credentials from URLs.
     *
     * We retain:
     *   scheme://host:port/path?query
     *
     * but never store:
     *   user:password@
     */
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return cleaned;
  }
}

function validPort(port: string) {
  const n = Number(port);

  return (
    Number.isInteger(n) &&
    n >= 1 &&
    n <= 65535
  );
}

function validIPv4(value: string) {
  return value
    .split('.')
    .every(part => {
      const n = Number(part);

      return (
        part.length > 0 &&
        part.length <= 3 &&
        n >= 0 &&
        n <= 255
      );
    });
}

function unique(values: string[]) {
  return [
    ...new Set(
      values.filter(Boolean),
    ),
  ];
}

function addMatch(
  matches: ScanMatch[],
  seen: Set<string>,
  type: ScanMatch['type'],
  value: string,
  source: string,
  chat: string,
  sender: string,
  matchPath = '',
  redacted?: RedactedInfo,
) {
  /*
   * Redacted labels are structured and must not
   * have their trailing ")" / "]" stripped.
   */
  const cleaned =
    type === 'CREDENTIAL_REDACTED'
      ? String(value).trim()
      : cleanPunctuation(String(value).trim());

  if (!cleaned) {
    return;
  }

  const key =
    `${type}:${cleaned.toLowerCase()}:${matchPath}`;

  if (seen.has(key)) {
    return;
  }

  seen.add(key);

  matches.push({
    type,
    value: cleaned,
    ts: Date.now(),
    source,
    chat,
    sender,
    path: matchPath,
    ...(redacted ? { redacted } : {}),
  });
}

/*
 * Record a redacted field with metadata: key name,
 * JSON path, value type and length. The value
 * itself is never persisted.
 */
function addRedacted(
  matches: ScanMatch[],
  seen: Set<string>,
  key: string,
  matchPath: string,
  value: unknown,
  source: string,
  chat: string,
  sender: string,
) {
  const info = describeValue(value);

  const meta =
    info.length !== undefined
      ? `${info.valueType}, len=${info.length}`
      : info.valueType;

  addMatch(
    matches,
    seen,
    'CREDENTIAL_REDACTED',
    `[${key}: REDACTED (${meta})]`,
    source,
    chat,
    sender,
    matchPath,
    { ...info, key },
  );
}

/*
 * Scan one string. matchPath is the JSON path this
 * string sits at, or '' for top-level text.
 */
function scanString(
  text: string,
  matches: ScanMatch[],
  seen: Set<string>,
  source: string,
  chat: string,
  sender: string,
  matchPath = '',
) {
  if (!text.trim()) {
    return;
  }

  /*
   * IPv4
   */
  for (const value of unique(
    text.match(IPV4) || [],
  )) {
    if (!validIPv4(value)) {
      continue;
    }

    addMatch(
      matches,
      seen,
      'IPv4',
      value,
      source,
      chat,
      sender,
      matchPath,
    );
  }

  /*
   * IPv6
   */
  for (const value of unique(
    text.match(IPV6) || [],
  )) {
    addMatch(
      matches,
      seen,
      'IPv6',
      value,
      source,
      chat,
      sender,
      matchPath,
    );
  }

  /*
   * HTTP/HTTPS URLs.
   */
  for (const raw of unique(
    text.match(URL) || [],
  )) {
    addMatch(
      matches,
      seen,
      'URL',
      cleanUrl(raw),
      source,
      chat,
      sender,
      matchPath,
    );
  }

  /*
   * SSH URI.
   */
  for (const raw of unique(
    text.match(SSH_URI) || [],
  )) {
    addMatch(
      matches,
      seen,
      'SSH_ENDPOINT',
      cleanUrl(raw),
      source,
      chat,
      sender,
      matchPath,
    );
  }

  /*
   * Proxy URI.
   */
  for (const raw of unique(
    text.match(PROXY_URI) || [],
  )) {
    addMatch(
      matches,
      seen,
      'PROXY_ENDPOINT',
      cleanUrl(raw),
      source,
      chat,
      sender,
      matchPath,
    );
  }

  /*
   * Plain host:port.
   */
  for (const raw of unique(
    text.match(HOST_PORT) || [],
  )) {
    const cleaned = cleanPunctuation(raw);

    const port = cleaned.split(':').pop() || '';

    if (!validPort(port)) {
      continue;
    }

    addMatch(
      matches,
      seen,
      'HOST_PORT',
      cleaned,
      source,
      chat,
      sender,
      matchPath,
    );
  }

  /*
   * Username is recorded, but passwords/secrets
   * are deliberately never persisted.
   */
  for (
    const match of text.matchAll(USERNAME)
  ) {
    const username = match[1];

    if (!username) {
      continue;
    }

    addMatch(
      matches,
      seen,
      'USERNAME',
      username,
      source,
      chat,
      sender,
      matchPath,
    );
  }

  /*
   * key=value secret pairs in loose text.
   * Records the key name and the value's length,
   * never the value itself.
   */
  for (
    const match of text.matchAll(SECRET_PAIR)
  ) {
    const raw = match[0];

    const key =
      raw.match(/^([^:=\s]+)/)?.[1] || 'secret';

    const sep = raw.search(/[:=]/);

    const valuePart =
      sep === -1
        ? ''
        : raw
            .slice(sep + 1)
            .replace(/^["']/, '')
            .replace(/["']$/, '')
            .trim();

    addMatch(
      matches,
      seen,
      'CREDENTIAL_REDACTED',
      valuePart
        ? `[${key}: REDACTED (string, len=${valuePart.length})]`
        : `[${key}: REDACTED (empty)]`,
      source,
      chat,
      sender,
      matchPath,
      {
        valueType: 'string',
        ...(valuePart
          ? { length: valuePart.length }
          : {}),
        key,
      },
    );
  }

  /*
   * Authorization headers ("Bearer ...", "Basic ...").
   */
  for (
    const match of text.matchAll(AUTH_HEADER)
  ) {
    const scheme =
      match[0]
        .match(/(bearer|basic)/i)?.[1]
        ?.toLowerCase() || 'auth';

    const material = match[0]
      .replace(
        /^(?:authorization\s*[:=]\s*)?(?:bearer|basic)\s+/i,
        '',
      )
      .trim();

    addMatch(
      matches,
      seen,
      'CREDENTIAL_REDACTED',
      `[authorization: REDACTED (${scheme}, len=${material.length})]`,
      source,
      chat,
      sender,
      matchPath,
      {
        key: 'authorization',
        valueType: scheme,
        length: material.length,
      },
    );
  }

  /*
   * PEM private-key blocks.
   */
  for (const raw of text.match(PRIVATE_KEY_BLOCK) || []) {
    addMatch(
      matches,
      seen,
      'CREDENTIAL_REDACTED',
      `[privateKey: REDACTED (PEM block, len=${raw.length})]`,
      source,
      chat,
      sender,
      matchPath,
      {
        key: 'privateKey',
        valueType: 'pem',
        length: raw.length,
      },
    );
  }
}

/*
 * Some fields (ovpnConfig, v2rayConfig, payload...)
 * arrive as JSON strings *inside* JSON. Parse and
 * walk them too.
 */
function scanEmbeddedJson(
  text: string,
  matches: ScanMatch[],
  seen: Set<string>,
  source: string,
  chat: string,
  sender: string,
  keyPath: string,
  depth: number,
) {
  const trimmed = text.trim();

  if (
    depth >= MAX_DEPTH ||
    trimmed.length < 2 ||
    !(
      trimmed.startsWith('{') ||
      trimmed.startsWith('[')
    ) ||
    !(
      trimmed.endsWith('}') ||
      trimmed.endsWith(']')
    )
  ) {
    return;
  }

  try {
    const nested: unknown = JSON.parse(trimmed);

    if (
      nested !== null &&
      typeof nested === 'object'
    ) {
      scanValue(
        nested,
        matches,
        seen,
        source,
        chat,
        sender,
        keyPath,
        depth + 1,
      );
    }
  } catch {
    /*
     * Not JSON. Expected.
     */
  }
}

/*
 * Recursively walk decrypted HC/HAT JSON:
 *
 *   - strings are scanned, then re-parsed if they
 *     are embedded JSON
 *   - arrays keep their index in the path
 *   - sensitive keys are recorded as redacted and
 *     never descended into
 *   - key/cert-ish fields holding PEM/base64 blobs
 *     are redacted whole
 */
function scanValue(
  value: unknown,
  matches: ScanMatch[],
  seen: Set<string>,
  source: string,
  chat: string,
  sender: string,
  keyPath = '',
  depth = 0,
) {
  if (
    value === null ||
    value === undefined ||
    depth > MAX_DEPTH
  ) {
    return;
  }

  if (typeof value === 'string') {
    scanString(
      value,
      matches,
      seen,
      source,
      chat,
      sender,
      keyPath,
    );

    scanEmbeddedJson(
      value,
      matches,
      seen,
      source,
      chat,
      sender,
      keyPath,
      depth,
    );

    return;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanValue(
        value[i],
        matches,
        seen,
        source,
        chat,
        sender,
        `${keyPath}[${i}]`,
        depth + 1,
      );
    }

    return;
  }

  if (typeof value === 'object') {
    for (
      const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )
    ) {
      const childPath = keyPath
        ? `${keyPath}.${key}`
        : key;

      /*
       * Never descend into sensitive keys.
       * Record key name, path, type and size.
       */
      if (isSensitiveKey(key)) {
        addRedacted(
          matches,
          seen,
          key,
          childPath,
          child,
          source,
          chat,
          sender,
        );

        continue;
      }

      /*
       * Key/cert material under key-ish names:
       * redact whole rather than scan the blob.
       */
      if (
        typeof child === 'string' &&
        KEY_MATERIAL_KEY.test(key) &&
        (child.includes('-----BEGIN') ||
          looksLikeEncodedBlob(child))
      ) {
        addRedacted(
          matches,
          seen,
          key,
          childPath,
          child,
          source,
          chat,
          sender,
        );

        continue;
      }

      scanValue(
        child,
        matches,
        seen,
        source,
        chat,
        sender,
        childPath,
        depth + 1,
      );
    }
  }
}

/*
 * Public scanner entry point.
 *
 * If the message parses as JSON, only the structured
 * walk runs (paths are exact, no duplicate raw-text
 * matches). Otherwise the plain string is scanned.
 */
export function scanText(
  text: string,
  source: string,
  chat: string,
  sender: string,
): ScanMatch[] {
  const matches: ScanMatch[] = [];
  const seen = new Set<string>();

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (parsed !== undefined) {
    scanValue(
      parsed,
      matches,
      seen,
      source,
      chat,
      sender,
      '$',
      0,
    );
  } else {
    scanString(
      text,
      matches,
      seen,
      source,
      chat,
      sender,
    );
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
  const seen = new Set<string>();

  scanValue(
    value,
    matches,
    seen,
    source,
    chat,
    sender,
    '$',
    0,
  );

  return matches;
}

function existingKey(
  match: ScanMatch,
) {
  return `${match.type}:${match.value}:${match.path || ''}`;
}

export function saveMatches(
  matches: ScanMatch[],
): ScanMatch[] {
  if (!matches.length) {
    return [];
  }

  ensure();

  const existing =
    new Set<string>();

  if (fs.existsSync(FILE)) {
    for (
      const line of fs
        .readFileSync(
          FILE,
          'utf8',
        )
        .split('\n')
    ) {
      if (!line.trim()) {
        continue;
      }

      try {
        const item =
          JSON.parse(line);

        if (
          item.type &&
          item.value
        ) {
          existing.add(
            `${item.type}:${item.value}:${item.path || ''}`,
          );
        }
      } catch {}
    }
  }

  const fresh =
    matches.filter(match => {
      const key =
        existingKey(match);

      if (
        existing.has(key)
      ) {
        return false;
      }

      existing.add(key);

      return true;
    });

  if (fresh.length) {
    fs.appendFileSync(
      FILE,
      fresh
        .map(x => JSON.stringify(x))
        .join('\n') + '\n',
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

  return fs
    .readFileSync(
      FILE,
      'utf8',
    )
    .split('\n')
    .filter(Boolean)
    .slice(
      -Math.min(limit, 200),
    );
}

export function clearMatches() {
  ensure();
  fs.writeFileSync(FILE, '');
}

export function scannerFile() {
  return FILE;
}
