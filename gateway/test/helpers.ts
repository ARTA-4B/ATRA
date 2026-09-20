/**
 * Test harness for the gateway.
 *
 * Everything runs inside workerd with a local D1 and the real Hub Durable
 * Object. The one outbound call, sendMessage to api.telegram.org, is captured
 * by a fetch stub so a test can assert what the user would have seen. Any
 * other outbound request fails loudly: the suite must never touch the network.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import worker from '../src/index.js';
import { storedPairHash } from '../src/pairing.js';
import { PROTOCOL_VERSION, WS_SUBPROTOCOL } from '../src/protocol.js';
import { mintInstallToken } from '../src/tokens.js';

export const BASE = 'https://gateway.test';
export const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN!;
export const WEBHOOK_SECRET = env.TELEGRAM_WEBHOOK_SECRET!;
export const ADMIN_TOKEN = env.ADMIN_TOKEN!;
export const PEPPER = env.TOKEN_PEPPER!;

// --- Telegram stub ---------------------------------------------------------

export interface SentMessage {
  chatId: number;
  text: string;
}

export interface TelegramStub {
  sent: SentMessage[];
  /** Resolves when at least `count` messages have been sent, or rejects on timeout. */
  waitForSent(count: number, timeoutMs?: number): Promise<SentMessage[]>;
  restore(): void;
}

/** Replace global fetch: capture sendMessage, refuse everything else. */
export function stubTelegram(options: { status?: number } = {}): TelegramStub {
  const sent: SentMessage[] = [];

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const expectedPrefix = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    if (!url.startsWith(expectedPrefix)) {
      return Promise.reject(new Error(`unexpected outbound request in tests: ${url}`));
    }
    const body = JSON.parse(init?.body as string) as { chat_id: number; text: string };
    sent.push({ chatId: body.chat_id, text: body.text });
    const status = options.status ?? 200;
    const response = new Response(
      JSON.stringify(
        status === 200
          ? { ok: true, result: { message_id: sent.length } }
          : { ok: false, description: 'stubbed failure' },
      ),
      { status, headers: { 'content-type': 'application/json' } },
    );
    return Promise.resolve(response);
  });

  return {
    sent,
    // Polled rather than resolved from inside the stub: the stub runs in the
    // Hub Durable Object's I/O context, and a promise resolved there would
    // continue the test in that context, where the test's own client socket
    // may not be touched.
    async waitForSent(count, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (sent.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} sent message(s), have ${sent.length}`);
        }
        await settle(10);
      }
      return [...sent];
    },
    restore() {
      spy.mockRestore();
    },
  };
}

// --- Upstream stub (RPC providers, market providers, inference) ------------

export interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export type UpstreamHandler = (call: UpstreamCall) => Response | Promise<Response>;

export interface UpstreamStub {
  calls: UpstreamCall[];
  /** Calls whose URL starts with `prefix`. */
  callsTo(prefix: string): UpstreamCall[];
  restore(): void;
}

/**
 * Replace global fetch with a router keyed by URL prefix. Anything that does
 * not match a handler is refused loudly: the suite must never touch the
 * network. Telegram's sendMessage is refused too unless a handler is given.
 */
export function stubUpstreams(handlers: Record<string, UpstreamHandler>): UpstreamStub {
  const calls: UpstreamCall[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = request.url;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const text = await request.text();
    const call: UpstreamCall = {
      url,
      method: request.method,
      headers,
      body: parseMaybeJson(text),
    };
    const prefix = Object.keys(handlers).find((p) => url.startsWith(p));
    if (prefix === undefined) {
      throw new Error(`unexpected outbound request in tests: ${url}`);
    }
    calls.push(call);
    return handlers[prefix]!(call);
  });
  return {
    calls,
    callsTo: (prefix) => calls.filter((c) => c.url.startsWith(prefix)),
    restore: () => spy.mockRestore(),
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// --- Authenticated HTTP calls ------------------------------------------------

export interface CallResult {
  response: Response;
  body: any;
}

/** Call the Worker with an optional bearer token and env override. */
export async function call(
  path: string,
  init: RequestInit & { token?: string | null; env?: typeof env } = {},
): Promise<CallResult> {
  const { token, env: envOverride, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const request = new Request(`${BASE}${path}`, { ...rest, headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, envOverride ?? env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { response, body: parseMaybeJson(text) };
}

export function adminCall(path: string, init: RequestInit & { env?: typeof env } = {}) {
  return call(path, { ...init, token: ADMIN_TOKEN });
}

/** POST a JSON body with a bearer token. */
export function postJson(
  path: string,
  token: string | null,
  body: unknown,
  options: { env?: typeof env } = {},
) {
  const init: RequestInit & { token?: string | null; env?: typeof env } = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    token,
  };
  if (options.env) init.env = options.env;
  return call(path, init);
}

// --- Telegram updates ------------------------------------------------------

let nextUpdateId = 1_000_000 + Math.floor(Math.random() * 1_000_000);

export interface UpdateOptions {
  updateId?: number;
  userId: number;
  chatId?: number;
  text: string;
  username?: string;
  firstName?: string;
  chatType?: string;
  isBot?: boolean;
  date?: number;
}

export function makeUpdate(options: UpdateOptions) {
  const chatId = options.chatId ?? options.userId;
  const from: Record<string, unknown> = {
    id: options.userId,
    is_bot: options.isBot ?? false,
    first_name: options.firstName ?? 'Test',
  };
  if (options.username) from.username = options.username;
  return {
    update_id: options.updateId ?? nextUpdateId++,
    message: {
      message_id: Math.floor(Math.random() * 1_000_000),
      date: options.date ?? Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: options.chatType ?? 'private' },
      from,
      text: options.text,
    },
  };
}

export interface WebhookResult {
  response: Response;
  body: any;
}

/** POST an update to the webhook and wait for the background work to settle. */
export async function postWebhook(
  update: unknown,
  options: { secret?: string | null; env?: typeof env } = {},
): Promise<WebhookResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = options.secret === undefined ? WEBHOOK_SECRET : options.secret;
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  const request = new Request(`${BASE}/tg/webhook`, {
    method: 'POST',
    headers,
    body: typeof update === 'string' ? update : JSON.stringify(update),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, options.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { response, body: parseMaybeJson(text) };
}

export function parseMaybeJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// --- Installation tokens -------------------------------------------------

export async function mintToken(
  options: { installId?: string; ttlMs?: number | null; scopes?: readonly string[] } = {},
) {
  return mintInstallToken(env.DB, PEPPER, options);
}

// --- Runtime WebSocket -------------------------------------------------

export interface RuntimeSocket {
  socket: WebSocket;
  installId: string;
  /** Next text frame (parsed JSON, or the raw string for ping/pong). */
  next(timeoutMs?: number): Promise<any>;
  /** Resolves to null if nothing arrives within the window. */
  maybeNext(timeoutMs: number): Promise<any>;
  send(frame: Record<string, unknown>): void;
  sendRaw(text: string): void;
  hello(installationId?: string): Promise<any>;
  close(): Promise<void>;
  closed: Promise<CloseEvent>;
}

export function wsRequest(token: string | null, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    upgrade: 'websocket',
    'sec-websocket-protocol': WS_SUBPROTOCOL,
    ...extraHeaders,
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`${BASE}/v1/ws`, { headers });
}

export async function openSocket(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export function frame(type: string, payload: Record<string, unknown> = {}) {
  return { v: PROTOCOL_VERSION, type, id: crypto.randomUUID(), ts: Date.now(), ...payload };
}

/** Connect as a runtime with a valid token. Does not send hello. */
export async function connectRuntime(token: string, installId: string): Promise<RuntimeSocket> {
  const response = await openSocket(wsRequest(token));
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`expected 101, got ${response.status}: ${await response.text()}`);
  }
  const socket = response.webSocket;
  const queue: any[] = [];
  const waiters: Array<(value: any) => void> = [];

  let resolveClosed!: (event: CloseEvent) => void;
  const closed = new Promise<CloseEvent>((resolve) => {
    resolveClosed = resolve;
  });

  socket.addEventListener('message', (event) => {
    const data = event.data;
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
    const value = parseMaybeJson(text);
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  socket.addEventListener('close', (event) => resolveClosed(event));
  socket.accept();

  const next = (timeoutMs = 5_000) =>
    new Promise<any>((resolve, reject) => {
      if (queue.length > 0) {
        resolve(queue.shift());
        return;
      }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(onValue);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('timed out waiting for a frame'));
      }, timeoutMs);
      const onValue = (value: any) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiters.push(onValue);
    });

  const runtime: RuntimeSocket = {
    socket,
    installId,
    next,
    maybeNext: (timeoutMs) => next(timeoutMs).catch(() => null),
    send: (f) => socket.send(JSON.stringify(f)),
    sendRaw: (text) => socket.send(text),
    async hello(installationId = installId) {
      socket.send(
        JSON.stringify(
          frame('hello', {
            installationId,
            runtimeVersion: '0.1.0-test',
            capabilities: ['telegram'],
          }),
        ),
      );
      return next();
    },
    async close() {
      // The server side handles the close at once (webSocketClose runs and
      // the socket leaves getWebSockets()); the client-side close event can
      // trail by several seconds in workerd, so it is not awaited here.
      socket.close(1000, 'test done');
      await settle(50);
    },
    closed,
  };
  return runtime;
}

/** Mint a token, connect, say hello. */
export async function connectedRuntime(): Promise<{ runtime: RuntimeSocket; welcome: any }> {
  const minted = await mintToken();
  const runtime = await connectRuntime(minted.token, minted.installId);
  const welcome = await runtime.hello();
  return { runtime, welcome };
}

/** Pair a Telegram user with a connected runtime through the real flow. */
export async function pairRuntime(
  runtime: RuntimeSocket,
  telegram: TelegramStub,
  user: { userId: number; username?: string },
  code = 'ABCD-2345',
): Promise<{ paired: any; code: string }> {
  const normalized = code.toUpperCase().replace('-', '');
  const codeHash = await sha256Hex(normalized);
  runtime.send(frame('pair.offer', { codeHash, expiresAt: Date.now() + 5 * 60_000 }));
  // pair.offer has no ack; the D1 write completes before the next frame is handled.
  await settle();
  const before = telegram.sent.length;
  await postWebhook(makeUpdate({ ...user, text: `/pair ${code}` }));
  await telegram.waitForSent(before + 1);
  const paired = await runtime.next();
  return { paired, code };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The pair_codes row for a wire hash (what the runtime sends), or null. */
export async function pairCodeRow(codeHash: string) {
  return env.DB.prepare(
    'SELECT install_id, used_at, expires_at FROM pair_codes WHERE code_hash = ?',
  )
    .bind(await storedPairHash(PEPPER, codeHash))
    .first<{ install_id: string; used_at: number | null; expires_at: number }>();
}

/** Insert a pair_codes row the way storePairOffer would, for a wire hash. */
export async function insertPairCode(
  codeHash: string,
  installId: string,
  options: { expiresAt?: number; usedAt?: number | null; createdAt?: number } = {},
) {
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO pair_codes (code_hash, install_id, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(
      await storedPairHash(PEPPER, codeHash),
      installId,
      options.expiresAt ?? now + 60_000,
      options.usedAt ?? null,
      options.createdAt ?? now,
    )
    .run();
}

export async function linkRow(installId: string) {
  return env.DB.prepare(
    'SELECT install_id, tg_user_id, tg_chat_id, display_name FROM tg_links WHERE install_id = ?',
  )
    .bind(installId)
    .first<{ install_id: string; tg_user_id: number; tg_chat_id: number; display_name: string }>();
}
