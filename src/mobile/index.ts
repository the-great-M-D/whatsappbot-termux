import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  downloadContentFromMessage,
} from '@whiskeysockets/baileys';

import chalk from 'chalk';

import { config } from './config.js';
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
let lastDisconnectCode: number | null = null;
let lastDisconnectReason = '';

const errorAlertTimes = new Map<string, number>();
const ERROR_ALERT_COOLDOWN = 5 * 60 * 1000;

let scannerEnabled = true;

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
  const incoming = String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\\D/g, '');

  if (!incoming) {
    console.log(chalk.red(`[OWNER] empty sender JID: ${jid}`));
    return false;
  }

  const owners = config.owners
    .map(owner =>
      String(owner || '')
        .split('@')[0]
        .split(':')[0]
        .replace(/\\D/g, '')
    )
    .filter(Boolean);

  const matched = owners.includes(incoming);

  console.log(
    matched
      ? chalk.green(`[OWNER] authorized ${incoming}`)
      : chalk.red(`[OWNER] denied ${incoming} owners=${owners.join(',')}`)
  );

  return matched;
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


async function scanAndNotify(
  text: string,
  source: string,
  chat: string,
  sender: string,
) {
  if (!scannerEnabled || !text.trim()) {
    return;
  }

  const matches = scanText(
    text,
    source,
    chat,
    sender,
  );

  const fresh = saveMatches(matches);

  if (!fresh.length || !sock) {
    return;
  }

  for (const owner of config.owners) {
    try {
      const body = fresh.map(match => {
        return [
          '[SCANNER MATCH]',
          `Type: ${match.type}`,
          `Match: ${match.value}`,
          `Source: ${match.source}`,
          `Sender: ${match.sender || 'unknown'}`,
          `Chat: ${match.chat || 'unknown'}`,
          `Time: ${new Date(match.ts).toISOString()}`,
        ].join('\n');
      }).join('\n\n');

      await sock.sendMessage(owner, {
        text: body.slice(0, 6000),
      });
    } catch (error) {
      console.error(
        chalk.gray(
          '[SCANNER] owner notification failed:',
        ),
        errorText(error),
      );
    }
  }
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


async function runHatDecrypt(
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

function findHatDocument(message: any): any | null {
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

function findQuotedHatDocument(message: any): any | null {
  const context =
    message?.extendedTextMessage?.contextInfo;

  const quoted =
    context?.quotedMessage;

  return findHatDocument(quoted);
}


function decryptSettingFile(): string {
  return path.join(config.dataDir, 'decrypt-settings.json');
}

function decryptLogFile(): string {
  return path.join(config.dataDir, 'decrypt-logs.jsonl');
}

function decryptEnabled(): boolean {
  try {
    const file = decryptSettingFile();

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

function setDecryptEnabled(enabled: boolean): void {
  fs.mkdirSync(config.dataDir, {
    recursive: true,
  });

  fs.writeFileSync(
    decryptSettingFile(),
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

function logDecrypt(
  action: string,
  chat: string,
  sender: string,
  success: boolean,
): void {
  fs.mkdirSync(config.dataDir, {
    recursive: true,
  });

  fs.appendFileSync(
    decryptLogFile(),
    JSON.stringify({
      ts: new Date().toISOString(),
      action,
      chat,
      sender,
      success,
    }) + '\\n',
  );
}

function recentDecryptLogs(
  limit = 10,
): string[] {
  try {
    const file = decryptLogFile();

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

function clearDecryptLogs(): void {
  try {
    const file = decryptLogFile();

    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {}
}

async function decryptHatFromMessage(
  currentSock: any,
  M: any,
): Promise<boolean> {
  const direct =
    findHatDocument(M.message);

  const quoted =
    findQuotedHatDocument(M.message);

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
      await runHatDecrypt(
        inputFile,
        outputFile,
      );

    if (!result.ok) {
      await currentSock.sendMessage(
        M.key.remoteJid!,
        {
          text:
            'Decrypt failed.\n\n' +
            result.output.slice(0, 3000),
        },
      );

      return true;
    }

    const plaintext =
      result.output;

    if (!plaintext.trim()) {
      await currentSock.sendMessage(
        M.key.remoteJid!,
        {
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
      await currentSock.sendMessage(
        M.key.remoteJid!,
        {
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
      await currentSock.sendMessage(
        M.key.remoteJid!,
        {
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

    currentSock.ev.on(
      'messages.upsert',
      async ({ messages }) => {
        for (const M of messages) {
          try {
            console.log(
              chalk.magenta(
                `[MSG] received jid=${M.key.remoteJid || 'unknown'} ` +
                `fromMe=${M.key.fromMe ? 'yes' : 'no'} ` +
                `type=${Object.keys(M.message || {}).join(',') || 'none'}`
              )
            );

            if (!M.message) {
              continue;
            }

            if (M.key.fromMe) {
              continue;
            }

            const message =
              M.message;

            const text =
              message.conversation ||
              message.extendedTextMessage?.text ||
              '';

            /*
             * Passive IP/link scanner.
             * This only extracts values from message text;
             * it does not connect to or probe them.
             */
            if (text) {
              await scanAndNotify(
                text,
                'WhatsApp',
                M.key.remoteJid || '',
                M.key.participant ||
                  M.key.remoteJid ||
                  '',
              );
            }

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
              const decrypted =
                await decryptHatFromMessage(
                  currentSock,
                  M,
                );

              if (!decrypted) {
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      'Reply to a .hat file with ' +
                      `${config.prefix}decrypt.`,
                  },
                );
              }

              continue;
            }

            if (!text) {
              continue;
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
              continue;
            }

            /*
             * Discord bridge.
             */
            if (
              config.discordTarget &&
              M.key.remoteJid ===
                config.discordTarget
            ) {
              try {
                await discord.fromWA(
                  M.key.participant ||
                    M.key.remoteJid ||
                    '',
                  M.pushName ||
                    'Unknown',
                  text,
                );
              } catch (error) {
                await reportError(
                  'discord-bridge',
                  error,
                );
              }
            }

            /*
             * Commands.
             */
            if (
              !text.startsWith(
                config.prefix,
              )
            ) {
              continue;
            }

            const body =
              text.slice(
                config.prefix.length,
              ).trim();

            if (!body) {
              continue;
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
             * !hi
             */
            if (
              command === 'hi'
            ) {
              await currentSock.sendMessage(
                M.key.remoteJid!,
                {
                  text: success(
                    '🤖 BOT ONLINE',
                    [
                      'Status : Connected',
                      'WhatsApp : Ready',
                    ],
                  ),
                },
              );

              continue;
            }

            /*
             * !help
             */
            if (command === 'help') {
              await currentSock.sendMessage(
                M.key.remoteJid!,
                {
                  text: box(
                    '🤖 BOT HELP',
                    [
                      'GENERAL',
                      `${config.prefix}help  — show commands`,
                      `${config.prefix}hi    — bot online check`,
                      '',
                      '🔎 SCANNER',
                      `${config.prefix}scan`,
                      `${config.prefix}scan on`,
                      `${config.prefix}scan off`,
                      `${config.prefix}scan status`,
                      `${config.prefix}scan logs`,
                      `${config.prefix}scan file`,
                      `${config.prefix}scan clear`,
                      '',
                      '🔓 HAT DECRYPT',
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
                      '⚙ ADMIN / DEV',
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

              continue;
            }

            /*
             * !decrypt
             */
            if (command === 'decrypt') {
              if (
                !isOwner(
                  M.key.participant ||
                    M.key.remoteJid ||
                    '',
                )
              ) {
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text: error(
                      '🔐 ACCESS DENIED',
                      [
                        'Owner permission required.',
                      ],
                    ),
                  },
                );
                continue;
              }

              const action =
                (args[0] || 'decrypt').toLowerCase();

              /*
               * !decrypt on
               */
              if (action === 'on') {
                setDecryptEnabled(true);

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text: success(
                      '🔓 HAT DECRYPT',
                      [
                        'Status : ON',
                        'Automatic decryption enabled.',
                      ],
                    ),
                  },
                );

                continue;
              }

              /*
               * !decrypt off
               */
              if (action === 'off') {
                setDecryptEnabled(false);

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text: warning(
                      '🔓 HAT DECRYPT',
                      [
                        'Status : OFF',
                        'Automatic decryption disabled.',
                      ],
                    ),
                  },
                );

                continue;
              }

              /*
               * !decrypt status
               */
              if (action === 'status') {
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      `HAT decryption: ${
                        decryptEnabled() ? 'ON' : 'OFF'
                      }\n` +
                      `Log file: ${decryptLogFile()}`,
                  },
                );

                continue;
              }

              /*
               * !decrypt logs
               */
              if (action === 'logs') {
                const logs = recentDecryptLogs(10);

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      logs.length
                        ? 'DECRYPT LOGS\\n\\n' + logs.join('\\n')
                        : 'No decrypt logs.',
                  },
                );

                continue;
              }

              /*
               * !decrypt file
               */
              if (action === 'file') {
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      `Decrypt log file:\\n${decryptLogFile()}`,
                  },
                );

                continue;
              }

              /*
               * !decrypt clear
               */
              if (action === 'clear') {
                clearDecryptLogs();

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text: 'Decrypt logs cleared.',
                  },
                );

                continue;
              }

              /*
               * !decrypt
               *
               * Only decrypt when explicitly enabled.
               */
              if (!decryptEnabled()) {
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      'HAT decryption is OFF.\\n' +
                      `Use ${config.prefix}decrypt on first.`,
                  },
                );

                continue;
              }

              const decrypted =
                await decryptHatFromMessage(
                  currentSock,
                  M,
                );

              logDecrypt(
                'decrypt',
                M.key.remoteJid || '',
                M.key.participant ||
                  M.key.remoteJid ||
                  '',
                !!decrypted,
              );

              if (!decrypted) {
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      'Reply to a .hat file with ' +
                      `${config.prefix}decrypt.`,
                  },
                );
              }

              continue;
            }

            /*
             * !scan
             */
            if (command === 'scan') {
              if (
                !isOwner(
                  M.key.participant ||
                    M.key.remoteJid ||
                    '',
                )
              ) {
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  { text: 'Owner only.' },
                );
                continue;
              }

              const action =
                (args[0] || 'status').toLowerCase();

              if (action === 'on') {
                scannerEnabled = true;

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text: 'Scanner enabled.',
                  },
                );

                continue;
              }

              if (action === 'off') {
                scannerEnabled = false;

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text: 'Scanner disabled.',
                  },
                );

                continue;
              }

              if (action === 'clear') {
                clearMatches();

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text: 'Scanner matches cleared.',
                  },
                );

                continue;
              }

              if (action === 'file') {
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      'Scanner file:\n' +
                      scannerFile(),
                  },
                );

                continue;
              }

              if (action === 'logs') {
                const lines =
                  readMatches(
                    Number(args[1]) || 50,
                  );

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      lines.length
                        ? lines.join('\n')
                        : 'No scanner matches.',
                  },
                );

                continue;
              }

              await currentSock.sendMessage(
                M.key.remoteJid!,
                {
                  text: [
                    'Scanner status',
                    `Enabled: ${scannerEnabled ? 'yes' : 'no'}`,
                    '',
                    'Commands:',
                    '!scan on',
                    '!scan off',
                    '!scan logs',
                    '!scan clear',
                    '!scan file',
                  ].join('\n'),
                },
              );

              continue;
            }

            /*
             * !config
             */
            if (
              command === 'config'
            ) {
              if (
                !isOwner(
                  M.key.participant ||
                    M.key.remoteJid ||
                    '',
                )
              ) {
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text: 'Owner only.',
                  },
                );

                continue;
              }

              await configCommand(
                {
                  ...M,
                  reply: async (
                    replyText: string,
                  ) => {
                    await currentSock.sendMessage(
                      M.key.remoteJid!,
                      { text: replyText },
                    );
                  },
                  sender:
                    M.key.participant ||
                    M.key.remoteJid ||
                    '',
                },
                args,
              );

              continue;
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
                !isOwner(
                  M.key.participant ||
                    M.key.remoteJid ||
                    '',
                )
              ) {
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text: 'Owner only.',
                  },
                );

                continue;
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
                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
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

                continue;
              }

              if (
                command === 'logs'
              ) {
                const lines =
                  readHistory(50);

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      lines.length
                        ? lines
                            .join('\n')
                            .slice(-6000)
                        : 'No Discord bridge history.',
                  },
                );

                continue;
              }

              if (
                command === 'errors'
              ) {
                const lines =
                  readErrors(50);

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      lines.length
                        ? lines
                            .join('\n')
                            .slice(-6000)
                        : 'No recorded errors.',
                  },
                );

                continue;
              }

              if (
                command ===
                'clearerrors'
              ) {
                clearErrors();

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
                    text:
                      'Error log cleared.',
                  },
                );

                continue;
              }

              if (
                command === 'repair'
              ) {
                if (
                  waState ===
                  'connected'
                ) {
                  await currentSock.sendMessage(
                    M.key.remoteJid!,
                    {
                      text:
                        'Repair refused while WhatsApp is connected.',
                    },
                  );

                  continue;
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

                await currentSock.sendMessage(
                  M.key.remoteJid!,
                  {
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

                continue;
              }

              try {
                await dev(
                  {
                    ...M,
                    reply: async (
                      replyText: string,
                    ) => {
                      await currentSock.sendMessage(
                        M.key.remoteJid!,
                        {
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

              continue;
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
                      await currentSock.sendMessage(
                        M.key.remoteJid!,
                        {
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

              continue;
            }

          } catch (error) {
            await reportError(
              'message-handler',
              error,
            );
          }
        }
      },
    );

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

      await sock.sendMessage(
        jid,
        { text },
      );
    },
  );

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
      ' WhatsApp Bot — Termux Mobile',
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
