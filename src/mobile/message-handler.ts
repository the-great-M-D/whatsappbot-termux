import makeWASocket from '@whiskeysockets/baileys';
import chalk from 'chalk';
import {
  extractMessageText,
  unwrapMessageContent,
} from './message-utils.js';

export type WhatsAppMessageHandlerDeps = {
  config: any;
  sideEffects: any;
  decrypt: any;
  commandRouter: any;
  info: any;
  error: any;
  reportError: (
    category: string,
    error: unknown,
  ) => Promise<void>;
  getMessageCutoff: () => {
    ready: boolean;
    unix: number;
  };
};

export function createWhatsAppMessageHandler(
  deps: WhatsAppMessageHandlerDeps,
) {
  async function handleWhatsAppMessage(
    currentSock: ReturnType<typeof makeWASocket>,
    M: any,
  ) {
    try {
      if (deps.config.ignoreOfflineMessages) {
        const cutoff = deps.getMessageCutoff();

        /*
         * Backlog filtering happens before message type inspection,
         * extraction, scanner dispatch, logging, command work, or Discord.
         */
        if (!cutoff.ready) {
          return;
        }

        const rawTimestamp = M.messageTimestamp;
        const messageTimestamp =
          typeof rawTimestamp === 'number'
            ? rawTimestamp
            : Number(rawTimestamp?.low ?? rawTimestamp ?? 0);

        if (
          messageTimestamp > 0 &&
          messageTimestamp < cutoff.unix
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
          `type=${Object.keys(M.message || {}).join(',') || 'none'}`,
        ),
      );

      const message = M.message;
      const scanMessage = unwrapMessageContent(message);
      const text = extractMessageText(scanMessage);

      /*
       * Discord is a detached side effect and starts immediately after
       * reception/text extraction. It is never awaited here.
       */
      deps.sideEffects.dispatchDiscordForMessage(
        M,
        message,
        text,
      );

      const commandReply = async (content: any) => {
        let payload =
          typeof content === 'string'
            ? { text: content }
            : { ...content };

        if (
          typeof payload.text === 'string' &&
          !payload.text.includes('╭━━━')
        ) {
          payload.text = deps.info(
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

      /* Scanner is a separate fire-and-forget subsystem. */
      deps.sideEffects.dispatchScannerForMessage(
        M,
        scanMessage,
        text,
      );

      /*
       * !decrypt can operate on a directly received .hat/.hc document
       * or a reply to one. Documents do not necessarily contain text.
       */
      if (
        text.trim().toLowerCase() ===
        `${deps.config.prefix}decrypt`
      ) {
        const hat =
          deps.decrypt.findHatDocument(M.message) ||
          deps.decrypt.findQuotedHatDocument(M.message);

        const hc =
          deps.decrypt.findHcDocument(M.message) ||
          deps.decrypt.findQuotedHcDocument(M.message);

        let decrypted = false;

        if (hat) {
          decrypted = await deps.decrypt.decryptHatFromMessage(
            currentSock,
            M,
          );
          deps.decrypt.logDecrypt(
            'decrypt-hat',
            M.key.remoteJid || '',
            M.key.participant || M.key.remoteJid || '',
            decrypted,
          );
        } else if (hc) {
          decrypted = await deps.decrypt.decryptHcFromMessage(
            currentSock,
            M,
          );
          deps.decrypt.logDecrypt(
            'decrypt-hc',
            M.key.remoteJid || '',
            M.key.participant || M.key.remoteJid || '',
            decrypted,
          );
        }

        if (!decrypted) {
          await commandReply({
            text: deps.error(
              '🔐 DECRYPT',
              [
                'No .hat or .hc document found.',
                `Reply to a .hat or .hc file with ${deps.config.prefix}decrypt.`,
              ],
            ),
          });
        }

        return;
      }

      if (!text) {
        return;
      }

      /* Self-generated non-command messages never enter command routing. */
      if (
        M.key.fromMe === true &&
        !text.trim().startsWith(deps.config.prefix)
      ) {
        return;
      }

      console.log(
        chalk.magenta(
          `[CMD] text=${JSON.stringify(text)} ` +
          `prefix=${JSON.stringify(deps.config.prefix)}`,
        ),
      );

      await deps.commandRouter(
        currentSock,
        M,
        message,
        text,
        commandReply,
      );
    } catch (error) {
      await deps.reportError(
        'message-handler',
        error,
      );
    }
  }

  return handleWhatsAppMessage;
}
