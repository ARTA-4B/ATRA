import { z } from 'zod';
import { childLogger } from '../logging/logger.js';
import { REDACTED } from '../logging/redact.js';
import { errorMessage } from '../util/errors.js';
import {
  GATEWAY_WS_PATH,
  PING_FRAME,
  PONG_FRAME,
  SUBPROTOCOL,
  decodeFrame,
  encodeFrame,
  identityFromFrame,
} from './protocol.js';
import type { OutboundPayloads, OutboundType } from './protocol.js';
import type { InboundCommand, TelegramIdentity, TransportKind } from './types.js';

/**
 * Two ways to reach Telegram, one interface.
 *
 *  - {@link GatewayTransport}: the supported path. The runtime dials out to
 *    the official ATRA gateway over WebSocket and speaks the atra.v1 frame
 *    protocol. The project's bot token lives on the gateway; the runtime
 *    holds only its own installation token, which it presents once, in the
 *    upgrade request, and never writes anywhere.
 *  - {@link DirectBotTransport}: the self-hosted fallback. The operator's own
 *    bot token, long-polled straight against api.telegram.org. The token is
 *    in every request URL, so this file never logs a URL or a raw error.
 *
 * Both hand every command to the same router and both send plain text. A
 * transport has no opinion about what a command means; it cannot authorise
 * anything.
 */

export interface TransportEvents {
  /** Return the reply text, or null to say nothing. Must not throw. */
  onCommand(command: InboundCommand): Promise<string | null>;
  onPaired(identity: TelegramIdentity, pairedAt: number): void;
  onUnpaired(reason: string): void;
  onWelcome(welcome: {
    paired: boolean;
    telegram: TelegramIdentity | null;
    botUsername: string;
  }): void;
  onConnected(): void;
  onDisconnected(reason: string): void;
  /** Another connection took this installation's slot on the gateway. */
  onSuperseded(): void;
  /** The gateway rejected the installation token; no reconnect can succeed. */
  onRevoked(): void;
}

export interface TransportStatus {
  kind: TransportKind;
  connected: boolean;
  botUsername: string | null;
  lastError: string | null;
  lastConnectedAt: string | null;
  reconnectAttempts: number;
}

export interface TelegramTransport {
  readonly kind: TransportKind;
  start(events: TransportEvents): void;
  stop(): Promise<void>;
  status(): TransportStatus;
  /** Send to the paired chat. Rejects when nothing can be sent right now. */
  notify(kind: string, text: string): Promise<void>;
  offerPairCode(codeHash: string, expiresAt: number): Promise<void>;
  revokePairing(): Promise<void>;
}

/** Injectable timers so the state machines can be tested without waiting. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/** Telegram allows 4096; the router caps at 3500 and this is the hard stop. */
export const MAX_MESSAGE_CHARS = 4_000;

function clip(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

// --- gateway -------------------------------------------------------------------------

/** The subset of the WebSocket interface the transport uses; a test injects a fake. */
export interface GatewaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
}

export type GatewaySocketFactory = (
  url: string,
  init: { protocols: string[]; headers: Record<string, string> },
) => GatewaySocket;

const SOCKET_OPEN = 1;

/** Node 24 ships a WHATWG WebSocket that also accepts extra upgrade headers. */
export const defaultSocketFactory: GatewaySocketFactory = (url, init) =>
  new WebSocket(url, {
    protocols: init.protocols,
    headers: init.headers,
  });

export interface GatewayTransportOptions {
  /** The gateway base URL from ATRA_GATEWAY_URL; /v1/ws is appended. */
  url: string;
  /** The installation token. Presented in the upgrade request, held nowhere else. */
  token: string;
  installationId: () => string;
  runtimeVersion: string;
  socketFactory?: GatewaySocketFactory;
  timers?: Timers;
  now?: () => number;
  random?: () => number;
  heartbeatMs?: number;
  connectTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

export const GATEWAY_DEFAULTS = {
  heartbeatMs: 30_000,
  connectTimeoutMs: 20_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 60_000,
  maxMissedPongs: 3,
} as const;

/**
 * The two close codes that mean something about this installation rather than
 * about this connection: 4001, another client is now holding the slot, and
 * 4003, the installation token no longer exists. Every other code is a blip.
 */
export const GATEWAY_CLOSE = { superseded: 4001, revoked: 4003 } as const;

/** Shown in the dashboard's transport status after a 4003. */
export const GATEWAY_TOKEN_REVOKED = 'gateway token revoked; issue a new token';

/** Turn the configured base URL into the WebSocket endpoint. */
export function gatewayWebSocketUrl(base: string): string {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${GATEWAY_WS_PATH}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class GatewayTransport implements TelegramTransport {
  readonly kind = 'gateway' as const;
  readonly #url: string;
  readonly #token: string;
  readonly #installationId: () => string;
  readonly #runtimeVersion: string;
  readonly #factory: GatewaySocketFactory;
  readonly #timers: Timers;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #heartbeatMs: number;
  readonly #connectTimeoutMs: number;
  readonly #backoffMinMs: number;
  readonly #backoffMaxMs: number;
  readonly #log = childLogger('telegram-gateway');

  #events: TransportEvents | null = null;
  #socket: GatewaySocket | null = null;
  #stopped = true;
  #revoked = false;
  #welcomed = false;
  #attempts = 0;
  #missedPongs = 0;
  #heartbeat: unknown = null;
  #reconnect: unknown = null;
  #connectTimer: unknown = null;
  #lastError: string | null = null;
  #lastConnectedAt: string | null = null;
  #botUsername: string | null = null;

  constructor(options: GatewayTransportOptions) {
    this.#url = gatewayWebSocketUrl(options.url);
    this.#token = options.token;
    this.#installationId = options.installationId;
    this.#runtimeVersion = options.runtimeVersion;
    this.#factory = options.socketFactory ?? defaultSocketFactory;
    this.#timers = options.timers ?? realTimers;
    this.#now = options.now ?? (() => Date.now());
    this.#random = options.random ?? Math.random;
    this.#heartbeatMs = options.heartbeatMs ?? GATEWAY_DEFAULTS.heartbeatMs;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? GATEWAY_DEFAULTS.connectTimeoutMs;
    this.#backoffMinMs = options.backoffMinMs ?? GATEWAY_DEFAULTS.backoffMinMs;
    this.#backoffMaxMs = options.backoffMaxMs ?? GATEWAY_DEFAULTS.backoffMaxMs;
  }

  start(events: TransportEvents): void {
    if (!this.#stopped) return;
    this.#events = events;
    this.#stopped = false;
    this.#revoked = false;
    this.#attempts = 0;
    this.#connect();
  }

  stop(): Promise<void> {
    this.#stopped = true;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    this.#welcomed = false;
    if (socket) {
      try {
        socket.close(1000, 'runtime stopping');
      } catch {
        // Already closed; nothing to release.
      }
    }
    return Promise.resolve();
  }

  status(): TransportStatus {
    return {
      kind: 'gateway',
      connected: this.#welcomed && this.#socket?.readyState === SOCKET_OPEN,
      botUsername: this.#botUsername,
      lastError: this.#lastError,
      lastConnectedAt: this.#lastConnectedAt,
      reconnectAttempts: this.#attempts,
    };
  }

  notify(kind: string, text: string): Promise<void> {
    return this.#sendAsync('notify', { kind, text: clip(text) });
  }

  offerPairCode(codeHash: string, expiresAt: number): Promise<void> {
    return this.#sendAsync('pair.offer', { codeHash, expiresAt });
  }

  revokePairing(): Promise<void> {
    return this.#sendAsync('pair.revoke', {});
  }

  /** The current backoff delay, exposed for tests of the schedule. */
  backoffDelayMs(attempt: number): number {
    const exponential = this.#backoffMinMs * 2 ** Math.max(0, attempt - 1);
    const capped = Math.min(this.#backoffMaxMs, exponential);
    const jitter = 0.75 + this.#random() * 0.5;
    return Math.round(capped * jitter);
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#clearTimers();
    this.#welcomed = false;
    this.#missedPongs = 0;

    let socket: GatewaySocket;
    try {
      socket = this.#factory(this.#url, {
        protocols: [SUBPROTOCOL],
        headers: { authorization: `Bearer ${this.#token}` },
      });
    } catch (error) {
      this.#lastError = this.#scrub(errorMessage(error));
      this.#log.warn({ err: this.#lastError }, 'gateway socket could not be created');
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    this.#connectTimer = this.#timers.setTimeout(() => {
      if (this.#socket === socket && !this.#welcomed) {
        this.#lastError = 'connect timeout';
        this.#dropSocket(socket, 4001, 'connect timeout');
      }
    }, this.#connectTimeoutMs);

    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return;
      this.#sendOn(socket, 'hello', {
        installationId: this.#installationId(),
        runtimeVersion: this.#runtimeVersion,
        capabilities: ['telegram'],
      });
      this.#startHeartbeat(socket);
    });

    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket) return;
      this.#onMessage(socket, typeof event.data === 'string' ? event.data : '');
    });

    socket.addEventListener('error', (event) => {
      if (this.#socket !== socket) return;
      this.#lastError = this.#scrub(event.message ?? 'socket error');
    });

    socket.addEventListener('close', (event) => {
      if (this.#socket !== socket) return;
      this.#onClose(event.code, event.reason);
    });
  }

  #onMessage(socket: GatewaySocket, data: string): void {
    if (data === PONG_FRAME) {
      this.#missedPongs = 0;
      return;
    }
    if (data === PING_FRAME) {
      this.#raw(socket, PONG_FRAME);
      return;
    }

    const decoded = decodeFrame(data);
    if (!decoded.ok) {
      this.#log.debug({ reason: decoded.reason, type: decoded.type }, 'ignored gateway frame');
      return;
    }
    const events = this.#events;
    if (!events) return;

    const frame = decoded.frame;
    switch (frame.type) {
      case 'welcome': {
        this.#welcomed = true;
        this.#attempts = 0;
        this.#lastError = null;
        this.#lastConnectedAt = new Date(this.#now()).toISOString();
        this.#botUsername = frame.botUsername || null;
        this.#clearConnectTimer();
        this.#log.info({ paired: frame.paired }, 'gateway session established');
        events.onWelcome({
          paired: frame.paired,
          telegram: frame.telegram ? identityFromFrame(frame.telegram) : null,
          botUsername: frame.botUsername,
        });
        events.onConnected();
        return;
      }
      case 'paired':
        events.onPaired(identityFromFrame(frame.telegram), frame.pairedAt);
        return;
      case 'unpaired':
        events.onUnpaired(frame.reason);
        return;
      case 'command': {
        const command: InboundCommand = {
          requestId: frame.requestId,
          updateId: frame.updateId,
          telegram: identityFromFrame(frame.telegram),
          text: frame.text,
          receivedAt: frame.receivedAt,
          source: 'gateway',
        };
        void this.#handleCommand(socket, command);
        return;
      }
      case 'error':
        this.#log.warn(
          { code: frame.code, requestId: frame.requestId },
          'gateway reported an error',
        );
        return;
      default:
        return;
    }
  }

  async #handleCommand(socket: GatewaySocket, command: InboundCommand): Promise<void> {
    const events = this.#events;
    if (!events) return;
    let reply: string | null;
    try {
      reply = await events.onCommand(command);
    } catch (error) {
      this.#log.error({ err: error, requestId: command.requestId }, 'command handler threw');
      reply = 'The command could not be processed. Check the runtime log.';
    }
    if (reply === null) return;
    try {
      this.#sendOn(socket, 'reply', { requestId: command.requestId, text: clip(reply) });
    } catch (error) {
      this.#log.warn({ err: error }, 'reply could not be sent');
    }
  }

  /**
   * `local` marks a close this transport initiated. It matters because our own
   * close codes overlap the gateway's (a connect timeout closes with 4001), and
   * only a code the gateway chose is a verdict about this installation.
   */
  #onClose(code: number, reason: string, local = false): void {
    const wasWelcomed = this.#welcomed;
    this.#socket = null;
    this.#welcomed = false;
    this.#clearTimers();
    this.#log.warn({ code, reason: this.#scrub(reason) }, 'gateway connection closed');
    if (wasWelcomed) this.#events?.onDisconnected(reason || `close ${String(code)}`);

    if (!local && code === GATEWAY_CLOSE.revoked) {
      // Reconnecting would only replay a refused token until someone looks at
      // the dashboard, so the loop stops here and the status says why.
      this.#revoked = true;
      this.#lastError = GATEWAY_TOKEN_REVOKED;
      this.#log.error('gateway revoked this installation token; not reconnecting');
      this.#events?.onRevoked();
      return;
    }
    if (!local && code === GATEWAY_CLOSE.superseded) this.#events?.onSuperseded();

    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#revoked) return;
    this.#attempts += 1;
    const delay = this.backoffDelayMs(this.#attempts);
    this.#log.info({ attempt: this.#attempts, delayMs: delay }, 'gateway reconnect scheduled');
    this.#reconnect = this.#timers.setTimeout(() => {
      this.#reconnect = null;
      this.#connect();
    }, delay);
  }

  #startHeartbeat(socket: GatewaySocket): void {
    this.#missedPongs = 0;
    this.#heartbeat = this.#timers.setInterval(() => {
      if (this.#socket !== socket) return;
      if (this.#missedPongs >= GATEWAY_DEFAULTS.maxMissedPongs) {
        this.#lastError = 'heartbeat lost';
        this.#dropSocket(socket, 4002, 'heartbeat lost');
        return;
      }
      this.#missedPongs += 1;
      this.#raw(socket, PING_FRAME);
    }, this.#heartbeatMs);
  }

  /** Close a socket we no longer trust and go through the normal close path. */
  #dropSocket(socket: GatewaySocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Ignore: the close handler below runs regardless.
    }
    // A WHATWG socket fires 'close' asynchronously; a fake may not fire it at
    // all when closed from our side, so the transition is driven here.
    if (this.#socket === socket) this.#onClose(code, reason, true);
  }

  /** The promise-shaped send: a "not connected" is a rejection, never a throw. */
  #sendAsync<T extends OutboundType>(type: T, payload: OutboundPayloads[T]): Promise<void> {
    try {
      this.#send(type, payload);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  }

  #send<T extends OutboundType>(type: T, payload: OutboundPayloads[T]): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== SOCKET_OPEN || !this.#welcomed) {
      throw new Error('gateway transport is not connected');
    }
    this.#sendOn(socket, type, payload);
  }

  #sendOn<T extends OutboundType>(
    socket: GatewaySocket,
    type: T,
    payload: OutboundPayloads[T],
  ): void {
    this.#raw(socket, encodeFrame(type, payload, { now: this.#now }));
  }

  #raw(socket: GatewaySocket, data: string): void {
    try {
      socket.send(data);
    } catch (error) {
      this.#lastError = this.#scrub(errorMessage(error));
      throw error;
    }
  }

  #clearTimers(): void {
    if (this.#heartbeat !== null) this.#timers.clearInterval(this.#heartbeat);
    if (this.#reconnect !== null) this.#timers.clearTimeout(this.#reconnect);
    this.#heartbeat = null;
    this.#reconnect = null;
    this.#clearConnectTimer();
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer !== null) this.#timers.clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  /** Belt and braces: no string that passes through here may carry the token. */
  #scrub(text: string): string {
    return this.#token.length > 0 ? text.split(this.#token).join(REDACTED) : text;
  }
}

// --- direct bot ----------------------------------------------------------------------

const telegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      from: telegramUserSchema.optional(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
      date: z.number().int(),
      text: z.string().optional(),
    })
    .optional(),
});

const telegramResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
});

export interface OffsetStore {
  load(): number | undefined;
  save(offset: number): void;
}

export interface DirectBotOptions {
  token: string;
  username?: string | undefined;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
  pollTimeoutSec?: number;
  offset: OffsetStore;
  linkedChatId: () => number | undefined;
  timers?: Timers;
  now?: () => number;
}

export class DirectBotTransport implements TelegramTransport {
  readonly kind = 'direct' as const;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;
  readonly #pollTimeoutSec: number;
  readonly #offset: OffsetStore;
  readonly #linkedChatId: () => number | undefined;
  readonly #timers: Timers;
  readonly #now: () => number;
  readonly #log = childLogger('telegram-direct');

  #events: TransportEvents | null = null;
  #running = false;
  #loop: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #wake: (() => void) | null = null;
  #botUsername: string | null;
  #lastError: string | null = null;
  #lastConnectedAt: string | null = null;
  #failures = 0;
  #announced = false;

  constructor(options: DirectBotOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = (options.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.#pollTimeoutSec = options.pollTimeoutSec ?? 25;
    this.#offset = options.offset;
    this.#linkedChatId = options.linkedChatId;
    this.#timers = options.timers ?? realTimers;
    this.#now = options.now ?? (() => Date.now());
    this.#botUsername = options.username ?? null;
  }

  start(events: TransportEvents): void {
    if (this.#running) return;
    this.#events = events;
    this.#running = true;
    this.#loop = this.#run().catch((error: unknown) => {
      this.#log.error({ err: this.#scrubError(error) }, 'polling loop ended unexpectedly');
    });
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#abort?.abort();
    this.#wake?.();
    if (this.#loop) await this.#loop;
    this.#loop = null;
  }

  status(): TransportStatus {
    return {
      kind: 'direct',
      connected: this.#running && this.#announced,
      botUsername: this.#botUsername,
      lastError: this.#lastError,
      lastConnectedAt: this.#lastConnectedAt,
      reconnectAttempts: this.#failures,
    };
  }

  async notify(_kind: string, text: string): Promise<void> {
    const chatId = this.#linkedChatId();
    if (chatId === undefined) throw new Error('no paired chat');
    await this.#sendMessage(chatId, text);
  }

  /** Nothing to do: the direct transport verifies codes itself, through the router. */
  offerPairCode(): Promise<void> {
    return Promise.resolve();
  }

  revokePairing(): Promise<void> {
    return Promise.resolve();
  }

  /** One poll iteration, exposed so a test can drive the loop by hand. */
  async pollOnce(): Promise<number> {
    const offset = this.#offset.load();
    const controller = new AbortController();
    this.#abort = controller;
    let updates: unknown;
    try {
      updates = await this.#call(
        'getUpdates',
        {
          ...(offset === undefined ? {} : { offset }),
          timeout: this.#pollTimeoutSec,
          allowed_updates: ['message'],
        },
        controller.signal,
        (this.#pollTimeoutSec + 15) * 1_000,
      );
    } finally {
      if (this.#abort === controller) this.#abort = null;
    }

    const list = z.array(z.unknown()).safeParse(updates);
    if (!list.success) return 0;

    let handled = 0;
    for (const raw of list.data) {
      const parsed = telegramUpdateSchema.safeParse(raw);
      if (!parsed.success) {
        // Advance past what cannot be read, or the same update returns forever.
        const id = (raw as { update_id?: unknown }).update_id;
        if (typeof id === 'number') this.#offset.save(id + 1);
        continue;
      }
      const update = parsed.data;
      await this.#handleUpdate(update);
      this.#offset.save(update.update_id + 1);
      handled += 1;
    }
    return handled;
  }

  async #run(): Promise<void> {
    if (!this.#botUsername) await this.#learnUsername();
    while (this.#running) {
      try {
        const handled = await this.pollOnce();
        // A real long poll returns after `timeout` seconds; a server that
        // answers instantly with nothing must not turn this into a hot loop.
        if (handled === 0 && this.#running) await this.#sleep(250);
        if (!this.#announced) {
          this.#announced = true;
          this.#lastConnectedAt = new Date(this.#now()).toISOString();
          this.#log.info('telegram bot polling');
          this.#events?.onConnected();
        }
        this.#failures = 0;
        this.#lastError = null;
      } catch (error) {
        if (!this.#running) break;
        this.#failures += 1;
        this.#lastError = this.#scrubError(error);
        if (this.#announced) {
          this.#announced = false;
          this.#events?.onDisconnected(this.#lastError);
        }
        this.#log.warn({ err: this.#lastError, failures: this.#failures }, 'poll failed');
        await this.#sleep(Math.min(30_000, 1_000 * 2 ** Math.min(this.#failures, 5)));
      }
    }
  }

  async #learnUsername(): Promise<void> {
    try {
      const me = await this.#call('getMe', {}, undefined, 10_000);
      const parsed = z.object({ username: z.string().optional() }).safeParse(me);
      if (parsed.success && parsed.data.username) this.#botUsername = parsed.data.username;
    } catch (error) {
      this.#log.warn({ err: this.#scrubError(error) }, 'getMe failed; bot username unknown');
    }
  }

  async #handleUpdate(update: z.infer<typeof telegramUpdateSchema>): Promise<void> {
    const message = update.message;
    if (!message?.text || !message.from || message.from.is_bot === true) return;
    // Private chats only: a group the bot was added to is not the operator.
    if (message.chat.type !== 'private') return;

    const from = message.from;
    const displayName =
      [from.first_name, from.last_name].filter((part) => part && part.length > 0).join(' ') ||
      (from.username ? `@${from.username}` : `user ${String(from.id).slice(-3)}`);

    const command: InboundCommand = {
      requestId: `direct:${String(update.update_id)}`,
      updateId: update.update_id,
      telegram: { userId: from.id, chatId: message.chat.id, displayName },
      text: message.text,
      receivedAt: message.date * 1_000,
      source: 'direct',
    };

    const events = this.#events;
    if (!events) return;
    let reply: string | null;
    try {
      reply = await events.onCommand(command);
    } catch (error) {
      this.#log.error({ err: this.#scrubError(error) }, 'command handler threw');
      reply = 'The command could not be processed. Check the runtime log.';
    }
    if (reply === null) return;
    try {
      await this.#sendMessage(message.chat.id, reply);
    } catch (error) {
      this.#log.warn({ err: this.#scrubError(error) }, 'reply could not be sent');
    }
  }

  async #sendMessage(chatId: number, text: string): Promise<void> {
    // No parse_mode: the text is shown exactly as written, so nothing in a
    // token symbol or a reason string can turn into formatting or a link.
    await this.#call('sendMessage', { chat_id: chatId, text: clip(text) }, undefined, 15_000);
  }

  async #call(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBase}/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      // The caught error is deliberately not attached as `cause`: a transport
      // error can quote the request URL, and the URL carries the bot token.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`telegram ${method}: ${this.#scrubError(error)}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error(`telegram ${method}: HTTP ${String(response.status)} with a non-JSON body`);
    }
    const parsed = telegramResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`telegram ${method}: unexpected response shape`);
    }
    if (!parsed.data.ok) {
      throw new Error(
        `telegram ${method}: ${String(parsed.data.error_code ?? response.status)} ${
          parsed.data.description ?? 'request failed'
        }`,
      );
    }
    return parsed.data.result;
  }

  /** Sleeps that stop() can cut short, so shutdown never waits on a backoff. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = this.#timers.setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      this.#wake = () => {
        this.#timers.clearTimeout(handle);
        this.#wake = null;
        resolve();
      };
    });
  }

  /** Every error string is scrubbed before it can reach a log line. */
  #scrubError(error: unknown): string {
    const text = errorMessage(error);
    return this.#token.length > 0 ? text.split(this.#token).join(REDACTED) : text;
  }
}
