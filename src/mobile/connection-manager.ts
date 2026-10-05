import { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import makeWASocket from '@whiskeysockets/baileys';
import chalk from 'chalk';

type ConnectionState = {
  sock: ReturnType<typeof makeWASocket> | null;
  waState: 'starting' | 'pairing' | 'connected' | 'disconnected';
  pairing: boolean;
  connectInProgress: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  connectionReplacedCount: number;
  connectionReplacedWindowStartedAt: number;
  automaticReconnectBlocked: boolean;
  messageCutoffUnix: number;
  messageCutoffReady: boolean;
  lastDisconnectCode: number | null;
  lastDisconnectReason: string;
};

export type ConnectionManagerDeps = {
  config: any;
  sleep: (ms: number) => Promise<void>;
  ensureDirs: () => void;
  errorText: (error: unknown) => string;
  reportError: (category: string, error: unknown) => Promise<void>;
  discord: { start: () => Promise<unknown> };
};

export function createConnectionManager(deps: ConnectionManagerDeps) {
  const state: ConnectionState = {
    sock: null,
    waState: 'starting',
    pairing: false,
    connectInProgress: false,
    reconnectTimer: null,
    reconnectAttempt: 0,
    connectionReplacedCount: 0,
    connectionReplacedWindowStartedAt: 0,
    automaticReconnectBlocked: false,
    messageCutoffUnix: 0,
    messageCutoffReady: false,
    lastDisconnectCode: null,
    lastDisconnectReason: '',
  };

  let messageHandler:
    | ((sock: ReturnType<typeof makeWASocket>, M: any) => Promise<void>)
    | null = null;

  const getWaState = () => state.waState;

  const setMessageHandler = (
    handler: (sock: ReturnType<typeof makeWASocket>, M: any) => Promise<void>,
  ) => {
    messageHandler = handler;
  };

  function scheduleReconnect(reason: string) {
    if (state.reconnectTimer) return;
    if (state.waState === 'connected') return;

    if (state.automaticReconnectBlocked) {
      console.log(
        chalk.yellow(
          '[WA] Automatic reconnect is blocked after repeated 440 conflicts.',
        ),
      );
      return;
    }

    state.reconnectAttempt++;

    const delay = Math.min(
      30_000,
      2_000 * Math.pow(2, state.reconnectAttempt - 1),
    );

    console.log(
      chalk.yellow(
        `[WA] Reconnecting in \${Math.round(delay / 1000)}s (attempt \${state.reconnectAttempt}) — \${reason}`,
      ),
    );

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      void connect().catch(error => {
        void deps.reportError('reconnect', error);
      });
    }, delay);
  }

  async function requestPairingCode(
    authState: Awaited<ReturnType<typeof useMultiFileAuthState>>,
  ) {
    if (state.pairing) return;
    if (authState.state.creds.registered) return;

    const phone = String(deps.config.phone || '').replace(/[^0-9]/g, '');

    if (!phone) {
      console.log(
        chalk.yellow('[WA] WA_PHONE_NUMBER is not configured.'),
      );
      return;
    }

    const currentSock = state.sock;
    if (!currentSock) return;

    state.pairing = true;
    state.waState = 'pairing';

    try {
      console.log(
        chalk.cyan(
          `[WA] Requesting pairing code for +\${phone}...`,
        ),
      );

      await deps.sleep(1500);

      const code = await currentSock.requestPairingCode(phone);

      console.log('');
      console.log(chalk.green('========================================'));
      console.log(chalk.green(`[WA] PAIRING CODE: \${code}`));
      console.log(chalk.green('========================================'));
      console.log('WhatsApp → Settings → Linked devices');
      console.log('→ Link a device → Link with phone number');
      console.log('');
    } catch (error) {
      state.pairing = false;
      await deps.reportError('pairing', error);
      scheduleReconnect('pairing request failed');
    }
  }

  async function connect() {
    if (state.connectInProgress) return;

    if (
      state.sock &&
      (
        state.waState === 'starting' ||
        state.waState === 'pairing' ||
        state.waState === 'connected'
      )
    ) {
      console.log(
        chalk.gray('[WA] connect() ignored: socket already active.'),
      );
      return;
    }

    state.connectInProgress = true;
    state.messageCutoffReady = false;
    state.messageCutoffUnix = 0;

    try {
      deps.ensureDirs();
      state.waState = 'starting';

      const { state: auth, saveCreds } =
        await useMultiFileAuthState(deps.config.authDir);

      let version:
        | [number, number, number]
        | undefined;

      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;

        console.log(
          chalk.gray(`[WA] Version: \${version.join('.')}`),
        );
      } catch (error) {
        console.log(
          chalk.yellow('[WA] Could not fetch latest WhatsApp version.'),
        );
        console.log(chalk.gray(deps.errorText(error)));
      }

      const options: any = {
        auth,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 20_000,
        retryRequestDelayMs: 2_000,
      };

      if (version) options.version = version;

      state.sock = makeWASocket(options);
      const currentSock = state.sock;

      currentSock.ev.on('creds.update', saveCreds);

      currentSock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
          state.waState = 'starting';
          console.log(chalk.cyan('[WA] Connecting...'));
          return;
        }

        if (connection === 'open') {
          if (state.sock !== currentSock) {
            console.log(
              chalk.gray('[WA] Ignoring OPEN event from stale socket.'),
            );
            return;
          }

          state.messageCutoffUnix = Math.floor(Date.now() / 1000);
          state.messageCutoffReady = true;
          state.waState = 'connected';
          state.pairing = false;
          state.reconnectAttempt = 0;
          state.connectionReplacedCount = 0;
          state.connectionReplacedWindowStartedAt = 0;
          state.automaticReconnectBlocked = false;
          state.lastDisconnectCode = null;
          state.lastDisconnectReason = '';

          console.log(chalk.green('[WA] Connected successfully.'));
          console.log(chalk.green(`[WA] Uptime: \${formatUptime()}`));

          void deps.discord.start().catch(error => {
            void deps.reportError('discord-start', error);
          });

          return;
        }

        if (connection !== 'close') return;

        if (state.sock !== currentSock) {
          console.log(
            chalk.gray('[WA] Ignoring CLOSE event from stale socket.'),
          );
          return;
        }

        state.messageCutoffReady = false;
        state.waState = 'disconnected';
        state.sock = null;

        const raw = lastDisconnect?.error as any;
        const statusCode =
          raw?.output?.statusCode ??
          raw?.statusCode ??
          null;
        const reason =
          raw?.output?.payload?.message ??
          raw?.message ??
          'Unknown connection error';

        state.lastDisconnectCode =
          typeof statusCode === 'number' ? statusCode : null;
        state.lastDisconnectReason = String(reason);

        console.error(
          chalk.red(
            `[WA] Disconnected code=\${statusCode ?? 'unknown'} reason=\${reason}`,
          ),
        );

        if (raw) {
          console.error(chalk.gray(deps.errorText(raw)));
        }

        const loggedOut =
          statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          state.pairing = false;
          console.error(
            chalk.red('[AUTH] WhatsApp explicitly reported logged out.'),
          );
          console.error(chalk.yellow('[AUTH] Auth was NOT deleted.'));
          console.error(
            chalk.yellow('[AUTH] Use !dev repair when appropriate.'),
          );
          return;
        }

        if (statusCode === 401) {
          console.error(
            chalk.yellow('[AUTH] 401 Connection Failure.'),
          );
          console.error(
            chalk.yellow('[AUTH] Credentials preserved.'),
          );
          scheduleReconnect('401 connection failure');
          return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          const now = Date.now();

          if (
            !state.connectionReplacedWindowStartedAt ||
            now - state.connectionReplacedWindowStartedAt > 60_000
          ) {
            state.connectionReplacedWindowStartedAt = now;
            state.connectionReplacedCount = 0;
          }

          state.connectionReplacedCount++;

          console.error(
            chalk.yellow(
              '[AUTH] 440 connection replaced (' +
              state.connectionReplacedCount +
              '/3).',
            ),
          );
          console.error(
            chalk.yellow(
              '[AUTH] Credentials preserved; no auth reset will be performed automatically.',
            ),
          );

          if (state.connectionReplacedCount >= 3) {
            state.automaticReconnectBlocked = true;

            console.error(
              chalk.red(
                '[AUTH] Repeated 440 conflicts detected. Automatic reconnect stopped.',
              ),
            );
            console.error(
              chalk.yellow(
                '[AUTH] Check WhatsApp → Settings → Linked devices for another active session.',
              ),
            );
            console.error(
              chalk.yellow(
                '[AUTH] Auth remains intact. Use !dev repair only after confirming the old session is gone.',
              ),
            );
            return;
          }

          scheduleReconnect('440 connection replaced');
          return;
        }

        scheduleReconnect(
          `\${statusCode ?? 'unknown'} \${reason}`,
        );
      });

      currentSock.ev.on('messages.upsert', ({ messages }) => {
        for (const M of messages) {
          if (!messageHandler) {
            void deps.reportError(
              'message-handler',
              new Error('WhatsApp message handler is not initialized.'),
            );
            continue;
          }

          void messageHandler(currentSock, M);
        }
      });

      if (!auth.creds.registered) {
        const pairingDeadline = Date.now() + 30_000;

        while (
          Date.now() < pairingDeadline &&
          state.sock === currentSock &&
          !auth.creds.registered
        ) {
          if (state.sock !== currentSock || getWaState() === 'connected') break;
          await deps.sleep(500);
        }

        if (
          state.sock === currentSock &&
          !auth.creds.registered &&
          !state.pairing
        ) {
          await requestPairingCode({ state: auth, saveCreds });
        }
      }
    } catch (error) {
      state.waState = 'disconnected';
      await deps.reportError('connect', error);
      scheduleReconnect('connect() failed');
    } finally {
      state.connectInProgress = false;
    }
  }

  function formatUptime() {
    const total = Math.floor(process.uptime());
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `\${hours}h \${minutes}m \${seconds}s`;
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function resetReconnectState() {
    state.pairing = false;
    state.reconnectAttempt = 0;
    state.connectionReplacedCount = 0;
    state.connectionReplacedWindowStartedAt = 0;
    state.automaticReconnectBlocked = false;
  }

  return {
    getWaState: () => state.waState,
    connect,
    scheduleReconnect,
    setMessageHandler,
    getSocket: () => state.sock,
    setSocket: (value: ReturnType<typeof makeWASocket> | null) => {
      state.sock = value;
    },
    getCutoff: () => ({
      ready: state.messageCutoffReady,
      unix: state.messageCutoffUnix,
    }),
    getStatus: () => ({
      waState: state.waState,
      pairing: state.pairing,
      reconnectAttempt: state.reconnectAttempt,
      connectionReplacedCount: state.connectionReplacedCount,
      automaticReconnectBlocked: state.automaticReconnectBlocked,
      lastDisconnectCode: state.lastDisconnectCode,
      lastDisconnectReason: state.lastDisconnectReason,
    }),
    clearReconnectTimer,
    resetReconnectState,
    uptime: formatUptime,
  };
}
