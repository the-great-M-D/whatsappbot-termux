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

import { createMessageSideEffects } from './message-side-effects.js';
import { createScannerService } from './scanner-service.js';
import { createDecryptService } from './decrypt.js';
import { createCommandRouter } from './command-router.js';

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
 * WhatsApp 440 means the current session was replaced elsewhere.
 * Do not loop forever if the session keeps getting replaced.
 */
let connectionReplacedCount = 0;
let connectionReplacedWindowStartedAt = 0;
let automaticReconnectBlocked = false;
const CONNECTION_REPLACED_WINDOW_MS = 60_000;
const CONNECTION_REPLACED_MAX = 3;

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

  if (automaticReconnectBlocked) {
    console.log(
      chalk.yellow(
        '[WA] Automatic reconnect is blocked after repeated 440 conflicts.',
      ),
    );
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


async function connect() {
  /*
   * Never create a second Baileys socket while the current socket is
   * still active. Two sockets using the same WhatsApp auth state can
   * replace each other and produce DisconnectReason.connectionReplaced
   * (440 / "Stream Errored (conflict)").
   */
  if (connectInProgress) {
    return;
  }

  if (
    sock &&
    (
      waState === 'starting' ||
      waState === 'pairing' ||
      waState === 'connected'
    )
  ) {
    console.log(
      chalk.gray(
        '[WA] connect() ignored: socket already active.',
      ),
    );
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
           * A stale socket must never take ownership of global state after
           * a newer socket has been created.
           */
          if (sock !== currentSock) {
            console.log(
              chalk.gray(
                '[WA] Ignoring OPEN event from stale socket.',
              ),
            );
            return;
          }

          /*
           * Establish the backlog cutoff only after Baileys reports OPEN.
           */
          messageCutoffUnix = Math.floor(Date.now() / 1000);
          messageCutoffReady = true;
          waState = 'connected';
          pairing = false;
          reconnectAttempt = 0;
          connectionReplacedCount = 0;
          connectionReplacedWindowStartedAt = 0;
          automaticReconnectBlocked = false;

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

          /*
           * Discord is a side-effect subsystem. Never make WhatsApp's
           * connection/open path wait on Discord startup or its network
           * latency. A Discord failure must remain isolated from WA.
           */
          void discord.start().catch(error => {
            void reportError(
              'discord-start',
              error,
            );
          });

          return;
        }

        if (connection !== 'close') {
          return;
        }

        /*
         * A stale socket may still emit CLOSE after a replacement socket
         * has already been created. It must not change global connection
         * state or schedule another reconnect.
         */
        if (sock !== currentSock) {
          console.log(
            chalk.gray(
              '[WA] Ignoring CLOSE event from stale socket.',
            ),
          );
          return;
        }

        messageCutoffReady = false;
        waState = 'disconnected';
        sock = null;

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

        if (statusCode === DisconnectReason.connectionReplaced) {
          const now = Date.now();

          if (
            !connectionReplacedWindowStartedAt ||
            now - connectionReplacedWindowStartedAt >
              CONNECTION_REPLACED_WINDOW_MS
          ) {
            connectionReplacedWindowStartedAt = now;
            connectionReplacedCount = 0;
          }

          connectionReplacedCount++;

          console.error(
            chalk.yellow(
              '[AUTH] 440 connection replaced (' +
              connectionReplacedCount +
              '/' +
              CONNECTION_REPLACED_MAX +
              ').',
            ),
          );

          console.error(
            chalk.yellow(
              '[AUTH] Credentials preserved; no auth reset will be performed automatically.',
            ),
          );

          if (connectionReplacedCount >= CONNECTION_REPLACED_MAX) {
            automaticReconnectBlocked = true;

            console.error(
              chalk.red(
                '[AUTH] Repeated 440 conflicts detected. Automatic reconnect stopped.',
              ),
            );

            console.error(
              chalk.yellow(
                '[AUTH] Check WhatsApp → Settings → Linked devices for another active session.',
              ),
            );

            console.error(
              chalk.yellow(
                '[AUTH] Auth remains intact. Use !dev repair only after confirming the old session is gone.',
              ),
            );

            return;
          }

          scheduleReconnect(
            '440 connection replaced',
          );

          return;
        }

        scheduleReconnect(
          `${statusCode ?? 'unknown'} ${reason}`,
        );
      },
    );

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
                   * Discord forwarding is a detached side effect and is started
                   * immediately after reception/text extraction. This keeps
                   * newsletters independent of command processing and allows
                   * non-text newsletter updates to be forwarded too.
                   */
                  sideEffects.dispatchDiscordForMessage(
                    M,
                    message,
                    text,
                  );
      
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

                  /*
                   * Self-generated non-command messages do not need to enter
                   * command routing. Self-issued prefixed commands remain
                   * supported by isCommandAuthorized().
                   */
                  if (
                    M.key.fromMe === true &&
                    !text.trim().startsWith(config.prefix)
                  ) {
                    return;
                  }
      
                  console.log(
                    chalk.magenta(
                      `[CMD] text=${JSON.stringify(text)} ` +
                      `prefix=${JSON.stringify(config.prefix)}`,
                    ),
                  );

                  await commandRouter(
                    currentSock,
                    M,
                    message,
                    text,
                    commandReply,
                  );

                  return;
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

const commandRouter = createCommandRouter({
  config,
  info,
  success,
  warning,
  error,
  box,
  isCommandAuthorized,
  decrypt,
  scanner,
  discord,
  configCommand,
  dev,
  moderate,
  readHistory,
  readErrors,
  clearErrors,
  getStatus: () => ({
    waState,
    pairing,
    reconnectAttempt,
    connectionReplacedCount,
    automaticReconnectBlocked,
    lastDisconnectCode,
    lastDisconnectReason,
  }),
  archiveAuth,
  clearReconnectTimer: () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  },
  setSocket: (value: ReturnType<typeof makeWASocket> | null) => {
    sock = value;
  },
  sleep,
  connect,
  resetReconnectState: () => {
    pairing = false;
    reconnectAttempt = 0;
    connectionReplacedCount = 0;
    connectionReplacedWindowStartedAt = 0;
    automaticReconnectBlocked = false;
  },
  uptime,
  reportError,
  decryptEnabled: decrypt.decryptEnabled,
  decryptLogFile: decrypt.decryptLogFile,
  enforceMute,
  clearMatches,
  readMatches,
  scannerFile,
  dispatchDiscordForMessage: sideEffects.dispatchDiscordForMessage,
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
