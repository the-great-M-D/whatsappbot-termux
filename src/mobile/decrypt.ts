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

async function runHcDecrypt(inputFile: string, outputFile: string): Promise<{ ok: boolean; output: string }> {
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

function findHcDocument(message: any): any | null {
  const document =
    message?.documentMessage ||
    message?.documentWithCaptionMessage?.message?.documentMessage;

  if (!document) return null;

  return String(document.fileName || '').toLowerCase().endsWith('.hc')
    ? document
    : null;
}

function findQuotedHcDocument(message: any): any | null {
  const context = message?.extendedTextMessage?.contextInfo;
  return findHcDocument(context?.quotedMessage);
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

function decryptReplyTarget(M: any): any {
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

async function sendDecryptMessage(
  currentSock: any,
  M: any,
  payload: any,
): Promise<any> {
  return currentSock.sendMessage(
    M.key.remoteJid!,
    payload,
    { quoted: decryptReplyTarget(M) },
  );
}

async function decryptHcFromMessage(currentSock: any, M: any): Promise<boolean> {
  const document = findHcDocument(M.message) || findQuotedHcDocument(M.message);
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

    const result = await runHcDecrypt(inputFile, outputFile);

    if (!result.ok) {
      await sendDecryptMessage(currentSock, M, {
        text: 'HC decrypt failed.\\n\\n' + result.output.slice(0, 3000),
      });
      return true;
    }

    const plaintext = result.output;

    scanner.deps.scanAndNotify(
      plaintext,
      'HC decrypted',
      M.key.remoteJid || '',
      M.key.participant || M.key.remoteJid || '',
    );

    if (!plaintext.trim()) {
      await sendDecryptMessage(currentSock, M, {
        text: 'HC decryption completed, but the output is empty.',
      });
      return true;
    }

    const MAX = 6000;
    for (let i = 0; i < plaintext.length; i += MAX) {
      await sendDecryptMessage(currentSock, M, {
        text: plaintext.slice(i, i + MAX),
      });
    }

    console.log(chalk.green(`[HC] Decrypted ${fileName}`));
    return true;
  } catch (error) {
    await deps.reportError('hc-decrypt', error);
    try {
      await sendDecryptMessage(currentSock, M, {
        text: 'HC decrypt failed: ' + errorText(error).slice(0, 2500),
      });
    } catch {}
    return true;
  } finally {
    try { fs.rmSync(inputFile, { force: true }); } catch {}
    try { fs.rmSync(outputFile, { force: true }); } catch {}
  }
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
      await sendDecryptMessage(currentSock, M, {
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
    scanner.deps.scanAndNotify(
      plaintext,
      'HAT decrypted',
      M.key.remoteJid || '',
      M.key.participant ||
        M.key.remoteJid ||
        '',
    );

    if (!plaintext.trim()) {
      await sendDecryptMessage(currentSock, M, {
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
      await sendDecryptMessage(currentSock, M, {
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
    await deps.reportError(
      'hat-decrypt',
      error,
    );

    try {
      await sendDecryptMessage(currentSock, M, {
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
