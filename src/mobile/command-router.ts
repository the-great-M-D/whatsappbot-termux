import type { DiscordBridge } from './deps.discord.js';

export type CommandRouterDeps = {
  config: any;
  info: (...args: any[]) => string;
  success: (...args: any[]) => string;
  warning: (...args: any[]) => string;
  error: (...args: any[]) => string;
  box: (...args: any[]) => string;
  isCommandAuthorized: (M: any) => boolean;
  decrypt: any;
  scanner: any;
  discord: DiscordBridge;
  configCommand: (M: any, args: string[]) => Promise<any> | any;
  dev: (M: any, args: string[]) => Promise<any> | any;
  moderate: (
    sock: any,
    M: any,
    command: string,
    args: string,
  ) => Promise<any> | any;
  readHistory: (limit?: number) => string[];
  readErrors: (limit?: number) => string[];
  clearErrors: () => void;
  getStatus: () => {
    deps.getStatus().waState: string;
    deps.getStatus().pairing: boolean;
    deps.getStatus().reconnectAttempt: number;
    deps.getStatus().lastDisconnectCode: number | null;
    deps.getStatus().lastDisconnectReason: string;
  };
  archiveAuth: () => string | null;
  clearReconnectTimer: () => void;
  setSocket: (value: any) => void;
  sleep: (ms: number) => Promise<void>;
  connect: () => Promise<void>;
  resetReconnectState: () => void;
  uptime: () => string;
  reportError: (category: string, error: unknown) => Promise<void>;
};

export function createCommandRouter(deps: CommandRouterDeps) {
  return async function route(
    currentSock: any,
    M: any,
    message: any,
    text: string,
    commandReply: (content: any) => Promise<void>,
  ): Promise<void> {
                  console.log(
                    chalk.magenta(
                      `[CMD] text=${JSON.stringify(text)} ` +
                      `prefix=${JSON.stringify(deps.config.prefix)}`
                    )
                  );
      
                  /*
                   * Mute enforcement happens before
                   * command processing.
                   */
                  const muted =
                    await enforceMute(
                      currentSock,
                      M,
                    );
      
                  if (muted) {
                    return;
                  }
      
                  /*
                   * Discord is a separate side-effect subsystem.
                   * Its network I/O is always detached from reception.
                   */
                  if (
                    sideEffects.dispatchDiscordForMessage(
                      M,
                      message,
                      text,
                    )
                  ) {
                    return;
                  }

  /*
                   * Commands.
                   */
                  if (
                    !text.startsWith(
                      deps.config.prefix,
                    )
                  ) {
                    return;
                  }
      
                  const body =
                    text.slice(
                      deps.config.prefix.length,
                    ).trim();
      
                  if (!body) {
                    return;
                  }
      
                  const parts =
                    body.split(/\s+/);
      
                  const command =
                    (
                      parts.shift() ||
                      ''
                    ).toLowerCase();
      
                  const args = parts;
      
                  /*
                   * Every command is owner-only.
                   * Non-owners are ignored silently, so the
                   * bot does not reveal that it exists to
                   * people who type !commands.
                   */
                  if (
                      !deps.isCommandAuthorized(M)
                    ) {
                    return;
                  }
      
                  /*
                   * !hi
                   */
                  if (
                    command === 'hi'
                  ) {
                    await commandReply(
                      success(
                        '🟢 M_D TOOL ONLINE',
                        [
                          'Status : Connected',
                          'WhatsApp : Ready',
                        ],
                      ),
                    );
      
                    return;
                  }
      
                  /*
                   * !help
                   */
                  if (command === 'help') {
                    await commandReply({
                      
                        text: box(
                          '📖 M_D TOOL HELP',
                          [
                            'GENERAL',
                            `${deps.config.prefix}help  — show commands`,
                            `${deps.config.prefix}hi    — bot online check`,
                            '',
                            '📡 SCANNER',
                            `${deps.config.prefix}scan`,
                            `${deps.config.prefix}scan on`,
                            `${deps.config.prefix}scan off`,
                            `${deps.config.prefix}scan status`,
                            `${deps.config.prefix}scan logs`,
                            `${deps.config.prefix}scan file`,
                            `${deps.config.prefix}scan clear`,
                            '',
                            '🔓 CONFIG DECRYPT',
                            `${deps.config.prefix}decrypt`,
                            `${deps.config.prefix}decrypt on`,
                            `${deps.config.prefix}decrypt off`,
                            `${deps.config.prefix}decrypt status`,
                            `${deps.config.prefix}decrypt logs`,
                            `${deps.config.prefix}decrypt file`,
                            `${deps.config.prefix}decrypt clear`,
                            '',
                            '🛡 GROUP MODERATION',
                            `${deps.config.prefix}warn`,
                            `${deps.config.prefix}kick`,
                            `${deps.config.prefix}mute`,
                            `${deps.config.prefix}unmute`,
                            `${deps.config.prefix}warnings`,
                            `${deps.config.prefix}clearwarn`,
                            `${deps.config.prefix}add`,
                            `${deps.config.prefix}promote`,
                            `${deps.config.prefix}demote`,
                            '',
                            '⚙️ ADMIN / DEV',
                            `${deps.config.prefix}config`,
                            `${deps.config.prefix}dev status`,
                            `${deps.config.prefix}dev logs`,
                            `${deps.config.prefix}dev errors`,
                            `${deps.config.prefix}dev clearerrors`,
                            `${deps.config.prefix}dev sh`,
                            `${deps.config.prefix}dev py`,
                            `${deps.config.prefix}dev restart`,
                          ],
                        ),
                      },
                    );
      
                    return;
                  }
      
                  /*
                   * !decrypt
                   */
                  if (command === 'decrypt') {
                    if (
                      !deps.isCommandAuthorized(M)
                    ) {
                      await commandReply({
                        
                          text: error(
                            '⛔ ACCESS DENIED',
                            [
                              'Owner permission required.',
                            ],
                          ),
                        },
                      );
                      return;
                    }
      
                    const action =
                      (args[0] || 'decrypt').toLowerCase();
      
                    /*
                     * !decrypt on
                     */
                    if (action === 'on') {
                      deps.decrypt.setDecryptEnabled(true);
      
                      await commandReply({
                        
                          text: success(
                            '🔓 CONFIG DECRYPT',
                            [
                              'Status : ON',
                              'Automatic decryption enabled.',
                            ],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt off
                     */
                    if (action === 'off') {
                      deps.decrypt.setDecryptEnabled(false);
      
                      await commandReply({
                        
                          text: warning(
                            '🔓 CONFIG DECRYPT',
                            [
                              'Status : OFF',
                              'Automatic decryption disabled.',
                            ],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt status
                     */
                    if (action === 'status') {
                      await commandReply({
                        
                          text: info(
                            '🔓 CONFIG DECRYPT',
                            [
                              `Status : ${deps.decryptEnabled() ? 'ON' : 'OFF'}`,
                              `Log file : ${deps.decryptLogFile()}`,
                            ],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt logs
                     */
                    if (action === 'logs') {
                      const logs = deps.decrypt.recentDecryptLogs(10);
      
                      await commandReply({
                        
                          text: info(
                            '📜 DECRYPT LOGS',
                            logs.length ? logs : ['No decrypt logs.'],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt file
                     */
                    if (action === 'file') {
                      await commandReply({
                        
                          text: info(
                            '📜 DECRYPT LOG FILE',
                            [deps.decryptLogFile()],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt clear
                     */
                    if (action === 'clear') {
                      deps.decrypt.clearDecryptLogs();
      
                      await commandReply({
                        
                          text: success('📜 DECRYPT LOGS', ['Log cleared.']),
                        },
                      );
      
                      return;
                    }
      
                    /*
                     * !decrypt
                     *
                     * Only decrypt when explicitly enabled.
                     */
                    if (!deps.decryptEnabled()) {
                      await commandReply({
                        
                          text: warning(
                            '🔓 CONFIG DECRYPT',
                            [
                              'Status : OFF',
                              `Use ${deps.config.prefix}decrypt on first.`,
                            ],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    const hat =
                      deps.decrypt.findHatDocument(M.message) ||
                      deps.decrypt.findQuotedHatDocument(M.message);
      
                    const hc =
                      deps.decrypt.findHcDocument(M.message) ||
                      deps.decrypt.findQuotedHcDocument(M.message);
      
                    let decrypted = false;
      
                    if (hat) {
                      decrypted = await deps.decryptHatFromMessage(currentSock, M);
                      deps.decrypt.logDecrypt(
                        'decrypt-hat',
                        M.key.remoteJid || '',
                        M.key.participant || M.key.remoteJid || '',
                        decrypted,
                      );
                    } else if (hc) {
                      decrypted = await deps.decryptHcFromMessage(currentSock, M);
                      deps.decrypt.logDecrypt(
                        'decrypt-hc',
                        M.key.remoteJid || '',
                        M.key.participant || M.key.remoteJid || '',
                        decrypted,
                      );
                    }
      
                    if (!decrypted) {
                      await commandReply({
                        text: error(
                          '🔐 DECRYPT',
                          [
                            'No .hat or .hc document found.',
                            `Reply to a .hat or .hc file with ${deps.config.prefix}deps.decrypt.`,
                          ],
                        ),
                      });
                    }
      
                    return;
                  }
      
                  /*
                   * !scan
                   */
                  if (command === 'scan') {
                    if (
                      !deps.isCommandAuthorized(M)
                    ) {
                      await commandReply({
                         text: error('⛔ ACCESS DENIED', ['Owner permission required.']) },
                      );
                      return;
                    }
      
                    const action =
                      (args[0] || 'status').toLowerCase();
      
                    if (action === 'on') {
                      deps.scanner.setEnabled(true);
      
                      await commandReply({
                        
                          text: success('📡 SCANNER', ['Status : ON', 'Passive IP/URL scanning enabled.']),
                        },
                      );
      
                      return;
                    }
      
                    if (action === 'off') {
                      deps.scanner.setEnabled(false);
      
                      await commandReply({
                        
                          text: warning('📡 SCANNER', ['Status : OFF', 'Passive IP/URL scanning disabled.']),
                        },
                      );
      
                      return;
                    }
      
                    if (action === 'clear') {
                      clearMatches();
      
                      await commandReply({
                        
                          text: success('📡 SCANNER', ['Saved matches cleared.']),
                        },
                      );
      
                      return;
                    }
      
                    if (action === 'file') {
                      await commandReply({
                        
                          text: info(
                            '📡 SCANNER FILE',
                            [scannerFile()],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    if (action === 'logs') {
                      const lines =
                        readMatches(
                          Number(args[1]) || 50,
                        );
      
                      await commandReply({
                        
                          text: info(
                            '📡 SCANNER LOGS',
                            lines.length
                              ? lines
                              : ['No scanner matches.'],
                          ),
                        },
                      );
      
                      return;
                    }
      
                    await commandReply({
                      
                        text: info(
                        '📡 SCANNER STATUS',
                        [
                          `Enabled : ${deps.scanner.isEnabled() ? 'YES' : 'NO'}`,
                          '',
                          `${deps.config.prefix}scan on`,
                          `${deps.config.prefix}scan off`,
                          `${deps.config.prefix}scan logs`,
                          `${deps.config.prefix}scan clear`,
                          `${deps.config.prefix}scan file`,
                        ],
                      ),
                      },
                    );
      
                    return;
                  }
      
                  /*
                   * !config
                   */
                  if (
                    command === 'config'
                  ) {
                    if (
                      !deps.isCommandAuthorized(M)
                    ) {
                      await commandReply({
                        
                          text: error('⛔ ACCESS DENIED', ['Owner permission required.']),
                        },
                      );
      
                      return;
                    }
      
                    await deps.configCommand(
                      {
                        ...M,
                        reply: async (
                          replyText: string,
                        ) => {
                          await commandReply({
                             text: replyText },
                          );
                        },
                        sender:
                          M.key.participant ||
                          M.key.remoteJid ||
                          '',
                      },
                      args,
                    );
      
                    return;
                  }
      
                  /*
                   * Development commands.
                   *
                   * Existing dev.ts owns its
                   * command implementation.
                   */
                  if (
                    [
                      'dev',
                      'sh',
                      'py',
                      'status',
                      'logs',
                      'errors',
                      'clearerrors',
                      'restart',
                      'repair',
                    ].includes(command)
                  ) {
                    if (
                      !deps.isCommandAuthorized(M)
                    ) {
                      await commandReply({
                        
                          text: error('⛔ ACCESS DENIED', ['Owner permission required.']),
                        },
                      );
      
                      return;
                    }
      
                    const devArgs =
                      command === 'dev'
                        ? args
                        : [
                            command,
                            ...args,
                          ];
      
                    if (
                      command === 'status'
                    ) {
                      await commandReply({
                        
                          text: [
                            'Bot status',
                            `WhatsApp: ${deps.getStatus().waState}`,
                            `Pairing: ${
                              deps.getStatus().pairing
                                ? 'active'
                                : 'idle'
                            }`,
                            `Discord: ${
                              deps.discord.client?.isReady()
                                ? 'connected'
                                : 'disconnected'
                            }`,
                            `Discord target: ${
                              deps.config.discordTarget ||
                              'not set'
                            }`,
                            `Reconnect attempt: ${
                              deps.getStatus().reconnectAttempt
                            }`,
                            `Last code: ${
                              deps.getStatus().lastDisconnectCode ??
                              'none'
                            }`,
                            `Last reason: ${
                              deps.getStatus().lastDisconnectReason ||
                              'none'
                            }`,
                            `Uptime: ${deps.uptime()}`,
                          ].join('\n'),
                        },
                      );
      
                      return;
                    }
      
                    if (
                      command === 'logs'
                    ) {
                      const lines =
                        deps.readHistory(50);
      
                      await commandReply({
                        
                          text:
                            lines.length
                              ? lines
                                  .join('\n')
                                  .slice(-6000)
                              : 'No Discord bridge history.',
                        },
                      );
      
                      return;
                    }
      
                    if (
                      command === 'errors'
                    ) {
                      const lines =
                        deps.readErrors(50);
      
                      await commandReply({
                        
                          text:
                            lines.length
                              ? lines
                                  .join('\n')
                                  .slice(-6000)
                              : 'No recorded errors.',
                        },
                      );
      
                      return;
                    }
      
                    if (
                      command ===
                      'clearerrors'
                    ) {
                      deps.clearErrors();
      
                      await commandReply({
                        
                          text:
                            'Error log cleared.',
                        },
                      );
      
                      return;
                    }
      
                    if (
                      command === 'repair'
                    ) {
                      if (
                        deps.getStatus().waState ===
                        'connected'
                      ) {
                        await commandReply({
                          
                            text:
                              'Repair refused while WhatsApp is connected.',
                          },
                        );
      
                        return;
                      }
      
                      deps.clearReconnectTimer();
      
                      const backup =
                        deps.archiveAuth();
      
                      deps.resetReconnectState();
      
                      await commandReply({
                        
                          text: backup
                            ? [
                                'Auth archived.',
                                `Backup: ${backup}`,
                                'Starting fresh pairing...',
                              ].join('\n')
                            : [
                                'No existing auth found.',
                                'Starting fresh pairing...',
                              ].join('\n'),
                        },
                      );
      
                      deps.setSocket(null);
      
                      await deps.sleep(1000);
      
                      void deps.connect();
      
                      return;
                    }
      
                    try {
                      await deps.dev(
                        {
                          ...M,
                          reply: async (
                            replyText: string,
                          ) => {
                            await commandReply({
                              
                                text: replyText,
                              },
                            );
                          },
                          sender:
                            M.key.participant ||
                            M.key.remoteJid ||
                            '',
                        },
                        devArgs,
                      );
                    } catch (error) {
                      await deps.reportError(
                        'dev-command',
                        error,
                      );
                    }
      
                    return;
                  }
      
                  /*
                   * Moderation commands.
                   */
                  if (
                    [
                      'warn',
                      'warnings',
                      'clearwarn',
                      'kick',
                      'mute',
                      'unmute',
                      'add',
                      'promote',
                      'demote',
                    ].includes(command)
                  ) {
                    try {
                      await deps.moderate(
                        currentSock,
                        {
                          ...M,
                          reply: async (
                            replyText: string,
                          ) => {
                            await commandReply({
                              
                                text: replyText,
                              },
                            );
                          },
                          sender:
                            M.key.participant ||
                            M.key.remoteJid ||
                            '',
                        },
                        command,
                        args.join(' '),
                      );
                    } catch (error) {
                      await deps.reportError(
                        'moderation',
                        error,
                      );
                    }
      
                    return;
                  }
      

  };
}
