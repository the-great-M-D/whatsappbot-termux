import type { DiscordBridge } from './discord.js';

export type MessageSideEffectDeps = {
  scanAndNotify: (
    text: string,
    source: string,
    chat: string,
    sender: string,
  ) => void;
  discord: DiscordBridge;
  discordTarget: string;
  reportError: (
    category: string,
    error: unknown,
  ) => Promise<void>;
};

export function createMessageSideEffects(
  deps: MessageSideEffectDeps,
) {
  function dispatchScannerForMessage(
    M: any,
    scanMessage: any,
    text: string,
  ) {
    if (text) {
      deps.scanAndNotify(
        text,
        'WhatsApp',
        M.key.remoteJid || '',
        M.key.participant ||
          M.key.remoteJid ||
          '',
      );
    }

    const contextInfo =
      scanMessage?.extendedTextMessage?.contextInfo;

    const quotedMessage =
      contextInfo?.quotedMessage;

    const quotedText =
      quotedMessage?.conversation ||
      quotedMessage?.extendedTextMessage?.text ||
      quotedMessage?.imageMessage?.caption ||
      quotedMessage?.videoMessage?.caption ||
      '';

    if (quotedText.trim()) {
      deps.scanAndNotify(
        quotedText,
        'WhatsApp reply/quoted message',
        M.key.remoteJid || '',
        M.key.participant ||
          M.key.remoteJid ||
          '',
      );
    }
  }

  function dispatchDiscordForMessage(
    M: any,
    message: any,
    text: string,
  ): boolean {
    const isNewsletter =
      String(M.key.remoteJid || '').endsWith('@newsletter');

    if (isNewsletter) {
      void deps.discord.fromNewsletter(
        M.key.participant ||
          M.key.remoteJid ||
          '',
        M.pushName ||
          M.key.remoteJid ||
          'Newsletter',
        text,
      ).catch(error => {
        void deps.reportError(
          'discord-newsletter',
          error,
        );
      });

      return true;
    }

    if (
      deps.discordTarget &&
      M.key.remoteJid === deps.discordTarget
    ) {
      const quoted =
        message.extendedTextMessage?.contextInfo
          ?.quotedMessage;

      const quotedText =
        quoted?.conversation ||
        quoted?.extendedTextMessage?.text ||
        quoted?.imageMessage?.caption ||
        quoted?.videoMessage?.caption ||
        '';

      const discordText =
        quotedText.trim()
          ? `↩️ Reply to: ${quotedText.slice(0, 700)}\\n${text}`
          : text;

      void deps.discord.fromWA(
        M.key.participant ||
          M.key.remoteJid ||
          '',
        M.pushName || 'Unknown',
        discordText,
        M.key.id || undefined,
        M.key.fromMe === true,
      ).catch(error => {
        void deps.reportError(
          'discord-bridge',
          error,
        );
      });
    }

    return false;
  }

  return {
    dispatchScannerForMessage,
    dispatchDiscordForMessage,
  };
}
