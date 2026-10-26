import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { CustomFile } from 'telegram/client/uploads.js';

type PendingTransfer = {
  sock: any;
  senderJid: string;
  originalChatJid: string;
  originalMessage: any;
  timeout: ReturnType<typeof setTimeout>;
};

function expandHome(filePath: string) {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return path.resolve(filePath);
}

function unwrapMessage(message: any): any {
  let current = message;
  for (let i = 0; i < 8 && current; i++) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
    else break;
  }
  return current;
}

function cleanReturnedText(input: string) {
  const lines = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');

  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines[0]?.trim() === 'HABIBI HA TUNNEL SCRIPT') {
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines[0] && /^=+\s*$/.test(lines[0])) lines.shift();
  }

  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines[lines.length - 1]?.trim() === 'code : @HABIBI_1ST') {
    lines.pop();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length && /^=+\s*$/.test(lines[lines.length - 1])) lines.pop();
  }

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

async function streamToBuffer(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

export function createTelegramTextBridge(deps: {
  config: any;
  reportError: (category: string, error: unknown) => Promise<void>;
}) {
  let client: TelegramClient | null = null;
  let ready = false;
  let lockPath = '';
  let lockOwned = false;
  let pending: PendingTransfer | null = null;
  const maxBytes = Math.max(1024, Number(deps.config.tgMaxFileBytes) || 15 * 1024 * 1024);
  const timeoutMs = Math.max(10_000, Number(deps.config.tgTimeoutMs) || 5 * 60 * 1000);

  function releaseLock() {
    if (!lockOwned || !lockPath) return;
    try { fs.unlinkSync(lockPath); } catch {}
    lockOwned = false;
  }

  async function start() {
    if (!deps.config.tgEnabled) {
      console.log('[TG] Disabled; set TELEGRAM_ENABLED=true to enable.');
      return;
    }

    const apiId = Number(deps.config.tgApiId);
    const apiHash = String(deps.config.tgApiHash || '');
    const sessionFile = expandHome(String(deps.config.tgSessionFile || ''));
    const processorChat = String(deps.config.tgProcessorChat || '').trim();

    if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash || !sessionFile || !processorChat) {
      throw new Error('Telegram bridge configuration incomplete: set TG_API_ID, TG_API_HASH, TG_SESSION_FILE and TG_PROCESSOR_CHAT.');
    }
    if (!fs.existsSync(sessionFile)) {
      throw new Error('Telegram session file not found: ' + sessionFile);
    }

    lockPath = sessionFile + '.whatsappbot.lock';
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      lockOwned = true;
    } catch {
      throw new Error('Telegram session lock exists. Stop the other Telegram client or remove a stale lock only after confirming no client is using the session.');
    }

    process.once('exit', releaseLock);

    try {
      const sessionString = fs.readFileSync(sessionFile, 'utf8').trim();
      client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 0,
        autoReconnect: false,
      });
      await client.connect();
      if (!(await client.checkAuthorization())) {
        throw new Error('Telegram session is not authorized; authenticate it with the standalone Telegram client first.');
      }

      client.addEventHandler(async (event: any) => {
        const message = event.message;
        const transfer = pending;
        if (!transfer || !message || message.out) return;
        try {
          let responseText = '';
          if (typeof message.message === 'string' && message.message.trim()) {
            responseText = message.message;
          } else if (message.media && (message.media as any).document) {
            const downloaded = await client!.downloadMedia(message);
            if (!downloaded) throw new Error('Telegram returned a document but its contents could not be downloaded.');
            const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as any);
            if (buffer.length > maxBytes) throw new Error('Telegram response exceeds TG_MAX_FILE_BYTES (' + maxBytes + ' bytes).');
            try {
              responseText = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            } catch {
              throw new Error('Telegram returned a binary file. The response must be text or a text file.');
            }
            if (responseText.includes('\u0000')) throw new Error('Telegram returned a binary file. The response must be text or a text file.');
          } else {
            return;
          }

          pending = null;
          clearTimeout(transfer.timeout);
          const cleaned = cleanReturnedText(responseText);
          if (!cleaned.trim()) throw new Error('No text remained after removing the configured header and footer.');
          await transfer.sock.sendMessage(transfer.senderJid, { text: cleaned });
          console.log('[TG] Cleaned text response delivered to original sender; chars=' + cleaned.length);
        } catch (error) {
          pending = null;
          clearTimeout(transfer.timeout);
          console.error('[TG] Returned-response processing failed:', error instanceof Error ? error.message : String(error));
          try {
            await transfer.sock.sendMessage(transfer.senderJid, {
              text: 'Telegram response could not be cleaned: ' + (error instanceof Error ? error.message : String(error)),
            });
          } catch {}
          void deps.reportError('telegram-return-file', error);
        }
      }, new NewMessage({ chats: [processorChat] }));

      ready = true;
      console.log('[TG] Connected. Processor chat=' + processorChat);
    } catch (error) {
      ready = false;
      try { await client?.disconnect(); } catch {}
      client = null;
      releaseLock();
      throw error;
    }
  }

  async function processQuotedFile(sock: any, commandMessage: any, commandReply: (content: any) => Promise<void>) {
    if (!deps.config.tgEnabled || !ready || !client) {
      await commandReply({ text: 'Telegram file processor is unavailable. Check TELEGRAM_ENABLED and the Telegram startup log.' });
      return;
    }
    if (pending) {
      await commandReply({ text: 'A !tg file is already awaiting a Telegram response. Wait for it to finish before starting another.' });
      return;
    }

    const message = unwrapMessage(commandMessage?.message);
    const context = message?.extendedTextMessage?.contextInfo
      || message?.imageMessage?.contextInfo
      || message?.documentMessage?.contextInfo;
    const quoted = unwrapMessage(context?.quotedMessage);
    const fileTypes = ['documentMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage'];
    const quotedType = fileTypes.find(type => quoted?.[type]);
    const filePayload = quotedType ? quoted[quotedType] : null;

    if (!filePayload || !quotedType) {
      await commandReply({ text: 'Reply to any WhatsApp file or media attachment with !tg. The Telegram response must be plain text or a text file.' });
      return;
    }

    const advertisedSize = Number(filePayload.fileLength || 0);
    if (advertisedSize > maxBytes) {
      console.error('[TG] Input file rejected before download: size=' + advertisedSize + ' limit=' + maxBytes);
      await commandReply({ text: 'File exceeds the configured TG_MAX_FILE_BYTES limit (' + maxBytes + ' bytes).' });
      return;
    }

    const senderJid = String(context?.participant || commandMessage?.key?.remoteJid || '');
    const originalChatJid = String(commandMessage?.key?.remoteJid || '');
    if (!senderJid || !originalChatJid) {
      await commandReply({ text: 'Could not identify the original WhatsApp sender/chat.' });
      return;
    }

    const mimeType = String(filePayload.mimetype || 'application/octet-stream');
    const extension = ({ documentMessage: 'bin', imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg', stickerMessage: 'webp' } as Record<string, string>)[quotedType] || 'bin';
    const fileName = String(filePayload.fileName || ('whatsapp-input.' + extension)).replace(/[\\/\0]/g, '_').slice(0, 180) || 'whatsapp-input.bin';

    await commandReply({ text: 'Sending file to Telegram for processing. I will send the cleaned text to the original sender when the returned file arrives.' });

    let buffer: Buffer;
    try {
      const downloadType = quotedType.replace('Message', '') as 'document' | 'image' | 'video' | 'audio' | 'sticker';
      const stream = await downloadContentFromMessage(filePayload, downloadType);
      buffer = await streamToBuffer(stream as AsyncIterable<Uint8Array>);
    } catch (error) {
      await commandReply({ text: 'Could not download the replied-to file: ' + (error instanceof Error ? error.message : String(error)) });
      return;
    }

    if (buffer.length > maxBytes) {
      console.error('[TG] Input file rejected after download: size=' + buffer.length + ' limit=' + maxBytes);
      await commandReply({ text: 'File exceeds the configured TG_MAX_FILE_BYTES limit (' + maxBytes + ' bytes).' });
      return;
    }

    const transfer: PendingTransfer = {
      sock,
      senderJid: context?.participant ? senderJid : originalChatJid,
      originalChatJid,
      originalMessage: commandMessage,
      timeout: setTimeout(() => {
        if (pending === transfer) {
          pending = null;
          console.error('[TG] Timed out waiting for returned text file; transfer dropped.');
          void deps.reportError('telegram-timeout', new Error('No returned file received before TG_TIMEOUT_MS expired.'));
        }
      }, timeoutMs),
    };
    pending = transfer;

    try {
      await client.sendFile(deps.config.tgProcessorChat, {
        file: new CustomFile(fileName, buffer.length, '', buffer),
        caption: 'Process this uploaded file regardless of its format. Return the response as plain text in a Telegram message or as a text file. The WhatsApp bot will remove the specified header/footer from the response text.',
        forceDocument: true,
        workers: 1,
      });
      console.log('[TG] Input file sent to processor; name=' + fileName + ' bytes=' + buffer.length + ' mime=' + mimeType);
    } catch (error) {
      if (pending === transfer) pending = null;
      clearTimeout(transfer.timeout);
      console.error('[TG] Failed to send file to Telegram:', error instanceof Error ? error.message : String(error));
      await commandReply({ text: 'Failed to send the file to Telegram. Check the Telegram error log.' });
      void deps.reportError('telegram-send-file', error);
    }
  }

  return {
    start,
    processQuotedFile,
    isReady: () => ready,
  };
}
