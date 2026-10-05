import fs from 'node:fs';
import path from 'node:path';

import makeWASocket from '@whiskeysockets/baileys';

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
  savePayloadRecord,
  readMatches,
  clearMatches,
  scannerFile,
} from './scanner.js';

import { createMessageSideEffects } from './message-side-effects.js';
import { createScannerService } from './scanner-service.js';
import { createDecryptService } from './decrypt.js';
import { createCommandRouter } from './command-router.js';
import { createWhatsAppMessageHandler } from './message-handler.js';
import { createConnectionManager } from './connection-manager.js';

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

const authBackupRoot =
  '/storage/1FC3-111D/whatsapp-auth-backups';

let connectionManager: ReturnType<typeof createConnectionManager> | null = null;

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
  const currentSock = connectionManager?.getSocket();

  if (
    !currentSock ||
    connectionManager?.getStatus().waState !== 'connected'
  ) {
    return;
  }

  if (!config.owners.length) {
    return;
  }

  try {
    for (const owner of config.owners) {
      await currentSock.sendMessage(owner, { text });
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

const discord =
  new DiscordBridge(
    async (
      jid,
      text,
    ) => {
      const currentSock = connectionManager?.getSocket();

      if (
        !currentSock ||
        connectionManager?.getStatus().waState !== 'connected'
      ) {
        throw new Error(
          'WhatsApp is not connected.',
        );
      }

      return await currentSock.sendMessage(
        jid,
        { text },
      );
    },
  );

connectionManager = createConnectionManager({
  config,
  sleep,
  ensureDirs,
  errorText,
  reportError,
  discord,
});

const scanner = createScannerService({
  getSocket: () => connectionManager?.getSocket() || null,
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
  getStatus: () => connectionManager!.getStatus(),
  archiveAuth,
  clearReconnectTimer: () => connectionManager!.clearReconnectTimer(),
  setSocket: (value: ReturnType<typeof makeWASocket> | null) =>
    connectionManager!.setSocket(value),
  sleep,
  connect: () => connectionManager!.connect(),
  resetReconnectState: () => connectionManager!.resetReconnectState(),
  uptime: () => connectionManager!.uptime(),
  reportError,
  decryptEnabled: decrypt.decryptEnabled,
  decryptLogFile: decrypt.decryptLogFile,
  enforceMute,
  clearMatches,
  readMatches,
  scannerFile,
  dispatchDiscordForMessage: sideEffects.dispatchDiscordForMessage,
});

const handleWhatsAppMessage =
  createWhatsAppMessageHandler({
    config,
    sideEffects,
    decrypt,
    commandRouter,
    info,
    error,
    reportError,
    getMessageCutoff: () => connectionManager!.getCutoff(),
  });

connectionManager!.setMessageHandler(
  handleWhatsAppMessage,
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

  await connectionManager!.connect();
}

void startup().catch(error => {
  void reportError(
    'startup',
    error,
  );
});
