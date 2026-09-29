import { Client, GatewayIntentBits, Message } from 'discord.js';
import chalk from 'chalk';
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

const digits = (value: string) => String(value || '').replace(/[^0-9]/g, '');

const dlog = (label: string, message: string) =>
  console.log(chalk.cyan('[DISCORD]'), chalk.bold(label), message);

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

  async webhook(text: string) {
    if (!config.discordWebhookUrl || !text.trim()) return false;

    try {
      const response = await fetch(config.discordWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'WhatsApp Bot',
          content: text.slice(0, 1900),
        }),
      });

      if (!response.ok) {
        console.error(
          chalk.red('[DISCORD]'),
          chalk.bold('WEBHOOK ERROR'),
          chalk.yellow(`HTTP ${response.status}:`),
          await response.text(),
        );
        return false;
      }

      dlog(chalk.green('WEBHOOK'), 'sent');
      return true;
    } catch (error) {
      console.error(chalk.red('[DISCORD]'), chalk.bold('WEBHOOK ERROR'), error);
      return false;
    }
  }

  async start() {
    if (!config.discordToken) {
      console.log(chalk.yellow('[DISCORD]'), chalk.bold('DISABLED'), chalk.gray('(no DISCORD_TOKEN)'));
      return;
    }

    if (this.client) return;

    console.log(chalk.cyan('[DISCORD]'), chalk.bold('STARTING'), chalk.gray('connecting to Discord...'));

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.readyPromise = new Promise<void>(resolve => {
      this.readyResolve = resolve;
    });

    this.client.on('ready', () => {
      console.log(chalk.green('[DISCORD]'), chalk.bold('CONNECTED'));
      this.readyResolve?.();
      this.readyResolve = null;
    });

    this.client.on('messageCreate', async (m: Message) => {
      try {
        if (m.author.bot || m.channelId !== config.discordChannelId || !m.content.startsWith(config.prefix)) return;

        const [cmd, ...rest] = m.content.slice(config.prefix.length).trim().split(/\s+/);
        if (cmd.toLowerCase() !== 'wa') return;

        if (!config.discordAllowed.includes(m.author.id)) {
          console.log(
            chalk.red('[DISCORD]'),
            chalk.bold('DENIED'),
            chalk.gray(`!wa from ${m.author.tag} (${m.author.id})`),
          );
          return void m.reply('Not authorized.');
        }

        if (!config.discordTarget) return void m.reply('DISCORD_WA_TARGET is not configured.');

        const text = rest.join(' ').trim();
        if (!text) return void m.reply('Usage: !wa <message>');

        console.log(
          chalk.blue('[DISCORD]'),
          chalk.bold('!WA'),
          chalk.white(`from ${m.author.displayName}:`),
          chalk.green(text),
        );

        // Send only the command text to WhatsApp.
        // The Discord username is kept in history, not injected into the WA message.
        await this.sendWA(
          config.discordTarget,
          text,
        );

        appendHistory({
          ts: Date.now(),
          direction: 'discord',
          whatsappJid: config.discordTarget,
          discordUserId: m.author.id,
          discordUser: m.author.displayName,
          discordChannelId: m.channelId,
          text,
        });

        await m.react('✅');
        dlog(chalk.green('!WA OK'), 'sent to WhatsApp');
      } catch (e) {
        console.error(chalk.red('[DISCORD]'), chalk.bold('MESSAGE ERROR'), e);
      }
    });

    await this.client.login(config.discordToken);
  }

  async scanner(matches: DiscordScannerMatch[]) {
    if (!matches.length) return;

    console.log(
      chalk.magenta('[DISCORD]'),
      chalk.bold('SCANNER'),
      chalk.white(`${matches.length} match(es) -> Discord`),
    );

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

    if (matches.length > 25) lines.push(`...and ${matches.length - 25} more`);

    const text = lines.join('\n');

    if (config.discordWebhookUrl) {
      await this.webhook(text);
      appendHistory({ ts: Date.now(), direction: 'scanner', discordChannelId: config.discordChannelId, text });
      return;
    }

    if (!this.client || !config.discordChannelId) return;

    if (!this.client.isReady()) {
      const ready = await this.waitUntilReady();
      if (!ready) {
        console.error(chalk.red('[DISCORD]'), chalk.bold('SCANNER SKIPPED'), chalk.gray('Discord client is not ready.'));
        return;
      }
    }

    const ch = await this.client.channels.fetch(config.discordChannelId);
    if (!ch || !ch.isTextBased() || !('send' in ch)) return;
    await ch.send(text.slice(0, 1900));

    appendHistory({
      ts: Date.now(),
      direction: 'scanner',
      discordChannelId: config.discordChannelId,
      text,
    });

    dlog(chalk.magenta('SCANNER OK'), 'sent');
  }

  async fromWA(sender: string, name: string, text: string) {
    // Do not echo messages sent by the WhatsApp bot itself back into Discord.
    // This prevents !wa from producing a Discord command + webhook echo pair.
    const botNumber = digits(config.phone);
    const senderNumber = digits(sender);

    if (botNumber && senderNumber && botNumber === senderNumber) {
      console.log(chalk.gray('[DISCORD]'), chalk.bold('SUPPRESSED'), chalk.gray('bot-originated WhatsApp echo'));
      return;
    }

    if (config.discordWebhookUrl) {
      await this.webhook('[WhatsApp] ' + name + ': ' + text);
      appendHistory({
        ts: Date.now(),
        direction: 'whatsapp',
        whatsappJid: sender,
        whatsappSender: name,
        discordChannelId: config.discordChannelId,
        text,
      });
      dlog(chalk.green('WA -> WEBHOOK'), chalk.white(name));
      return;
    }

    if (!this.client || !config.discordChannelId || (config.discordTarget && sender === '')) return;

    if (!this.client.isReady()) {
      const ready = await this.waitUntilReady();
      if (!ready) {
        console.error(chalk.red('[DISCORD]'), chalk.bold('WA FORWARD SKIPPED'), chalk.gray('Discord client is not ready.'));
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

    dlog(chalk.green('WA -> DISCORD'), chalk.white(name));
  }
}
