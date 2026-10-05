import { Worker } from 'node:worker_threads';
import chalk from 'chalk';
import type { DiscordBridge } from './discord.js';

export type ScannerResult = {
  id: number;
  ok: boolean;
  fresh?: Array<{
    type: string;
    value: string;
    source: string;
    chat: string;
    sender: string;
    path: string;
  }>;
  error?: string;
};

export type ScannerServiceDeps = {
  getSocket: () => any;
  owners: string[];
  discord: DiscordBridge;
};

export function createScannerService(
  deps: ScannerServiceDeps,
) {
  let enabled = true;
  let jobId = 0;

  const chatNames = new Map<string, string>();

  async function chatDisplayName(jid: string) {
    if (!jid) {
      return 'unknown';
    }

    const cached = chatNames.get(jid);

    if (cached) {
      return cached;
    }

    const currentSock = deps.getSocket();

    if (jid.endsWith('@g.us') && currentSock) {
      try {
        const meta = await currentSock.groupMetadata(jid);
        const name = meta?.subject || jid;
        chatNames.set(jid, name);
        return name;
      } catch {
        return jid;
      }
    }

    chatNames.set(jid, jid);
    return jid;
  }

  const worker = new Worker(
    new URL('./scanner-worker.js', import.meta.url),
  );

  async function notifyScannerResult(result: ScannerResult) {
    const fresh = result.fresh || [];

    if (!result.ok) {
      console.error(
        chalk.gray('[SCANNER] worker failed:'),
        result.error || 'unknown error',
      );
      return;
    }

    const currentSock = deps.getSocket();

    if (!fresh.length || !currentSock) {
      return;
    }

    const chatName =
      await chatDisplayName(fresh[0]?.chat || '');

    const lines = [
      `[SCANNER] ${fresh.length} new match` +
        `${fresh.length === 1 ? '' : 'es'} (${fresh[0]?.source || 'scan'})`,
    ];

    for (const match of fresh.slice(0, 25)) {
      const parts = [
        `${match.type}: ${match.value}`,
        match.path ? `path=${match.path}` : '',
        `sender=${match.sender || 'unknown'}`,
        `chat=${chatName}`,
      ].filter(Boolean);

      lines.push(parts.join(' | '));
    }

    if (fresh.length > 25) {
      lines.push(
        `...and ${fresh.length - 25} more`,
      );
    }

    const notificationText =
      lines.join('\n').slice(0, 6000);

    /*
     * Scanner notifications are downstream side effects. Do not serialize
     * owner delivery or Discord delivery behind one another: a slow network
     * destination must never delay the next scanner result.
     */
    const ownerNotifications = deps.owners.map(owner =>
      currentSock
        .sendMessage(owner, {
          text: notificationText,
        })
        .catch((error: unknown) => {
          console.error(
            chalk.gray('[SCANNER] owner notification failed:'),
            error instanceof Error
              ? error.stack || error.message
              : String(error),
          );
        }),
    );

    void Promise.allSettled(ownerNotifications);

    const discordMatches = fresh.map(match => ({
      type: match.type,
      value: match.value,
      source: match.source,
      chat: chatName,
      sender: match.sender,
      path: match.path,
    }));

    void deps.discord.scanner(discordMatches).catch(error => {
      console.error(
        chalk.gray('[SCANNER] Discord notification failed:'),
        error instanceof Error
          ? error.stack || error.message
          : String(error),
      );
    });
  }

  worker.on('message', (result: ScannerResult) => {
    void notifyScannerResult(result).catch(error => {
      console.error(
        chalk.gray('[SCANNER] notification handler failed:'),
        error instanceof Error
          ? error.stack || error.message
          : String(error),
      );
    });
  });

  worker.on('error', error => {
    console.error(
      chalk.gray('[SCANNER] worker error:'),
      error instanceof Error
        ? error.stack || error.message
        : String(error),
    );
  });

  worker.on('exit', code => {
    if (code !== 0) {
      console.error(
        chalk.gray(`[SCANNER] worker exited with code ${code}`),
      );
    }
  });

  function scanAndNotify(
    text: string,
    source: string,
    chat: string,
    sender: string,
  ) {
    if (!enabled || !text.trim()) {
      return;
    }

    worker.postMessage({
      id: ++jobId,
      text,
      source,
      chat,
      sender,
    });
  }

  return {
    scanAndNotify,
    isEnabled: () => enabled,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    worker,
  };
}
