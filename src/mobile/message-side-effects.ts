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
  /*
   * WhatsApp has two different identities here:
   *   remoteJid  = the chat/conversation
   *   participant = the person who sent the message inside that chat
   *
   * In groups, remoteJid must remain the @g.us JID. A participant may be
   * an @s.whatsapp.net or @lid JID. Never substitute participant for the
   * chat JID; doing so makes scanner results look like they came from a
   * private chat and breaks group attribution.
   */
  function messageContext(M: any) {
    const remoteJid = String(M?.key?.remoteJid || '');
    const participant = String(
      M?.key?.participant ||
      M?.message?.extendedTextMessage?.contextInfo?.participant ||
      M?.message?.imageMessage?.contextInfo?.participant ||
      M?.message?.videoMessage?.contextInfo?.participant ||
      remoteJid ||
      '',
    );

    return {
      chat: remoteJid,
      sender: participant,
      isGroup: remoteJid.endsWith('@g.us'),
    };
  }

  function quotedContext(M: any, scanMessage: any) {
    const context =
      scanMessage?.extendedTextMessage?.contextInfo ||
      scanMessage?.imageMessage?.contextInfo ||
      scanMessage?.videoMessage?.contextInfo ||
      scanMessage?.documentMessage?.contextInfo ||
      {};

    return {
      quotedMessage: context.quotedMessage,
      quotedSender: String(
        context.participant ||
        context.remoteJid ||
        M?.key?.participant ||
        M?.key?.remoteJid ||
        '',
      ),
    };
  }
  function dispatchScannerForMessage(
    M: any,
    scanMessage: any,
    text: string,
  ) {
    /*
     * Newsletters are forwarded to Discord, but must never enter
     * the credential/IP/proxy scanner pipeline.
     */
    const { chat, sender } = messageContext(M);
    const remoteJid = chat;

    // Never rescan messages sent by the bot itself. Scanner notifications
    // contain the very IPs/URLs they report and would otherwise feed back
    // into the scanner pipeline.
    if (M?.key?.fromMe === true) {
      return;
    }

    if (remoteJid.endsWith('@newsletter')) {
      return;
    }

    if (text) {
      deps.scanAndNotify(
        text,
        'WhatsApp',
        chat,
        sender,
      );
    }

    const { quotedMessage, quotedSender } =
      quotedContext(M, scanMessage);

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
        chat,
        quotedSender,
      );
    }
  }

  function dispatchDiscordForMessage(
    M: any,
    message: any,
    text: string,
  ): boolean {
    const { chat, sender } = messageContext(M);
    // Messages sent by the bot must never be forwarded back to Discord.
    // They still return false so owner-issued !commands can continue
    // through the normal command router.
    if (M?.key?.fromMe === true) {
      return false;
    }

    const isNewsletter =
      String(M.key.remoteJid || '').endsWith('@newsletter');

    if (isNewsletter) {
      /*
       * Forward newsletter updates regardless of whether they contain
       * conversation text. The forwarding call is detached, so Discord
       * network latency can never hold up WhatsApp reception.
       */
      const newsletterText =
        text.trim() ||
        `[Newsletter update] messageType=${Object.keys(message || {}).join(',') || 'unknown'}`;

      void deps.discord.fromNewsletter(
        sender,
        M.pushName ||
          M.key.remoteJid ||
          'Newsletter',
        newsletterText,
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
      chat === deps.discordTarget
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
          ? `↩️ Reply to: ${quotedText.slice(0, 700)}\n${text}`
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
