import { Client, GatewayIntentBits, Message } from 'discord.js';
import { appendHistory } from './state.js';
import { config } from './config.js';

export type DiscordScannerMatch = {
  type: string;
  value: string;
  source: string;
  chat: string;
  sender: string;
  path?: string;
};

export class DiscordBridge {
  client: Client | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  constructor(private sendWA: (jid: string, text: string) => Promise<void>) {}

  private async waitUntilReady(timeoutMs = 15000): Promise<boolean> {
    if (this.client?.isReady()) return true;
    if (!this.readyPromise) return false;

    await Promise.race([
      this.readyPromise,
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);

    return this.client?.isReady() === true;
  }

  async start() {
    if (!config.discordToken) return console.log('[DISCORD] disabled (no DISCORD_TOKEN)');
    if (this.client) return;

    // Only request the non-privileged intent needed for Discord server/channel access.
    // MessageContent is intentionally not requested because it is a privileged intent.
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });

    this.readyPromise = new Promise<void>(resolve => {
      this.readyResolve = resolve;
    });

    this.client.on('ready', () => {
      console.log('[DISCORD] connected');
      this.readyResolve?.();
      this.readyResolve = null;
    });

    await this.client.login(config.discordToken);
  }

  async scanner(matches: DiscordScannerMatch[]) {
    if (!matches.length || !this.client || !config.discordChannelId) return;

    if (!this.client.isReady()) {
      const ready = await this.waitUntilReady();
      if (!ready) {
        console.error('[DISCORD] scanner skipped: Discord client is not ready.');
        return;
      }
    }

    const ch = await this.client.channels.fetch(config.discordChannelId);
    if (!ch || !ch.isTextBased() || !('send' in ch)) return;

    const lines = ['[SCANNER] New matches', ''];

    for (const match of matches.slice(0, 25)) {
      lines.push(
        [
          `${match.type}: \`${match.value}\``,
          match.path ? `path=${match.path}` : '',
          `source=${match.source}`,
          `sender=${match.sender || 'unknown'}`,
          `chat=${match.chat || 'unknown'}`,
        ].filter(Boolean).join(' | '),
      );
    }

    if (matches.length > 25) {
      lines.push(`...and ${matches.length - 25} more`);
    }

    await ch.send(lines.join('\n').slice(0, 1900));

    appendHistory({
      ts: Date.now(),
      direction: 'scanner',
      discordChannelId: config.discordChannelId,
      text: lines.join('\n'),
    });
  }

  async fromWA(sender: string, name: string, text: string) {
    if (!this.client || !config.discordChannelId || (config.discordTarget && sender === '')) return;

    if (!this.client.isReady()) {
      const ready = await this.waitUntilReady();
      if (!ready) {
        console.error('[DISCORD] WhatsApp forward skipped: Discord client is not ready.');
        return;
      }
    }

    const ch = await this.client.channels.fetch(config.discordChannelId);
    if (!ch || !ch.isTextBased() || !('send' in ch)) return;
    await ch.send('[WhatsApp] ' + name + ': ' + text);
    appendHistory({
      ts: Date.now(),
      direction: 'whatsapp',
      whatsappJid: sender,
      whatsappSender: name,
      discordChannelId: config.discordChannelId,
      text,
    });
  }
}
