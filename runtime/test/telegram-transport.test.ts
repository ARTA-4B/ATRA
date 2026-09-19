import { describe, expect, it } from 'vitest';
import { REDACTED } from '../src/logging/redact.js';
import {
  PING_FRAME,
  PONG_FRAME,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  decodeFrame,
  encodeFrame,
} from '../src/telegram/protocol.js';
import {
  DirectBotTransport,
  GATEWAY_DEFAULTS,
  GatewayTransport,
  gatewayWebSocketUrl,
} from '../src/telegram/transport.js';
import type { GatewaySocket, TransportEvents } from '../src/telegram/transport.js';
import type { InboundCommand } from '../src/telegram/types.js';
import { ManualTimers } from './telegram-harness.js';

/**
 * The transports are tested against fakes of the two things they talk to: a
 * WebSocket (the subset of the interface the gateway transport uses) and
 * `fetch` (for the Bot API). The state machines are driven by hand: open,
 * frames in, close, timers advanced.
 */

// --- codec ---------------------------------------------------------------------

describe('frame codec', () => {
  it('encodes every outbound frame with v, type, id, ts and the spread payload', () => {
    const text = encodeFrame(
      'reply',
      { requestId: 'r1', text: 'hi' },
      { now: () => 1_700_000_000_000, id: () => 'id-1' },
    );
    expect(JSON.parse(text)).toEqual({
      v: PROTOCOL_VERSION,
      type: 'reply',
      id: 'id-1',
      ts: 1_700_000_000_000,
      requestId: 'r1',
      text: 'hi',
    });
    const hello = JSON.parse(
      encodeFrame('hello', {
        installationId: 'i',
        runtimeVersion: '0.1.0',
        capabilities: ['telegram'],
      }),
    );
    expect(hello.v).toBe(1);
    expect(typeof hello.id).toBe('string');
    expect(hello.capabilities).toEqual(['telegram']);
  });

  it('decodes valid inbound frames and reports the rest without throwing', () => {
    const command = decodeFrame(
      JSON.stringify({
        v: 1,
        type: 'command',
        id: 'x',
        ts: 1,
        requestId: 'r',
        updateId: 5,
        telegram: { userId: 1, chatId: 2, displayName: 'n' },
        text: '/status',
        receivedAt: 1,
      }),
    );
    expect(command.ok).toBe(true);
    if (command.ok) expect(command.frame.type).toBe('command');

    expect(decodeFrame('not json')).toEqual({ ok: false, reason: 'not-json' });
    expect(decodeFrame('42')).toEqual({ ok: false, reason: 'not-json' });
    expect(decodeFrame(JSON.stringify({ v: 1, type: 'future', id: 'x', ts: 1 }))).toEqual({
      ok: false,
      reason: 'unknown-type',
      type: 'future',
    });
    expect(decodeFrame(JSON.stringify({ v: 2, type: 'welcome', id: 'x', ts: 1 }))).toEqual({
      ok: false,
      reason: 'invalid',
      type: 'welcome',
    });
    // A command frame carrying a string user id is refused: identity is numeric.
    const bad = decodeFrame(
      JSON.stringify({
        v: 1,
        type: 'command',
        id: 'x',
        ts: 1,
        requestId: 'r',
        updateId: 5,
        telegram: { userId: '1', chatId: 2, displayName: 'n' },
        text: '/status',
        receivedAt: 1,
      }),
    );
    expect(bad.ok).toBe(false);
  });

  it('derives the WebSocket URL from the gateway base', () => {
    expect(gatewayWebSocketUrl('https://gateway.atra.example')).toBe(
      'wss://gateway.atra.example/v1/ws',
    );
    expect(gatewayWebSocketUrl('http://127.0.0.1:8787/')).toBe('ws://127.0.0.1:8787/v1/ws');
    expect(gatewayWebSocketUrl('wss://g.example/base?x=1#f')).toBe('wss://g.example/base/v1/ws');
  });
});

// --- gateway --------------------------------------------------------------------

class FakeSocket implements GatewaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  readonly #listeners: Record<string, Array<(event: any) => void>> = {};
  readonly url: string;
  readonly init: { protocols: string[]; headers: Record<string, string> };

  constructor(url: string, init: { protocols: string[]; headers: Record<string, string> }) {
    this.url = url;
    this.init = init;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    (this.#listeners[type] ??= []).push(listener);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.#listeners[type] ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  receive(frame: string | object): void {
    this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  /** Frames sent by the transport, parsed. */
  frames(): any[] {
    return this.sent.filter((s) => s !== PING_FRAME && s !== PONG_FRAME).map((s) => JSON.parse(s));
  }
}

const TOKEN = 'inst_secret_token_ABC123';

function gatewayRig(overrides: Partial<TransportEvents> = {}) {
  const timers = new ManualTimers();
  const sockets: FakeSocket[] = [];
  const events = {
    commands: [] as InboundCommand[],
    paired: [] as unknown[],
    unpaired: [] as string[],
    welcomes: [] as unknown[],
    connected: 0,
    disconnected: [] as string[],
  };
  const handlers: TransportEvents = {
    onCommand: (command) => {
      events.commands.push(command);
      return Promise.resolve(`echo:${command.text}`);
    },
    onPaired: (identity, pairedAt) => {
      events.paired.push({ identity, pairedAt });
    },
    onUnpaired: (reason) => {
      events.unpaired.push(reason);
    },
    onWelcome: (welcome) => {
      events.welcomes.push(welcome);
    },
    onConnected: () => {
      events.connected += 1;
    },
    onDisconnected: (reason) => {
      events.disconnected.push(reason);
    },
    ...overrides,
  };
  const transport = new GatewayTransport({
    url: 'https://gateway.example',
    token: TOKEN,
    installationId: () => 'inst-1',
    runtimeVersion: '0.1.0',
    socketFactory: (url, init) => {
      const socket = new FakeSocket(url, init);
      sockets.push(socket);
      return socket;
    },
    timers,
    now: () => 1_700_000_000_000 + timers.now,
    random: () => 0.5,
  });
  return { transport, timers, sockets, events, handlers };
}

const welcome = (paired = false) => ({
  v: 1,
  type: 'welcome',
  id: 'w',
  ts: 1,
  paired,
  telegram: paired ? { userId: 1, chatId: 1, displayName: 'op' } : null,
  botUsername: 'atra_bot',
});

describe('GatewayTransport', () => {
  it('connects with the bearer header and subprotocol, then says hello', () => {
    const rig = gatewayRig();
    rig.transport.start(rig.handlers);
    const socket = rig.sockets[0]!;
    expect(socket.url).toBe('wss://gateway.example/v1/ws');
    expect(socket.init.protocols).toEqual([SUBPROTOCOL]);
    expect(socket.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(rig.transport.status().connected).toBe(false);

    socket.open();
    const [hello] = socket.frames();
    expect(hello).toMatchObject({
      v: 1,
      type: 'hello',
      installationId: 'inst-1',
      runtimeVersion: '0.1.0',
      capabilities: ['telegram'],
    });
    // Not connected until the welcome: a hello without an answer is nothing.
    expect(rig.transport.status().connected).toBe(false);
    socket.receive(welcome(true));
    expect(rig.transport.status().connected).toBe(true);
    expect(rig.transport.status().botUsername).toBe('atra_bot');
    expect(rig.events.welcomes).toHaveLength(1);
    expect(rig.events.connected).toBe(1);
  });

  it('forwards commands to the handler and replies with the same requestId', async () => {
    const rig = gatewayRig();
    rig.transport.start(rig.handlers);
    const socket = rig.sockets[0]!;
    socket.open();
    socket.receive(welcome(true));
    socket.receive({
      v: 1,
      type: 'command',
      id: 'c1',
      ts: 1,
      requestId: 'req-9',
      updateId: 77,
      telegram: { userId: 1, chatId: 1, displayName: 'op' },
      text: '/status',
      receivedAt: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.events.commands[0]).toMatchObject({
      requestId: 'req-9',
      updateId: 77,
      source: 'gateway',
    });
    const reply = socket.frames().find((frame) => frame.type === 'reply');
    expect(reply).toMatchObject({ requestId: 'req-9', text: 'echo:/status' });
  });

  it('relays paired / unpaired frames and ignores unknown or malformed ones', () => {
    const rig = gatewayRig();
    rig.transport.start(rig.handlers);
    const socket = rig.sockets[0]!;
    socket.open();
    socket.receive(welcome(false));
    socket.receive({
      v: 1,
      type: 'paired',
      id: 'p',
      ts: 1,
      telegram: { userId: 5, chatId: 6, displayName: 'x' },
      pairedAt: 123,
    });
    socket.receive({ v: 1, type: 'unpaired', id: 'u', ts: 1, reason: 'operator' });
    socket.receive({ v: 1, type: 'something-new', id: 'n', ts: 1 });
    socket.receive('garbage');
    expect(rig.events.paired).toEqual([
      { identity: { userId: 5, chatId: 6, displayName: 'x' }, pairedAt: 123 },
    ]);
    expect(rig.events.unpaired).toEqual(['operator']);
    expect(rig.transport.status().connected).toBe(true);
  });

  it('sends notify, pair.offer and pair.revoke only while connected', async () => {
    const rig = gatewayRig();
    await expect(rig.transport.notify('x', 'y')).rejects.toThrow(/not connected/);
    rig.transport.start(rig.handlers);
    const socket = rig.sockets[0]!;
    socket.open();
    await expect(rig.transport.offerPairCode('h', 1)).rejects.toThrow(/not connected/);
    socket.receive(welcome(false));
    await rig.transport.offerPairCode('abc', 99);
    await rig.transport.notify('trade.filled', 'text');
    await rig.transport.revokePairing();
    const types = socket.frames().map((frame) => frame.type);
    expect(types).toEqual(['hello', 'pair.offer', 'notify', 'pair.revoke']);
    expect(socket.frames()[1]).toMatchObject({ codeHash: 'abc', expiresAt: 99 });
  });

  it('pings every 30 s, answers pings, and reconnects after three missed pongs', () => {
    const rig = gatewayRig();
    rig.transport.start(rig.handlers);
    const socket = rig.sockets[0]!;
    socket.open();
    socket.receive(welcome(true));

    rig.timers.advance(GATEWAY_DEFAULTS.heartbeatMs);
    expect(socket.sent.filter((s) => s === PING_FRAME)).toHaveLength(1);
    socket.receive(PONG_FRAME);
    socket.receive(PING_FRAME);
    expect(socket.sent.filter((s) => s === PONG_FRAME)).toHaveLength(1);

    // Three unanswered pings, then the fourth tick drops the socket.
    rig.timers.advance(GATEWAY_DEFAULTS.heartbeatMs * 3);
    expect(socket.sent.filter((s) => s === PING_FRAME)).toHaveLength(4);
    expect(socket.closed).toBeNull();
    rig.timers.advance(GATEWAY_DEFAULTS.heartbeatMs);
    expect(socket.closed?.reason).toBe('heartbeat lost');
    expect(rig.transport.status().connected).toBe(false);
    expect(rig.events.disconnected).toEqual(['heartbeat lost']);

    // Reconnect is scheduled with backoff (attempt 1: 1 s × jitter 1.0).
    expect(rig.sockets).toHaveLength(1);
    rig.timers.advance(999);
    expect(rig.sockets).toHaveLength(1);
    rig.timers.advance(1);
    expect(rig.sockets).toHaveLength(2);
  });

  it('backs off exponentially with jitter up to 60 s and resets after a welcome', () => {
    const rig = gatewayRig();
    expect(rig.transport.backoffDelayMs(1)).toBe(1_000);
    expect(rig.transport.backoffDelayMs(2)).toBe(2_000);
    expect(rig.transport.backoffDelayMs(6)).toBe(32_000);
    expect(rig.transport.backoffDelayMs(7)).toBe(60_000);
    expect(rig.transport.backoffDelayMs(20)).toBe(60_000);

    rig.transport.start(rig.handlers);
    // Two failed connections.
    rig.sockets[0]!.emit('close', { code: 1006, reason: '' });
    expect(rig.transport.status().reconnectAttempts).toBe(1);
    rig.timers.advance(1_000);
    rig.sockets[1]!.emit('close', { code: 1006, reason: '' });
    expect(rig.transport.status().reconnectAttempts).toBe(2);
    rig.timers.advance(2_000);
    const third = rig.sockets[2]!;
    third.open();
    third.receive(welcome(false));
    expect(rig.transport.status().reconnectAttempts).toBe(0);
    expect(rig.events.connected).toBe(1);
  });

  it('gives up on a socket that never opens', () => {
    const rig = gatewayRig();
    rig.transport.start(rig.handlers);
    rig.timers.advance(GATEWAY_DEFAULTS.connectTimeoutMs);
    expect(rig.sockets[0]!.closed?.reason).toBe('connect timeout');
    expect(rig.transport.status().lastError).toBe('connect timeout');
    rig.timers.advance(1_000);
    expect(rig.sockets).toHaveLength(2);
  });

  it('stops cleanly and does not reconnect afterwards', async () => {
    const rig = gatewayRig();
    rig.transport.start(rig.handlers);
    const socket = rig.sockets[0]!;
    socket.open();
    socket.receive(welcome(true));
    await rig.transport.stop();
    expect(socket.closed?.code).toBe(1000);
    rig.timers.advance(120_000);
    expect(rig.sockets).toHaveLength(1);
    expect(rig.timers.pending()).toBe(0);
  });

  it('never writes the token anywhere but the upgrade header', () => {
    const rig = gatewayRig();
    rig.transport.start(rig.handlers);
    const socket = rig.sockets[0]!;
    socket.open();
    socket.receive(welcome(true));
    socket.emit('error', { message: `refused ${TOKEN}` });
    expect(rig.transport.status().lastError).toBe(`refused ${REDACTED}`);
    expect(JSON.stringify(socket.sent)).not.toContain(TOKEN);
    expect(JSON.stringify(rig.transport.status())).not.toContain(TOKEN);
  });
});

// --- direct --------------------------------------------------------------------------

const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

function directRig(script: { updates?: unknown[]; fail?: boolean }) {
  const calls: Array<{ url: string; body: any }> = [];
  let offset: number | undefined;
  const fetchFake = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    calls.push({ url, body });
    const method = url.split('/').at(-1);
    if (script.fail) return Promise.reject(new Error(`connect failed for ${url}`));
    const json = (payload: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }),
      );
    if (method === 'getMe')
      return json({ ok: true, result: { id: 1, is_bot: true, username: 'my_bot' } });
    if (method === 'getUpdates') {
      const from = typeof body.offset === 'number' ? body.offset : 0;
      const pending = (script.updates ?? []).filter(
        (update) =>
          typeof (update as { update_id?: unknown }).update_id !== 'number' ||
          (update as { update_id: number }).update_id >= from,
      );
      // A malformed update is only served once, as Telegram would after the offset moves past it.
      return json({
        ok: true,
        result:
          from === 0 ? pending : pending.filter((u) => typeof (u as any).update_id === 'number'),
      });
    }
    if (method === 'sendMessage') return json({ ok: true, result: { message_id: 1 } });
    return json({ ok: false, error_code: 404, description: 'Not Found' });
  }) as typeof fetch;

  const commands: InboundCommand[] = [];
  const handlers: TransportEvents = {
    onCommand: (command) => {
      commands.push(command);
      return Promise.resolve(command.text === '/silent' ? null : `reply to ${command.text}`);
    },
    onPaired: () => {},
    onUnpaired: () => {},
    onWelcome: () => {},
    onConnected: () => {},
    onDisconnected: () => {},
  };
  const transport = new DirectBotTransport({
    token: BOT_TOKEN,
    fetch: fetchFake,
    offset: {
      load: () => offset,
      save: (next) => {
        offset = next;
      },
    },
    linkedChatId: () => 4242,
    pollTimeoutSec: 1,
    timers: new ManualTimers(),
  });
  return { transport, calls, commands, handlers, offset: () => offset };
}

describe('DirectBotTransport', () => {
  it('long-polls getUpdates, hands text messages from private chats to the handler, replies, and advances the offset', async () => {
    const rig = directRig({
      updates: [
        {
          update_id: 10,
          message: {
            message_id: 1,
            from: { id: 7, is_bot: false, first_name: 'Riz', last_name: 'K' },
            chat: { id: 7, type: 'private' },
            date: 1_700_000_000,
            text: '/status',
          },
        },
        {
          update_id: 11,
          message: {
            message_id: 2,
            from: { id: 8 },
            chat: { id: 8, type: 'group' },
            date: 1,
            text: '/pause',
          },
        },
        {
          update_id: 12,
          message: {
            message_id: 3,
            from: { id: 9, is_bot: true },
            chat: { id: 9, type: 'private' },
            date: 1,
            text: '/pause',
          },
        },
        { update_id: 13, edited_message: {} },
        { update_id: 'bad' },
      ],
    });
    rig.transport.start(rig.handlers);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rig.transport.stop();

    expect(rig.commands).toHaveLength(1);
    expect(rig.commands[0]).toMatchObject({
      updateId: 10,
      telegram: { userId: 7, chatId: 7, displayName: 'Riz K' },
      text: '/status',
      receivedAt: 1_700_000_000_000,
      source: 'direct',
    });
    const sendCalls = rig.calls.filter((call) => call.url.endsWith('/sendMessage'));
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.body).toEqual({ chat_id: 7, text: 'reply to /status' });
    expect(sendCalls[0]!.body.parse_mode).toBeUndefined();
    expect(rig.offset()).toBe(14);
    expect(rig.transport.status().botUsername).toBe('my_bot');
    const poll = rig.calls.find((call) => call.url.endsWith('/getUpdates'))!;
    expect(poll.body).toMatchObject({ timeout: 1, allowed_updates: ['message'] });
  });

  it('sends notifications to the linked chat and reports a Telegram error without the token', async () => {
    const rig = directRig({});
    await rig.transport.notify('trade.filled', 'hello');
    const call = rig.calls.at(-1)!;
    expect(call.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(call.body).toEqual({ chat_id: 4242, text: 'hello' });

    const failing = directRig({ fail: true });
    await expect(failing.transport.notify('x', 'y')).rejects.toThrow(/sendMessage/);
    try {
      await failing.transport.notify('x', 'y');
    } catch (error) {
      expect((error as Error).message).not.toContain(BOT_TOKEN);
      expect((error as Error).message).toContain(REDACTED);
    }
  });
});
