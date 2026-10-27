import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
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
  const lines = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  // Locate separator lines consisting only of repeated equals signs.
  const separators: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*={10,}\s*$/.test(lines[i])) {
      separators.push(i);
    }
  }

  if (separators.length >= 2) {
    // Keep only the text between the first two separators.
    return lines
      .slice(separators[0] + 1, separators[1])
      .join('\n')
      .trim();
  }

  // Fallback for responses with only one separator.
  if (separators.length === 1) {
    return lines.slice(separators[0] + 1).join('\n').trim();
  }

  // No separator found: leave the response intact rather than deleting content.
  return lines.join('\n').trim();
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
        connectionRetries: 5,
        autoReconnect: true,
      });
      await client.connect();
      if (!(await client.checkAuthorization())) {
        throw new Error('Telegram session is not authorized; authenticate it with the standalone Telegram client first.');
      }

      client.addEventHandler(async (event: any) => {
        const message = event.message;
        const transfer = pending;
        if (!message) return;

        const isDocument = Boolean(message.media && (message.media as any).document);
        const text = typeof message.message === 'string' ? message.message.trim() : '';

        console.log(
          '[TG] Processor update:',
          'chatId=' + String(message.chatId ?? 'unknown'),
          'out=' + String(message.out),
          'document=' + String(isDocument),
          'textChars=' + String(text.length),
          'pending=' + String(Boolean(transfer))
        );

        if (!transfer || message.out) return;

        // Never silently discard short processor responses: they may contain errors.
        // Forward the response to WhatsApp. Keep waiting for the result document
        // for ordinary status messages, but finish the transfer on an error response.
        if (!isDocument && text.length > 0 && text.length < 80) {
          console.log('[TG] Short processor response:', text);

          const looksLikeError =
            /\\b(error|failed|WRONG|PASSWORD|HWID|failure|invalid|exception|denied|rejected|unsupported|unable|cannot|could not|timed out|timeout)\\b/i.test(text);

          try {
            const botJid = String(transfer.sock?.user?.id || '').replace(/:\d+@/, '@');
            if (!botJid) {
              console.error('[TG] Cannot forward status: bot WhatsApp JID unavailable.');
            } else {
              await transfer.sock.sendMessage(botJid, {
                text: '[MD Tool] ' + text,
              });
            }
            console.log('[TG] Short processor response forwarded to WhatsApp.');

            if (looksLikeError) {
              if (pending === transfer) pending = null;
              clearTimeout(transfer.timeout);
              console.error('[TG] Processor error received; transfer closed.');
            } else {
              console.log('[TG] Status forwarded; still waiting for result document.');
            }
          } catch (error) {
            console.error(
              '[TG] Could not forward short processor response:',
              error instanceof Error ? error.message : String(error)
            );
          }

          return;
        }

        if (!isDocument && !text) {
          console.log('[TG] Empty non-document update; waiting for result document.');
          return;
        }

        try {
          let responseText = '';

          if (isDocument) {
            const downloaded = await client!.downloadMedia(message);
            if (!downloaded) {
              throw new Error('Telegram returned a document but its contents could not be downloaded.');
            }

            const buffer = Buffer.isBuffer(downloaded)
              ? downloaded
              : Buffer.from(downloaded as any);

            if (buffer.length > maxBytes) {
              throw new Error('Telegram response exceeds TG_MAX_FILE_BYTES (' + maxBytes + ' bytes).');
            }

            try {
              responseText = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            } catch {
              throw new Error('Telegram returned a binary file. The response must be text or a text file.');
            }

            if (responseText.includes('\u0000')) {
              throw new Error('Telegram returned a binary file. The response must be text or a text file.');
            }
          } else {
            responseText = text;
          }

          const cleaned = cleanReturnedText(responseText);
          if (!cleaned.trim()) {
            throw new Error('No text remained after removing the configured header and footer.');
          }

          // Clear only after a usable response has been extracted.
          if (pending === transfer) pending = null;
          clearTimeout(transfer.timeout);

          await transfer.sock.sendMessage(
            transfer.originalChatJid,
            { text: 'ℹ️ M_D TOOL\n━━━━━━━━━━━━━━━━\n' + cleaned },
            { quoted: transfer.originalMessage }
          );
          console.log('[TG] Cleaned text response delivered to original sender; chars=' + cleaned.length);
        } catch (error) {
          if (pending === transfer) pending = null;
          clearTimeout(transfer.timeout);

          console.error(
            '[TG] Returned-response processing failed:',
            error instanceof Error ? error.message : String(error)
          );

          try {
            await transfer.sock.sendMessage(transfer.senderJid, {
              text: 'Telegram response could not be processed: ' +
                (error instanceof Error ? error.message : String(error)),
            });
          } catch (sendError) {
            console.error(
              '[TG] Could not notify WhatsApp sender:',
              sendError instanceof Error ? sendError.message : String(sendError)
            );
          }

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

  async function processQuotedFile(
    sock: any,
    commandMessage: any,
    commandReply: (content: any) => Promise<void>,
    textInput = '',
  ) {
    if (!deps.config.tgEnabled || !ready || !client) {
      await commandReply({ text: 'Telegram file processor is unavailable. Check TELEGRAM_ENABLED and the Telegram startup log.' });
      return;
    }
    if (pending) {
      await commandReply({ text: 'A !tg file is already awaiting a Telegram response. Wait for it to finish before starting another.' });
      return;
    }

    const inputText = textInput.trim();

    // Resolve the quoted message first. Media always takes priority over text.
    const message = unwrapMessage(commandMessage?.message);
    const context = message?.extendedTextMessage?.contextInfo
      || message?.imageMessage?.contextInfo
      || message?.videoMessage?.contextInfo
      || message?.audioMessage?.contextInfo
      || message?.documentMessage?.contextInfo
      || message?.stickerMessage?.contextInfo;

    const quoted = unwrapMessage(context?.quotedMessage);
    const fileTypes = [
      'documentMessage',
      'imageMessage',
      'videoMessage',
      'audioMessage',
      'stickerMessage',
    ];
    const quotedType = fileTypes.find(type => quoted?.[type]);
    const filePayload = quotedType ? quoted[quotedType] : null;

    // Only send text directly when no supported file is being quoted.
    if (inputText && !filePayload) {
      const chatJid = String(commandMessage?.key?.remoteJid || '');
      const senderJid = String(
        commandMessage?.key?.participant || chatJid
      );

      if (!chatJid || !senderJid) {
        await commandReply({ text: 'Could not identify the WhatsApp sender.' });
        return;
      }

      const transfer: PendingTransfer = {
        sock,
        senderJid,
        originalChatJid: chatJid,
        originalMessage: commandMessage,
        timeout: setTimeout(() => {
          if (pending === transfer) {
            pending = null;
            console.error('[TG] Timed out waiting for text-input result.');
            void deps.reportError(
              'telegram-timeout',
              new Error('No returned result received before TG_TIMEOUT_MS expired.')
            );
          }
        }, timeoutMs),
      };

      pending = transfer;

      try {
        await commandReply({
          text: 'Sending your text  for processing. Waiting for the result...',
        });

        await client.sendMessage(deps.config.tgProcessorChat, {
          message: inputText,
        });

        console.log('[TG] Text sent to processor; chars=' + inputText.length);
      } catch (error) {
        if (pending === transfer) pending = null;
        clearTimeout(transfer.timeout);

        console.error(
          '[TG] Failed to send text to Telegram:',
          error instanceof Error ? error.message : String(error)
        );

        await commandReply({
          text: 'Failed to send text to Telegram: ' +
            (error instanceof Error ? error.message : String(error)),
        });

        void deps.reportError('telegram-send-text', error);
      }

      return;
    }

    // If !tg has no typed text and the quoted message is plain text,
    // forward that quoted text through the existing Telegram text flow.
    if (!filePayload && quoted) {
      const quotedText = String(
        quoted.conversation
        || quoted.extendedTextMessage?.text
        || quoted.imageMessage?.caption
        || quoted.videoMessage?.caption
        || quoted.documentMessage?.caption
        || quoted.audioMessage?.caption
        || ''
      ).trim();

      if (quotedText) {
        await processQuotedFile(
          sock,
          commandMessage,
          commandReply,
          quotedText,
        );
        return;
      }
    }

    if (!filePayload || !quotedType) {
      await commandReply({
        text: 'Use !tg your text, or reply to a WhatsApp text message or file with !tg.',
      });
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

   // await commandReply({ text: '' });

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
      senderJid: originalChatJid,
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
        caption: inputText || undefined,
        forceDocument: true,
        workers: 1,
      });
      console.log(
        '[TG] Original file sent' + (inputText ? ' with instruction caption' : ' without caption') +
        '; name=' + fileName + ' bytes=' + buffer.length + ' mime=' + mimeType
      );
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
