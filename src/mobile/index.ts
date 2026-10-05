import fs from 'node:fs';
import path from 'node:path';

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import chalk from 'chalk';

import { config } from './config.js';
import {
  extractMessageText,
  unwrapMessageContent,
} from './message-utils.js';

import { DiscordBridge } from './discord.js';
import { appendError, clearErrors, readErrors, readHistory } from './state.js';
import { configCommand } from './config-command.js';
import {
  enforceMute,
  moderate,
  isAdmin,
} from './moderation.js';
import { dev } from './dev.js';
import {
  box,
  success,
  error,
  warning,
  info,
  kv,
} from './output.js';

import {
  scanText,
  saveMatches,
  savePayloadRecord,
  readMatches,
  clearMatches,
  scannerFile,
} from './scanner.js';

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

const normalizeNumber = (value: string) =>
  value.replace(/[^0-9]/g, '');

const authBackupRoot =
  '/storage/1FC3-111D/whatsapp-auth-backups';

let sock: ReturnType<typeof makeWASocket> | null = null;

let waState:
  | 'starting'
  | 'pairing'
  | 'connected'
  | 'disconnected' = 'starting';

let pairing = false;
let connectInProgress = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

let reconnectAttempt = 0;

/*
 * Messages older than this connection start time are treated as offline
 * backlog and ignored when IGNORE_OFFLINE_MESSAGES=true.
 */
let messageCutoffUnix = 0;
let messageCutoffReady = false;

let lastDisconnectCode: number | null = null;
let lastDisconnectReason = '';

const errorAlertTimes = new Map<string, number>();
const ERROR_ALERT_COOLDOWN = 5 * 60 * 1000;


function ensureDirs() {
  fs.mkdirSync(config.authDir, { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function uptime() {
  const total = Math.floor(process.uptime());

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return `${hours}h ${minutes}m ${seconds}s`;
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}

function jidNumber(jid: string): string {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/[^0-9]/g, '');
}

function isOwner(jid: string) {
  const incoming = jidNumber(jid);

  if (!incoming) {
    console.log(chalk.red(`[OWNER] empty sender JID: ${jid}`));
    return false;
  }

  const owners = config.owners
    .map(owner => jidNumber(owner))
    .filter(Boolean);

  const matched = owners.includes(incoming);

  console.log(
    matched
      ? chalk.green(`[OWNER] authorized ${incoming}`)
      : chalk.red(`[OWNER] denied ${incoming} owners=${owners.join(',')}`)
  );

  return matched;
}

function isCommandAuthorized(M: any) {
  // Commands sent by the bot account itself (fromMe=true) are trusted.
  // This allows commands issued from the bot's own linked-device session.
  if (M?.key?.fromMe === true) {
    console.log(chalk.green('[COMMAND] authorized: bot self'));
    return true;
  }

  return isOwner(
    M?.key?.participant ||
      M?.key?.remoteJid ||
      '',
  );
}

async function ownerAlert(text: string) {
  if (!sock || waState !== 'connected') {
    return;
  }

  if (!config.owners.length) {
    return;
  }

  try {
    for (const owner of config.owners) {
      await sock.sendMessage(owner, { text });
    }
  } catch (error) {
    console.error(
      chalk.gray('[OWNER ALERT] skipped:'),
      errorText(error),
    );
  }
}

async function reportError(
  category: string,
  error: unknown,
) {
  const message = errorText(error);

  appendError(category, error);

  console.error(
    chalk.red(`[ERROR:${category}]`),
    message,
  );

  const now = Date.now();
  const previous = errorAlertTimes.get(category) || 0;

  if (
    now - previous <
    ERROR_ALERT_COOLDOWN
  ) {
    return;
  }

  errorAlertTimes.set(category, now);

  await ownerAlert(
    [
      'Bot error',
      `Category: ${category}`,
      `Time: ${new Date(now).toISOString()}`,
      `Uptime: ${uptime()}`,
      '',
      message.slice(0, 2500),
    ].join('\n'),
  );
}

function archiveAuth() {
  if (!fs.existsSync(config.authDir)) {
    return null;
  }

  const files = fs.readdirSync(config.authDir);

  if (!files.length) {
    return null;
  }

  fs.mkdirSync(authBackupRoot, {
    recursive: true,
  });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  const destination = path.join(
    authBackupRoot,
    stamp,
  );

  fs.renameSync(
    config.authDir,
    destination,
  );

  fs.mkdirSync(config.authDir, {
    recursive: true,
  });

  return destination;
}

function scheduleReconnect(reason: string) {
  if (reconnectTimer) {
    return;
  }

  if (waState === 'connected') {
    return;
  }

  reconnectAttempt++;

  const delay = Math.min(
    30_000,
    2_000 *
      Math.pow(2, reconnectAttempt - 1),
  );

  console.log(
    chalk.yellow(
      `[WA] Reconnecting in ${Math.round(delay / 1000)}s ` +
      `(attempt ${reconnectAttempt}) — ${reason}`,
    ),
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    void connect().catch(error => {
      void reportError(
        'reconnect',
        error,
      );
    });
  }, delay);
}


async function requestPairingCode(
  state: Awaited<
    ReturnType<typeof useMultiFileAuthState>
  >,
) {
  if (pairing) {
    return;
  }

  if (state.state.creds.registered) {
    return;
  }

  const phone =
    normalizeNumber(config.phone);

  if (!phone) {
    console.log(
      chalk.yellow(
        '[WA] WA_PHONE_NUMBER is not configured.',
      ),
    );

    return;
  }

  if (!sock) {
    return;
  }

  pairing = true;
  waState = 'pairing';

  try {
    console.log(
      chalk.cyan(
        `[WA] Requesting pairing code for +${phone}...`,
      ),
    );

    await sleep(1500);

    /*
     * QR is permanently disabled.
     */
    const code =
      await sock.requestPairingCode(phone);

    console.log('');
    console.log(
      chalk.green(
        '========================================',
      ),
    );
    console.log(
      chalk.green(
        `[WA] PAIRING CODE: ${code}`,
      ),
    );
    console.log(
      chalk.green(
        '========================================',
      ),
    );
    console.log(
      'WhatsApp → Settings → Linked devices',
    );
    console.log(
      '→ Link a device → Link with phone number',
    );
    console.log('');
  } catch (error) {
    pairing = false;

    await reportError(
      'pairing',
      error,
    );

    /*
     * Do not delete auth and do not
     * pretend this was a logout.
     */
    scheduleReconnect(
      'pairing request failed',
    );
  }
}


import {
  extractMessageText,
  unwrapMessageContent,
} from './message-utils.js';

import { DiscordBridge } from './discord.js';
import { appendError, clearErrors, readErrors, readHistory } from './state.js';
import { configCommand } from './config-command.js';
import {
  enforceMute,
  moderate,
  isAdmin,
} from './moderation.js';
import { dev } from './dev.js';
import {
  box,
  success,
  error,
  warning,
  info,
  kv,
} from './output.js';

import {
  scanText,
  saveMatches,
  savePayloadRecord,
  readMatches,
  clearMatches,
  scannerFile,
} from './scanner.js';

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

const normalizeNumber = (value: string) =>
  value.replace(/[^0-9]/g, '');

const authBackupRoot =
  '/storage/1FC3-111D/whatsapp-auth-backups';

let sock: ReturnType<typeof makeWASocket> | null = null;

let waState:
  | 'starting'
  | 'pairing'
  | 'connected'
  | 'disconnected' = 'starting';

let pairing = false;
let connectInProgress = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

let reconnectAttempt = 0;

/*
 * Messages older than this connection start time are treated as offline
 * backlog and ignored when IGNORE_OFFLINE_MESSAGES=true.
 */
let messageCutoffUnix = 0;
let messageCutoffReady = false;

let lastDisconnectCode: number | null = null;
let lastDisconnectReason = '';

const errorAlertTimes = new Map<string, number>();
const ERROR_ALERT_COOLDOWN = 5 * 60 * 1000;


function ensureDirs() {
  fs.mkdirSync(config.authDir, { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function uptime() {
  const total = Math.floor(process.uptime());

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return `${hours}h ${minutes}m ${seconds}s`;
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}

function jidNumber(jid: string): string {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/[^0-9]/g, '');
}

function isOwner(jid: string) {
  const incoming = jidNumber(jid);

  if (!incoming) {
    console.log(chalk.red(`[OWNER] empty sender JID: ${jid}`));
    return false;
  }

  const owners = config.owners
    .map(owner => jidNumber(owner))
    .filter(Boolean);

  const matched = owners.includes(incoming);

  console.log(
    matched
      ? chalk.green(`[OWNER] authorized ${incoming}`)
      : chalk.red(`[OWNER] denied ${incoming} owners=${owners.join(',')}`)
  );

  return matched;
}

function isCommandAuthorized(M: any) {
  // Commands sent by the bot account itself (fromMe=true) are trusted.
  // This allows commands issued from the bot's own linked-device session.
  if (M?.key?.fromMe === true) {
    console.log(chalk.green('[COMMAND] authorized: bot self'));
    return true;
  }

  return isOwner(
    M?.key?.participant ||
      M?.key?.remoteJid ||
      '',
  );
}

async function ownerAlert(text: string) {
  if (!sock || waState !== 'connected') {
    return;
  }

  if (!config.owners.length) {
    return;
  }

  try {
    for (const owner of config.owners) {
      await sock.sendMessage(owner, { text });
    }
  } catch (error) {
    console.error(
      chalk.gray('[OWNER ALERT] skipped:'),
      errorText(error),
    );
  }
}

async function reportError(
  category: string,
  error: unknown,
) {
  const message = errorText(error);

  appendError(category, error);

  console.error(
    chalk.red(`[ERROR:${category}]`),
    message,
  );

  const now = Date.now();
  const previous = errorAlertTimes.get(category) || 0;

  if (
    now - previous <
    ERROR_ALERT_COOLDOWN
  ) {
    return;
  }

  errorAlertTimes.set(category, now);

  await ownerAlert(
    [
      'Bot error',
      `Category: ${category}`,
      `Time: ${new Date(now).toISOString()}`,
      `Uptime: ${uptime()}`,
      '',
      message.slice(0, 2500),
    ].join('\n'),
  );
}

function archiveAuth() {
  if (!fs.existsSync(config.authDir)) {
    return null;
  }

  const files = fs.readdirSync(config.authDir);

  if (!files.length) {
    return null;
  }

  fs.mkdirSync(authBackupRoot, {
    recursive: true,
  });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  const destination = path.join(
    authBackupRoot,
    stamp,
  );

  fs.renameSync(
    config.authDir,
    destination,
  );

  fs.mkdirSync(config.authDir, {
    recursive: true,
  });

  return destination;
}

function scheduleReconnect(reason: string) {
  if (reconnectTimer) {
    return;
  }

  if (waState === 'connected') {
    return;
  }

  reconnectAttempt++;

  const delay = Math.min(
    30_000,
    2_000 *
      Math.pow(2, reconnectAttempt - 1),
  );

  console.log(
    chalk.yellow(
      `[WA] Reconnecting in ${Math.round(delay / 1000)}s ` +
      `(attempt ${reconnectAttempt}) — ${reason}`,
    ),
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    void connect().catch(error => {
      void reportError(
        'reconnect',
        error,
      );
    });
  }, delay);
}


async function requestPairingCode(
  state: Awaited<
    ReturnType<typeof useMultiFileAuthState>
  >,
) {
  if (pairing) {
    return;
  }

  if (state.state.creds.registered) {
    return;
  }

  const phone =
    normalizeNumber(config.phone);

  if (!phone) {
    console.log(
      chalk.yellow(
        '[WA] WA_PHONE_NUMBER is not configured.',
      ),
    );

    return;
  }

  if (!sock) {
    return;
  }

  pairing = true;
  waState = 'pairing';

  try {
    console.log(
      chalk.cyan(
        `[WA] Requesting pairing code for +${phone}...`,
      ),
    );

    await sleep(1500);

    /*
     * QR is permanently disabled.
     */
    const code =
      await sock.requestPairingCode(phone);

    console.log('');
    console.log(
      chalk.green(
        '========================================',
      ),
    );
    console.log(
      chalk.green(
        `[WA] PAIRING CODE: ${code}`,
      ),
    );
    console.log(
      chalk.green(
        '========================================',
      ),
    );
    console.log(
      'WhatsApp → Settings → Linked devices',
    );
    console.log(
      '→ Link a device → Link with phone number',
    );
    console.log('');
  } catch (error) {
    pairing = false;

    await reportError(
      'pairing',
      error,
    );

    /*
     * Do not delete auth and do not
     * pretend this was a logout.
     */
    scheduleReconnect(
      'pairing request failed',
    );
  }
}


async function decrypt.runHatDecrypt(
  inputFile: string,
  outputFile: string,
): Promise<{ ok: boolean; output: string }> {
  return await new Promise(resolve => {
    const script = path.resolve(
      process.cwd(),
      'scripts',
      'hat_tool.py',
    );

    const child = spawn(
      'python',
      [
        script,
        'decrypt',
        inputFile,
        outputFile,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('error', error => {
      resolve({
        ok: false,
        output: errorText(error),
      });
    });

    child.on('close', code => {
      if (code !== 0) {
        resolve({
          ok: false,
          output:
            stderr.trim() ||
            stdout.trim() ||
            `decrypt exited with code ${code}`,
        });
        return;
      }

      try {
        const plaintext =
          fs.readFileSync(
            outputFile,
            'utf8',
          );

        resolve({
          ok: true,
          output: plaintext,
        });
      } catch (error) {
        resolve({
          ok: false,
          output: errorText(error),
        });
      }
    });
  });
}

async function decrypt.runHcDecrypt(inputFile: string, outputFile: string): Promise<{ ok: boolean; output: string }> {
  return await new Promise(resolve => {
    const script = path.resolve(process.cwd(), 'scripts', 'hc_tool.py');
    const child = spawn('python', [script, 'decrypt', inputFile, outputFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => resolve({ ok: false, output: errorText(error) }));
    child.on('close', code => {
      if (code !== 0) {
        resolve({ ok: false, output: stderr.trim() || stdout.trim() || `HC decrypt exited with code ${code}` });
        return;
      }
      try {
        resolve({ ok: true, output: fs.readFileSync(outputFile, 'utf8') });
      } catch (error) {
        resolve({ ok: false, output: errorText(error) });
      }
    });
  });
}

function decrypt.findHatDocument(message: any): any | null {
  if (
    message?.documentMessage &&
    (
      String(
        message.documentMessage.fileName || '',
      ).toLowerCase().endsWith('.hat')
    )
  ) {
    return message.documentMessage;
  }

  if (
    message?.documentWithCaptionMessage?.message
      ?.documentMessage
  ) {
    const doc =
      message.documentWithCaptionMessage.message
        .documentMessage;

    if (
      String(doc.fileName || '')
        .toLowerCase()
        .endsWith('.hat')
    ) {
      return doc;
    }
  }

  return null;
}

function decrypt.findQuotedHatDocument(message: any): any | null {
  const context =
    message?.extendedTextMessage?.contextInfo;

  const quoted =
    context?.quotedMessage;

  return decrypt.findHatDocument(quoted);
}

function decrypt.findHcDocument(message: any): any | null {
  const document =
    message?.documentMessage ||
    message?.documentWithCaptionMessage?.message?.documentMessage;

  if (!document) return null;

  return String(document.fileName || '').toLowerCase().endsWith('.hc')
    ? document
    : null;
}

function decrypt.findQuotedHcDocument(message: any): any | null {
  const context = message?.extendedTextMessage?.contextInfo;
  return decrypt.findHcDocument(context?.quotedMessage);
}



function decrypt.decryptSettingFile(): string {
  return path.join(config.dataDir, 'decrypt-settings.json');
}

function decrypt.decryptLogFile(): string {
  return path.join(config.dataDir, 'decrypt-logs.jsonl');
}

function decrypt.decryptEnabled(): boolean {
  try {
    const file = decrypt.decryptSettingFile();

    if (!fs.existsSync(file)) {
      return false;
    }

    const data = JSON.parse(
      fs.readFileSync(file, 'utf8'),
    );

    return data.enabled === true;
  } catch {
    return false;
  }
}

function decrypt.setDecryptEnabled(enabled: boolean): void {
  fs.mkdirSync(config.dataDir, {
    recursive: true,
  });

  fs.writeFileSync(
    decrypt.decryptSettingFile(),
    JSON.stringify(
      {
        enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function decrypt.logDecrypt(
  action: string,
  chat: string,
  sender: string,
  success: boolean,
): void {
  fs.mkdirSync(config.dataDir, {
    recursive: true,
  });

  fs.appendFileSync(
    decrypt.decryptLogFile(),
    JSON.stringify({
      ts: new Date().toISOString(),
      action,
      chat,
      sender,
      success,
    }) + '\\n',
  );
}

function decrypt.recentDecryptLogs(
  limit = 10,
): string[] {
  try {
    const file = decrypt.decryptLogFile();

    if (!fs.existsSync(file)) {
      return [];
    }

    return fs
      .readFileSync(file, 'utf8')
      .split('\\n')
      .filter(Boolean)
      .slice(-limit)
      .map(line => {
        try {
          const item = JSON.parse(line);

          return (
            `${item.ts} | ` +
            `${item.action} | ` +
            `${item.success ? 'OK' : 'FAIL'}`
          );
        } catch {
          return line;
        }
      });
  } catch {
    return [];
  }
}

function decrypt.clearDecryptLogs(): void {
  try {
    const file = decrypt.decryptLogFile();

    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {}
}

function decrypt.decryptReplyTarget(M: any): any {
  /*
   * Always make decrypt output a WhatsApp reply.
   * If !decrypt was sent as a reply to a .hat/.hc file,
   * reply to that original file instead of creating a standalone message.
   */
  const context =
    M?.message?.extendedTextMessage?.contextInfo;

  if (context?.quotedMessage && context?.stanzaId) {
    return {
      key: {
        remoteJid: M.key?.remoteJid,
        id: context.stanzaId,
        participant:
          context.participant ||
          M.key?.participant ||
          undefined,
        fromMe: false,
      },
      message: context.quotedMessage,
    };
  }

  return M;
}

async function decrypt.sendDecryptMessage(
  currentSock: any,
  M: any,
  payload: any,
): Promise<any> {
  return currentSock.sendMessage(
    M.key.remoteJid!,
    payload,
    { quoted: decrypt.decryptReplyTarget(M) },
  );
}

async function decrypt.decryptHcFromMessage(currentSock: any, M: any): Promise<boolean> {
  const document = decrypt.findHcDocument(M.message) || decrypt.findQuotedHcDocument(M.message);
  if (!document) return false;

  const fileName = String(document.fileName || 'file.hc');
  const tempDir = path.join(config.dataDir, 'hat-tmp');
  fs.mkdirSync(tempDir, { recursive: true });

  const base = path.join(tempDir, `hc-${process.pid}-${Date.now()}`);
  const inputFile = `${base}.hc`;
  const outputFile = `${base}.txt`;

  try {
    console.log(chalk.cyan(`[HC] Decrypting ${fileName}`));
    const stream = await downloadContentFromMessage(document, 'document');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    fs.writeFileSync(inputFile, Buffer.concat(chunks));

    const result = await decrypt.runHcDecrypt(inputFile, outputFile);

    if (!result.ok) {
      await decrypt.sendDecryptMessage(currentSock, M, {
        text: 'HC decrypt failed.\\n\\n' + result.output.slice(0, 3000),
      });
      return true;
    }

    const plaintext = result.output;

    scanner.scanAndNotify(
      plaintext,
      'HC decrypted',
      M.key.remoteJid || '',
      M.key.participant || M.key.remoteJid || '',
    );

    if (!plaintext.trim()) {
      await decrypt.sendDecryptMessage(currentSock, M, {
        text: 'HC decryption completed, but the output is empty.',
      });
      return true;
    }

    const MAX = 6000;
    for (let i = 0; i < plaintext.length; i += MAX) {
      await decrypt.sendDecryptMessage(currentSock, M, {
        text: plaintext.slice(i, i + MAX),
      });
    }

    console.log(chalk.green(`[HC] Decrypted ${fileName}`));
    return true;
  } catch (error) {
    await reportError('hc-decrypt', error);
    try {
      await decrypt.sendDecryptMessage(currentSock, M, {
        text: 'HC decrypt failed: ' + errorText(error).slice(0, 2500),
      });
    } catch {}
    return true;
  } finally {
    try { fs.rmSync(inputFile, { force: true }); } catch {}
    try { fs.rmSync(outputFile, { force: true }); } catch {}
  }
}

async function decrypt.decryptHatFromMessage(
  currentSock: any,
  M: any,
): Promise<boolean> {
  const direct =
    decrypt.findHatDocument(M.message);

  const quoted =
    decrypt.findQuotedHatDocument(M.message);

  const document =
    direct || quoted;

  if (!document) {
    return false;
  }

  const fileName =
    String(document.fileName || 'file.hat');

  if (
    !fileName
      .toLowerCase()
      .endsWith('.hat')
  ) {
    return false;
  }

  /*
   * Termux may not provide a conventional /tmp.
   * Keep temporary HAT files inside the bot's
   * configured data directory instead.
   */
  const tempDir =
    path.join(
      config.dataDir,
      'hat-tmp',
    );

  fs.mkdirSync(
    tempDir,
    { recursive: true },
  );

  const base =
    path.join(
      tempDir,
      `hat-${process.pid}-${Date.now()}`,
    );

  const inputFile =
    `${base}.hat`;

  const outputFile =
    `${base}.txt`;

  try {
    console.log(
      chalk.cyan(
        `[HAT] Decrypting ${fileName}`,
      ),
    );

    const stream =
      await downloadContentFromMessage(
        document,
        'document',
      );

    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(
        Buffer.from(chunk),
      );
    }

    fs.writeFileSync(
      inputFile,
      Buffer.concat(chunks),
    );

    const result =
      await decrypt.runHatDecrypt(
        inputFile,
        outputFile,
      );

    if (!result.ok) {
      await decrypt.sendDecryptMessage(currentSock, M, {
          text:
            'Decrypt failed.\n\n' +
            result.output.slice(0, 3000),
        },
      );

      return true;
    }

    const plaintext =
      result.output;

    /*
     * Feed the actual decrypted plaintext into
     * the passive scanner. This runs for both
     * direct messages and group messages because
     * the original message JID is preserved.
     */
    scanner.scanAndNotify(
      plaintext,
      'HAT decrypted',
      M.key.remoteJid || '',
      M.key.participant ||
        M.key.remoteJid ||
        '',
    );

    if (!plaintext.trim()) {
      await decrypt.sendDecryptMessage(currentSock, M, {
          text: 'Decryption completed, but the output is empty.',
        },
      );

      return true;
    }

    /*
     * WhatsApp text messages have practical
     * size limits, so split large decrypted
     * files into manageable chunks.
     */
    const MAX = 6000;

    for (
      let i = 0;
      i < plaintext.length;
      i += MAX
    ) {
      await decrypt.sendDecryptMessage(currentSock, M, {
          text:
            plaintext.slice(
              i,
              i + MAX,
            ),
        },
      );
    }

    console.log(
      chalk.green(
        `[HAT] Decrypted ${fileName}`,
      ),
    );

    return true;
  } catch (error) {
    await reportError(
      'hat-decrypt',
      error,
    );

    try {
      await decrypt.sendDecryptMessage(currentSock, M, {
          text:
            'Decrypt failed: ' +
            errorText(error).slice(0, 2500),
        },
      );
    } catch {}

    return true;
  } finally {
    try {
      fs.rmSync(
        inputFile,
        { force: true },
      );
    } catch {}

    try {
      fs.rmSync(
        outputFile,
        { force: true },
      );
    } catch {}
  }
}

async function connect() {
  if (connectInProgress) {
    return;
  }

  connectInProgress = true;
  messageCutoffReady = false;
  messageCutoffUnix = 0;

  try {
    ensureDirs();

    waState = 'starting';

    const {
      state,
      saveCreds,
    } = await useMultiFileAuthState(
      config.authDir,
    );

    let version:
      | [number, number, number]
      | undefined;

    try {
      const latest =
        await fetchLatestBaileysVersion();

      version = latest.version;

      console.log(
        chalk.gray(
          `[WA] Version: ${version.join('.')}`,
        ),
      );
    } catch (error) {
      console.log(
        chalk.yellow(
          '[WA] Could not fetch latest WhatsApp version.',
        ),
      );

      console.log(
        chalk.gray(
          errorText(error),
        ),
      );
    }

    /*
     * Deliberately no pino import.
     *
     * QR remains disabled.
     *
     * Do not force a fake browser identity.
     */
    const options: any = {
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 20_000,
      retryRequestDelayMs: 2_000,
    };

    if (version) {
      options.version = version;
    }

    sock = makeWASocket(options);

    const currentSock = sock;

    currentSock.ev.on(
      'creds.update',
      saveCreds,
    );

    currentSock.ev.on(
      'connection.update',
      async update => {
        const {
          connection,
          lastDisconnect,
        } = update;

        if (connection === 'connecting') {
          waState = 'starting';

          console.log(
            chalk.cyan(
              '[WA] Connecting...',
            ),
          );

          return;
        }

        if (connection === 'open') {
          /*
           * Establish the backlog cutoff only after Baileys reports OPEN.
           */
          messageCutoffUnix = Math.floor(Date.now() / 1000);
          messageCutoffReady = true;
          waState = 'connected';
          pairing = false;
          reconnectAttempt = 0;

          lastDisconnectCode = null;
          lastDisconnectReason = '';

          console.log(
            chalk.green(
              '[WA] Connected successfully.',
            ),
          );

          console.log(
            chalk.green(
              `[WA] Uptime: ${uptime()}`,
            ),
          );

          try {
            await discord.start();
          } catch (error) {
            await reportError(
              'discord-start',
              error,
            );
          }

          return;
        }

        if (connection !== 'close') {
          return;
        }

        messageCutoffReady = false;
        waState = 'disconnected';

        const raw =
          lastDisconnect?.error as any;

        const statusCode =
          raw?.output?.statusCode ??
          raw?.statusCode ??
          null;

        const reason =
          raw?.output?.payload?.message ??
          raw?.message ??
          'Unknown connection error';

        lastDisconnectCode =
          typeof statusCode === 'number'
            ? statusCode
            : null;

        lastDisconnectReason =
          String(reason);

        console.error(
          chalk.red(
            `[WA] Disconnected code=${
              statusCode ?? 'unknown'
            } reason=${reason}`,
          ),
        );

        /*
         * Print the actual Baileys error.
         * This is important for diagnosing
         * WhatsApp login failures.
         */
        if (raw) {
          console.error(
            chalk.gray(
              errorText(raw),
            ),
          );
        }

        /*
         * ONLY an explicit loggedOut
         * disconnect is treated as logout.
         */
        const loggedOut =
          statusCode ===
          DisconnectReason.loggedOut;

        if (loggedOut) {
          pairing = false;

          console.error(
            chalk.red(
              '[AUTH] WhatsApp explicitly reported logged out.',
            ),
          );

          console.error(
            chalk.yellow(
              '[AUTH] Auth was NOT deleted.',
            ),
          );

          console.error(
            chalk.yellow(
              '[AUTH] Use !dev repair when appropriate.',
            ),
          );

          return;
        }

        /*
         * 401 Connection Failure is NOT
         * automatically treated as logout.
         */
        if (statusCode === 401) {
          console.error(
            chalk.yellow(
              '[AUTH] 401 Connection Failure.',
            ),
          );

          console.error(
            chalk.yellow(
              '[AUTH] Credentials preserved.',
            ),
          );

          scheduleReconnect(
            '401 connection failure',
          );

          return;
        }

        scheduleReconnect(
          `${statusCode ?? 'unknown'} ${reason}`,
        );
      },
    );

import { createMessageSideEffects } from './message-side-effects.js';
import { createScannerService } from './scanner-service.js';
import { createDecryptService } from './decrypt.js';

async function handleWhatsAppMessage(
  currentSock: ReturnType<typeof makeWASocket>,
  M: any,
) {
      try {
                  if (config.ignoreOfflineMessages) {
                    /*
                     * With backlog filtering enabled, anything delivered
                     * before the socket is OPEN is not admitted to the
                     * expensive message pipeline.
                     */
                    if (!messageCutoffReady) {
                      return;
                    }

                    const rawTimestamp = M.messageTimestamp;
                    const messageTimestamp =
                      typeof rawTimestamp === 'number'
                        ? rawTimestamp
                        : Number(rawTimestamp?.low ?? rawTimestamp ?? 0);

                    /*
                     * Backlog messages are discarded before message type
                     * inspection, text extraction, scanner dispatch, logging,
                     * command work, or Discord forwarding.
                     */
                    if (
                      messageTimestamp > 0 &&
                      messageTimestamp < messageCutoffUnix
                    ) {
                      return;
                    }
                  }

                  if (!M.message) {
                    return;
                  }

                  console.log(
                    chalk.magenta(
                      `[MSG] received jid=${M.key.remoteJid || 'unknown'} ` +
                      `fromMe=${M.key.fromMe ? 'yes' : 'no'} ` +
                      `type=${Object.keys(M.message || {}).join(',') || 'none'}`
                    )
                  );
      
                  const message = M.message;
                  const scanMessage = unwrapMessageContent(message);
                  const text = extractMessageText(scanMessage);
      
                  /*
                   * Command replies always return to the originating WhatsApp chat.
                   * The original command is quoted so WhatsApp renders it as a reply,
                   * including when the command was issued inside a group.
                   */
                  const commandReply = async (content: any) => {
                    let payload =
                      typeof content === 'string'
                        ? { text: content }
                        : { ...content };
      
                    if (
                      typeof payload.text === 'string' &&
                      !payload.text.includes('╭━━━')
                    ) {
                      payload.text = info(
                        'M_D TOOL',
                        payload.text.split('\n'),
                      );
                    }
      
                    await currentSock.sendMessage(
                      M.key.remoteJid!,
                      payload,
                      { quoted: M },
                    );
                  };
      
      
                  /*
                   * Scanner is a separate fire-and-forget subsystem.
                   */
                  sideEffects.dispatchScannerForMessage(
                    M,
                    scanMessage,
                    text,
                  );

                  /*
                   * !decrypt can operate on a directly
                   * received .hat document or a reply
                   * to a .hat document.
                   *
                   * We process this before the normal
                   * text check because documents do not
                   * necessarily contain conversation text.
                   */
                  if (
                    text.trim().toLowerCase() ===
                    `${config.prefix}decrypt`
                  ) {
                    const hat =
                      decrypt.findHatDocument(M.message) ||
                      decrypt.findQuotedHatDocument(M.message);
      
                    const hc =
                      decrypt.findHcDocument(M.message) ||
                      decrypt.findQuotedHcDocument(M.message);
      
                    let decrypted = false;
      
                    if (hat) {
                      decrypted = await decrypt.decryptHatFromMessage(currentSock, M);
                      decrypt.logDecrypt(
                        'decrypt-hat',
                        M.key.remoteJid || '',
                        M.key.participant || M.key.remoteJid || '',
                        decrypted,
                      );
                    } else if (hc) {
                      decrypted = await decrypt.decryptHcFromMessage(currentSock, M);
                      decrypt.logDecrypt(
                        'decrypt-hc',
                        M.key.remoteJid || '',
                        M.key.participant || M.key.remoteJid || '',
                        decrypted,
                      );
                    }
      
                    if (!decrypted) {
                      await commandReply({
                        text: error(
                          '🔐 DECRYPT',
                          [
                            'No .hat or .hc document found.',
                            `Reply to a .hat or .hc file with ${config.prefix}decrypt.`,
                          ],
                        ),
                      });
                    }
      
                    return;
                  }
      
                  if (!text) {
                    return;
                  }
      
                  console.log(
                    chalk.magenta(
                      `[CMD] text=${JSON.stringify(text)} ` +
                      `prefix=${JSON.stringify(config.prefix)}`
                    )
                  );
      
                  /*
                   * Mute enforcement happens before
                   * command processing.
                   */
                  const muted =
                    await enforceMute(
                      currentSock,
                      M,
                    );
      
                  if (muted) {
                    return;
                  }
      
                  /*
                   * Discord is a separate side-effect subsystem.
                   * Its network I/O is always detached from reception.
                   */
                  if (
                    sideEffects.dispatchDiscordForMessage(
                      M,
                      message,
                      text,
                    )
                  ) {
                    return;
                  }

  /*
                   * Commands.
                   */
                  if (
                    !text.startsWith(
                      config.prefix,
                    )
                  ) {
                    return;
                  }
      
                  const body =
                    text.slice(
                      config.prefix.length,
                    ).trim();
      
                  if (!body) {
                    return;
                  }
      
                  const parts =
                    body.split(/\s+/);
      
                  const command =
                    (
                      parts.shift() ||
                      ''
                    ).toLowerCase();
      
                  const args = parts;
      
                  /*
                   * Every command is owner-only.
                   * Non-owners are ignored silently, so the
                   * bot does not reveal that it exists to
                   * people who type !commands.
                   */
                  if (
                      !isCommandAuthorized(M)
                    ) {
                    return;
                  }
      
                  /*
                   * !hi
                   */
                  if (
                    command === 'hi'
                  ) {
                    await commandReply(
                      success(
                        '🟢 M_D TOOL ONLINE',
                        [
                          'Status : Connected',
                          'WhatsApp : Ready',
                        ],
                      ),
                    );
      
                    return;
                  }
      
                  /*
                   * !help
                   */
                  if (command === 'help') {
                    await commandReply({
                      
                        text: box(
                          '📖 M_D TOOL HELP',
                          [
                            'GENERAL',
                            `${config.prefix}help  — show commands`,
                            `${config.prefix}hi    — bot online check`,
                            '',
                            '📡 SCANNER',
                            `${config.prefix}scan`,
                            `${config.prefix}scan on`,
                            `${config.prefix}scan off`,
                            `${config.prefix}scan status`,
                            `${config.prefix}scan logs`,
                            `${config.prefix}scan file`,
                            `${config.prefix}scan clear`,
                            '',
                            '🔓 CONFIG DECRYPT',
                            `${config.prefix}decrypt`,
                            `${config.prefix}decrypt on`,
                            `${config.prefix}decrypt off`,
                            `${config.prefix}decrypt status`,
                            `${config.prefix}decrypt logs`,
                            `${config.prefix}decrypt file`,
                            `${config.prefix}decrypt clear`,
                            '',
                            '🛡 GROUP MODERATION',
                            `${config.prefix}warn`,
                            `${config.prefix}kick`,
                            `${config.prefix}mute`,
                            `${config.prefix}unmute`,
                            `${config.prefix}warnings`,
                            `${config.prefix}clearwarn`,
                            `${config.prefix}add`,
                            `${config.prefix}promote`,
                            `${config.prefix}demote`,
                            '',
                            '⚙️ ADMIN / DEV',
                            `${config.prefix}config`,
                            `${config.prefix}dev status`,
                            `${config.prefix}dev logs`,
                            `${config.prefix}dev errors`,
                            `${config.prefix}dev clearerrors`,
                            `${config.prefix}dev sh`,
                            `${config.prefix}dev py`,
                            `${config.prefix}dev restart`,
                          ],
                        ),
                      },
                    );
      
                    return;
                  }
      
                  /*
                   * !decrypt
                   */
                  if (command === 'decrypt') {
                    if (
                      !isCommandAuthorized(M)
                    ) {
                      await commandReply({
                        
                          text: error(
                            '⛔ ACCESS DENIED',
                            [
                              'Owner permission required.',
                            ],
                          ),
                        },
                      );
                      return;
                    }
      
                    const action =
                      (args[0] || 'decrypt').toLowerCase();
      
                    /*
                     * !decrypt on
                     */
                    if (action === 'on') {
                      decrypt.setDecryptEnabled(true);
      
                      await commandReply({
                        
                          text: success(
                            '🔓 CONFIG DECRYPT',
                            [
                              'Status : ON',
                              'Automatic decryption enabled.',
                            ],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt off
                     */
                    if (action === 'off') {
                      decrypt.setDecryptEnabled(false);
      
                      await commandReply({
                        
                          text: warning(
                            '🔓 CONFIG DECRYPT',
                            [
                              'Status : OFF',
                              'Automatic decryption disabled.',
                            ],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt status
                     */
                    if (action === 'status') {
                      await commandReply({
                        
                          text: info(
                            '🔓 CONFIG DECRYPT',
                            [
                              `Status : ${decrypt.decryptEnabled() ? 'ON' : 'OFF'}`,
                              `Log file : ${decrypt.decryptLogFile()}`,
                            ],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt logs
                     */
                    if (action === 'logs') {
                      const logs = decrypt.recentDecryptLogs(10);
      
                      await commandReply({
                        
                          text: info(
                            '📜 DECRYPT LOGS',
                            logs.length ? logs : ['No decrypt logs.'],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt file
                     */
                    if (action === 'file') {
                      await commandReply({
                        
                          text: info(
                            '📜 DECRYPT LOG FILE',
                            [decrypt.decryptLogFile()],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt clear
                     */
                    if (action === 'clear') {
                      decrypt.clearDecryptLogs();
      
                      await commandReply({
                        
                          text: success('📜 DECRYPT LOGS', ['Log cleared.']),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt
                     *
                     * Only decrypt when explicitly enabled.
                     */
                    if (!decrypt.decryptEnabled()) {
                      await commandReply({
                        
                          text: warning(
                            '🔓 CONFIG DECRYPT',
                            [
                              'Status : OFF',
                              `Use ${config.prefix}decrypt on first.`,
                            ],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    const hat =
                      decrypt.findHatDocument(M.message) ||
                      decrypt.findQuotedHatDocument(M.message);
      
                    const hc =
                      decrypt.findHcDocument(M.message) ||
                      decrypt.findQuotedHcDocument(M.message);
      
                    let decrypted = false;
      
                    if (hat) {
                      decrypted = await decrypt.decryptHatFromMessage(currentSock, M);
                      decrypt.logDecrypt(
                        'decrypt-hat',
                        M.key.remoteJid || '',
                        M.key.participant || M.key.remoteJid || '',
                        decrypted,
                      );
                    } else if (hc) {
                      decrypted = await decrypt.decryptHcFromMessage(currentSock, M);
                      decrypt.logDecrypt(
                        'decrypt-hc',
                        M.key.remoteJid || '',
                        M.key.participant || M.key.remoteJid || '',
                        decrypted,
                      );
                    }
      
                    if (!decrypted) {
                      await commandReply({
                        text: error(
                          '🔐 DECRYPT',
                          [
                            'No .hat or .hc document found.',
                            `Reply to a .hat or .hc file with ${config.prefix}decrypt.`,
                          ],
                        ),
                      });
                    }
      
                    return;
                  }
      
                  /*
                   * !scan
                   */
                  if (command === 'scan') {
                    if (
                      !isCommandAuthorized(M)
                    ) {
                      await commandReply({
                         text: error('⛔ ACCESS DENIED', ['Owner permission required.']) },
                      );
                      return;
                    }
      
                    const action =
                      (args[0] || 'status').toLowerCase();
      
                    if (action === 'on') {
                      scanner.setEnabled(true);
      
                      await commandReply({
                        
                          text: success('📡 SCANNER', ['Status : ON', 'Passive IP/URL scanning enabled.']),
                        },
                      );
      
                      return;
                    }
      
                    if (action === 'off') {
                      scanner.setEnabled(false);
      
                      await commandReply({
                        
                          text: warning('📡 SCANNER', ['Status : OFF', 'Passive IP/URL scanning disabled.']),
                        },
                      );
      
                      return;
                    }
      
                    if (action === 'clear') {
                      clearMatches();
      
                      await commandReply({
                        
                          text: success('📡 SCANNER', ['Saved matches cleared.']),
                        },
                      );
      
                      return;
                    }
      
                    if (action === 'file') {
                      await commandReply({
                        
                          text: info(
                            '📡 SCANNER FILE',
                            [scannerFile()],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    if (action === 'logs') {
                      const lines =
                        readMatches(
                          Number(args[1]) || 50,
                        );
      
                      await commandReply({
                        
                          text: info(
                            '📡 SCANNER LOGS',
                            lines.length
                              ? lines
                              : ['No scanner matches.'],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    await commandReply({
                      
                        text: info(
                        '📡 SCANNER STATUS',
                        [
                          `Enabled : ${scanner.isEnabled() ? 'YES' : 'NO'}`,
                          '',
                          `${config.prefix}scan on`,
                          `${config.prefix}scan off`,
                          `${config.prefix}scan logs`,
                          `${config.prefix}scan clear`,
                          `${config.prefix}scan file`,
                        ],
                      ),
                      },
                    );
      
                    return;
                  }
      
                  /*
                   * !config
                   */
                  if (
                    command === 'config'
                  ) {
                    if (
                      !isCommandAuthorized(M)
                    ) {
                      await commandReply({
                        
                          text: error('⛔ ACCESS DENIED', ['Owner permission required.']),
                        },
                      );
      
                      return;
                    }
      
                    await configCommand(
                      {
                        ...M,
                        reply: async (
                          replyText: string,
                        ) => {
                          await commandReply({
                             text: replyText },
                          );
                        },
                        sender:
                          M.key.participant ||
                          M.key.remoteJid ||
                          '',
                      },
                      args,
                    );
      
                    return;
                  }
      
                  /*
                   * Development commands.
                   *
                   * Existing dev.ts owns its
                   * command implementation.
                   */
                  if (
                    [
                      'dev',
                      'sh',
                      'py',
                      'status',
                      'logs',
                      'errors',
                      'clearerrors',
                      'restart',
                      'repair',
                    ].includes(command)
                  ) {
                    if (
                      !isCommandAuthorized(M)
                    ) {
                      await commandReply({
                        
                          text: error('⛔ ACCESS DENIED', ['Owner permission required.']),
                        },
                      );
      
                      return;
                    }
      
                    const devArgs =
                      command === 'dev'
                        ? args
                        : [
                            command,
                            ...args,
                          ];
      
                    if (
                      command === 'status'
                    ) {
                      await commandReply({
                        
                          text: [
                            'Bot status',
                            `WhatsApp: ${waState}`,
                            `Pairing: ${
                              pairing
                                ? 'active'
                                : 'idle'
                            }`,
                            `Discord: ${
                              discord.client?.isReady()
                                ? 'connected'
                                : 'disconnected'
                            }`,
                            `Discord target: ${
                              config.discordTarget ||
                              'not set'
                            }`,
                            `Reconnect attempt: ${
                              reconnectAttempt
                            }`,
                            `Last code: ${
                              lastDisconnectCode ??
                              'none'
                            }`,
                            `Last reason: ${
                              lastDisconnectReason ||
                              'none'
                            }`,
                            `Uptime: ${uptime()}`,
                          ].join('\n'),
                        },
                      );
      
                      return;
                    }
      
                    if (
                      command === 'logs'
                    ) {
                      const lines =
                        readHistory(50);
      
                      await commandReply({
                        
                          text:
                            lines.length
                              ? lines
                                  .join('\n')
                                  .slice(-6000)
                              : 'No Discord bridge history.',
                        },
                      );
      
                      return;
                    }
      
                    if (
                      command === 'errors'
                    ) {
                      const lines =
                        readErrors(50);
      
                      await commandReply({
                        
                          text:
                            lines.length
                              ? lines
                                  .join('\n')
                                  .slice(-6000)
                              : 'No recorded errors.',
                        },
                      );
      
                      return;
                    }
      
                    if (
                      command ===
                      'clearerrors'
                    ) {
                      clearErrors();
      
                      await commandReply({
                        
                          text:
                            'Error log cleared.',
                        },
                      );
      
                      return;
                    }
      
                    if (
                      command === 'repair'
                    ) {
                      if (
                        waState ===
                        'connected'
                      ) {
                        await commandReply({
                          
                            text:
                              'Repair refused while WhatsApp is connected.',
                          },
                        );
      
                        return;
                      }
      
                      if (reconnectTimer) {
                        clearTimeout(
                          reconnectTimer,
                        );
      
                        reconnectTimer = null;
                      }
      
                      const backup =
                        archiveAuth();
      
                      pairing = false;
                      reconnectAttempt = 0;
      
                      await commandReply({
                        
                          text: backup
                            ? [
                                'Auth archived.',
                                `Backup: ${backup}`,
                                'Starting fresh pairing...',
                              ].join('\n')
                            : [
                                'No existing auth found.',
                                'Starting fresh pairing...',
                              ].join('\n'),
                        },
                      );
      
                      sock = null;
      
                      await sleep(1000);
      
                      void connect();
      
                      return;
                    }
      
                    try {
                      await dev(
                        {
                          ...M,
                          reply: async (
                            replyText: string,
                          ) => {
                            await commandReply({
                              
                                text: replyText,
                              },
                            );
                          },
                          sender:
                            M.key.participant ||
                            M.key.remoteJid ||
                            '',
                        },
                        devArgs,
                      );
                    } catch (error) {
                      await reportError(
                        'dev-command',
                        error,
                      );
                    }
      
                    return;
                  }
      
                  /*
                   * Moderation commands.
                   */
                  if (
                    [
                      'warn',
                      'warnings',
                      'clearwarn',
                      'kick',
                      'mute',
                      'unmute',
                      'add',
                      'promote',
                      'demote',
                    ].includes(command)
                  ) {
                    try {
                      await moderate(
                        currentSock,
                        {
                          ...M,
                          reply: async (
                            replyText: string,
                          ) => {
                            await commandReply({
                              
                                text: replyText,
                              },
                            );
                          },
                          sender:
                            M.key.participant ||
                            M.key.remoteJid ||
                            '',
                        },
                        command,
                        args.join(' '),
                      );
                    } catch (error) {
                      await reportError(
                        'moderation',
                        error,
                      );
                    }
      
                    return;
                  }
      
                } catch (error) {
                  await reportError(
                    'message-handler',
                    error,
                  );
                }

  }

    currentSock.ev.on(
      'messages.upsert',
      ({ messages }) => {
        /*
         * Reception is deliberately tiny. Each message gets its own task.
         */
        for (const M of messages) {
          void handleWhatsAppMessage(
            currentSock,
            M,
          );
        }
      },
    );;

    /*
     * New account: request phone
     * pairing code.
     */
    if (
      !state.creds.registered
    ) {
      /*
       * Wait for the socket to finish the initial
       * connection handshake before requesting
       * the phone-number pairing code.
       */
      const pairingDeadline = Date.now() + 30_000;

      while (
        Date.now() < pairingDeadline &&
        sock === currentSock &&
        !state.creds.registered
      ) {
        if (String(waState) === 'connected') {
          break;
        }

        await sleep(500);
      }

      if (
        sock === currentSock &&
        !state.creds.registered &&
        !pairing
      ) {
        await requestPairingCode(
          {
            state,
            saveCreds,
          },
        );
      }
    }

  } catch (error) {
    waState = 'disconnected';

    await reportError(
      'connect',
      error,
    );

    scheduleReconnect(
      'connect() failed',
    );
  } finally {
    connectInProgress = false;
  }
}

const discord =
  new DiscordBridge(
    async (
      jid,
      text,
    ) => {
      if (
        !sock ||
        waState !== 'connected'
      ) {
        throw new Error(
          'WhatsApp is not connected.',
        );
      }

      return await sock.sendMessage(
        jid,
        { text },
      );
    },
  );

const scanner = createScannerService({
  getSocket: () => sock,
  owners: config.owners,
  discord,
});

const decrypt = createDecryptService({
  scanAndNotify: scanner.scanAndNotify,
  reportError,
});

const sideEffects = createMessageSideEffects({
  scanAndNotify: scanner.scanAndNotify,
  discord,
  discordTarget: config.discordTarget,
  reportError,
});

async function startup() {
  ensureDirs();

  console.log('');
  console.log(
    chalk.cyan(
      '========================================',
    ),
  );
  console.log(
    chalk.cyan(
      ' M_D TOOL — Termux Mobile',
    ),
  );
  console.log(
    chalk.cyan(
      '========================================',
    ),
  );

  console.log(
    `Auth: ${config.authDir}`,
  );

  console.log(
    `Data: ${config.dataDir}`,
  );

  console.log(
    `Discord target: ${
      config.discordTarget ||
      'disabled'
    }`,
  );

  console.log(
    `Owners: ${
      config.owners.length
    }`,
  );

  console.log(
    chalk.yellow(
      'QR pairing: DISABLED',
    ),
  );

  console.log(
    chalk.green(
      'Phone-number pairing: ENABLED',
    ),
  );

  console.log('');

  await connect();
}

void startup().catch(error => {
  void reportError(
    'startup',
    error,
  );
});
