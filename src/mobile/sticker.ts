import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { config } from './config.js';

function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function directDocument(message: any): any | null {
  return message?.documentMessage ||
    message?.documentWithCaptionMessage?.message?.documentMessage ||
    null;
}

function quotedDocument(message: any): any | null {
  return directDocument(message?.extendedTextMessage?.contextInfo?.quotedMessage);
}

function findWasDocument(message: any): any | null {
  const document = directDocument(message) || quotedDocument(message);
  if (!document) return null;

  const fileName = String(document.fileName || '').toLowerCase();
  const mime = String(document.mimetype || '').toLowerCase();

  return fileName.endsWith('.was') ||
    mime === 'application/x-was' ||
    mime === 'application/was'
    ? document
    : null;
}

function replyTarget(M: any): any {
  const context = M?.message?.extendedTextMessage?.contextInfo;
  if (context?.quotedMessage && context?.stanzaId) {
    return {
      key: {
        remoteJid: M.key?.remoteJid,
        id: context.stanzaId,
        participant: context.participant || M.key?.participant || undefined,
        fromMe: false,
      },
      message: context.quotedMessage,
    };
  }
  return M;
}

function runConverter(inputFile: string, outputFile: string): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    const script = path.resolve(process.cwd(), 'scripts', 'was_to_sticker.py');
    const child = spawn('python', [script, inputFile, outputFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => resolve({ ok: false, output: errorText(error) }));
    child.on('close', code => {
      if (code === 0) {
        resolve({ ok: true, output: stdout.trim() });
        return;
      }
      resolve({
        ok: false,
        output: stderr.trim() || stdout.trim() || `sticker converter exited with code ${code}`,
      });
    });
  });
}

export function createStickerService(deps: {
  reportError: (category: string, error: unknown) => Promise<void>;
}) {
  async function convertWasToSticker(currentSock: any, M: any): Promise<boolean> {
    const document = findWasDocument(M.message);
    if (!document) return false;

    const fileName = String(document.fileName || 'animation.was');
    const tempDir = path.join(config.dataDir, 'sticker-tmp');
    fs.mkdirSync(tempDir, { recursive: true });

    const base = path.join(
      tempDir,
      `was-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const inputFile = `${base}.was`;
    const outputFile = `${base}.webp`;

    try {
      console.log(`[STICKER] Converting ${fileName}`);

      const stream = await downloadContentFromMessage(document, 'document');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));

      fs.writeFileSync(inputFile, Buffer.concat(chunks));

      const result = await runConverter(inputFile, outputFile);
      if (!result.ok) {
        await currentSock.sendMessage(M.key.remoteJid!, {
          text: 'Sticker conversion failed.\n\n' + result.output.slice(0, 3000),
        }, { quoted: replyTarget(M) });
        return true;
      }

      const sticker = fs.readFileSync(outputFile);
      if (sticker.length > 1024 * 1024) {
        await currentSock.sendMessage(M.key.remoteJid!, {
          text: `Sticker is too large: ${(sticker.length / 1024 / 1024).toFixed(2)} MB.\n\nTry a shorter or simpler animation.`,
        }, { quoted: replyTarget(M) });
        return true;
      }

      await currentSock.sendMessage(M.key.remoteJid!, { sticker }, {
        quoted: replyTarget(M),
      });

      console.log(`[STICKER] Sent ${fileName} (${sticker.length} bytes)`);
      return true;
    } catch (error) {
      await deps.reportError('sticker-convert', error);
      try {
        await currentSock.sendMessage(M.key.remoteJid!, {
          text: 'Sticker conversion failed: ' + errorText(error).slice(0, 2500),
        }, { quoted: replyTarget(M) });
      } catch {}
      return true;
    } finally {
      try { fs.rmSync(inputFile, { force: true }); } catch {}
      try { fs.rmSync(outputFile, { force: true }); } catch {}
    }
  }

  return { convertWasToSticker, findWasDocument };
}
