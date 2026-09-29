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
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

    this.readyPromise = new Promise<void>(resolve => {
      this.readyResolve = resolve;
    });

    this.client.on('ready', () => {
      console.log('[DISCORD] connected');
      this.readyResolve?.();
      this.readyResolve = null;
    });
    this.client.on('messageCreate', async (m: Message) => {
      try {
        if (m.author.bot || m.channelId !== config.discordChannelId || !m.content.startsWith(config.prefix)) return;
        const [cmd, ...rest] = m.content.slice(config.prefix.length).trim().split(/\s+/);
        if (cmd.toLowerCase() !== 'wa') return;
        if (!config.discordAllowed.includes(m.author.id)) return void m.reply('Not authorized.');
        if (!config.discordTarget) return void m.reply('DISCORD_WA_TARGET is not configured.');
        const text = rest.join(' ').trim();
        if (!text) return void m.reply('Usage: !wa <message>');
        await this.sendWA(config.discordTarget, '[Discord] ' + m.author.displayName + ': ' + text);
        appendHistory({ ts: Date.now(), direction: 'discord', whatsappJid: config.discordTarget, discordUserId: m.author.id, discordUser: m.author.displayName, discordChannelId: m.channelId, text });
        await m.react('✅');
      } catch (e) { console.error('[DISCORD] message error:', e); }
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
    appendHistory({ ts: Date.now(), direction: 'whatsapp', whatsappJid: sender, whatsappSender: name, discordChannelId: config.discordChannelId, text });
  }
}
