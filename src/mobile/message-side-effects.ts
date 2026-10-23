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
    // Owner-issued commands can still continue through the command router.
    if (M?.key?.fromMe === true) {
      return false;
    }

    const isNewsletter =
      String(M?.key?.remoteJid || '').endsWith('@newsletter');

    if (isNewsletter) {
      const newsletterText =
        text.trim() ||
        `[Newsletter update] messageType=${Object.keys(message || {}).join(',') || 'unknown'}`;
      const name =
        M.pushName ||
        M.key.remoteJid ||
        'Newsletter';

      /*
       * Defer even the initial Discord method invocation until the current
       * WhatsApp handler has yielded. This keeps synchronous Discord-side
       * work out of the WhatsApp message callback, not merely its network
       * awaits.
       */
      setImmediate(() => {
        void deps.discord.fromNewsletter(
          sender,
          name,
          newsletterText,
        ).catch(error => {
          void deps.reportError(
            'discord-newsletter',
            error,
          );
        });
      });

      return true;
    }

    if (deps.discordTarget && chat === deps.discordTarget) {
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
      const name = M.pushName || 'Unknown';
      const messageId = M.key.id || undefined;
      const fromMe = M.key.fromMe === true;
      const waSender =
        M.key.participant ||
        M.key.remoteJid ||
        '';

      setImmediate(() => {
        void deps.discord.fromWA(
          waSender,
          name,
          discordText,
          messageId,
          fromMe,
        ).catch(error => {
          void deps.reportError(
            'discord-bridge',
            error,
          );
        });
      });
    }

    return false;
  }

  return {
    dispatchScannerForMessage,
    dispatchDiscordForMessage,
  };
}
