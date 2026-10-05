import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import chalk from 'chalk';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { config } from './config.js';

export type DecryptServiceDeps = {
  scanAndNotify: (
    text: string,
    source: string,
    chat: string,
    sender: string,
  ) => void;
  reportError: (
    category: string,
    error: unknown,
  ) => Promise<void>;
};

function errorText(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}

export function createDecryptService(
  deps: DecryptServiceDeps,
) {

  return {
    runHatDecrypt,
    runHcDecrypt,
    findHatDocument,
    findQuotedHatDocument,
    findHcDocument,
    findQuotedHcDocument,
    decryptSettingFile,
    decryptLogFile,
    decryptEnabled,
    setDecryptEnabled,
    logDecrypt,
    recentDecryptLogs,
    clearDecryptLogs,
    decryptReplyTarget,
    sendDecryptMessage,
    decryptHcFromMessage,
    decryptHatFromMessage,
  };
}
