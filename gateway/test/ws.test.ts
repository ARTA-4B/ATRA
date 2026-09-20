import { runDurableObjectAlarm } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLOSE_RATE_LIMITED,
  FRAME_LIMIT_PER_MINUTE,
  HUB_NAME,
  NOTIFY_LIMIT_PER_HOUR,
  PAIR_OFFER_LIMIT_PER_MINUTE,
} from '../src/hub.js';
import { OFFLINE_TEXT } from '../src/webhook.js';
import {
  connectRuntime,
  connectedRuntime,
  frame,
  linkRow,
  makeUpdate,
  mintToken,
  openSocket,
  pairRuntime,
  postWebhook,
  settle,
  stubTelegram,
  wsRequest,
} from './helpers.js';
import type { TelegramStub } from './helpers.js';

let telegram: TelegramStub;
let userSeq = 0;
const nextUser = () => 800_000_000 + userSeq++ * 3;

beforeEach(() => {
  telegram = stubTelegram();
});
afterEach(() => {
  telegram.restore();
});

describe('GET /v1/ws: authentication', () => {
  it('rejects a missing, malformed or unknown bearer token with 401', async () => {
    expect((await openSocket(wsRequest(null))).status).toBe(401);
    expect((await openSocket(wsRequest('not-a-token'))).status).toBe(401);
    const minted = await mintToken();
    const forged = `${minted.token.slice(0, -1)}${minted.token.endsWith('A') ? 'B' : 'A'}`;
    expect((await openSocket(wsRequest(forged))).status).toBe(401);
  });

  it('rejects a revoked and an expired token', async () => {
    const revoked = await mintToken();
    await env.DB.prepare('UPDATE install_tokens SET revoked_at = ? WHERE install_id = ?')
      .bind(Date.now(), revoked.installId)
      .run();
    expect((await openSocket(wsRequest(revoked.token))).status).toBe(401);

    const expired = await mintToken({ ttlMs: -1 });
    expect((await openSocket(wsRequest(expired.token))).status).toBe(401);
  });

  it('requires the atra.v1 subprotocol and a WebSocket upgrade', async () => {
    const minted = await mintToken();
    const noProto = new Request('https://gateway.test/v1/ws', {
      headers: { upgrade: 'websocket', authorization: `Bearer ${minted.token}` },
    });
    expect((await openSocket(noProto)).status).toBe(400);
    const noUpgrade = new Request('https://gateway.test/v1/ws', {
      headers: { authorization: `Bearer ${minted.token}`, 'sec-websocket-protocol': 'atra.v1' },
    });
    expect((await openSocket(noUpgrade)).status).toBe(426);
  });

  it('accepts a good token with 101, echoes the subprotocol and answers hello with welcome', async () => {
    const minted = await mintToken();
    const response = await openSocket(wsRequest(minted.token));
    expect(response.status).toBe(101);
    expect(response.headers.get('sec-websocket-protocol')).toBe('atra.v1');
    expect(response.webSocket).toBeTruthy();
    response.webSocket!.accept();
    response.webSocket!.close(1000, 'done');

    const runtime = await connectRuntime(minted.token, minted.installId);
    const welcome = await runtime.hello();
    expect(welcome).toMatchObject({
      v: 1,
      type: 'welcome',
      paired: false,
      telegram: null,
      botUsername: 'atra_test_bot',
    });
    expect(typeof welcome.id).toBe('string');
    expect(typeof welcome.ts).toBe('number');
    await runtime.close();
  });

  it('is rate limited by the RL_WS binding when present', async () => {
    // Exercised through the handler with a stub binding: the real binding
    // exists only in the deployed environments.
    const { default: worker } = await import('../src/index.js');
    const minted = await mintToken();
    const limited = {
      ...env,
      RL_WS: { limit: () => Promise.resolve({ success: false }) },
    } as typeof env;
    const response = await worker.fetch(wsRequest(minted.token), limited, {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    });
    expect(response.status).toBe(429);
  });
});

describe('Hub: frames', () => {
  it('answers the literal ping with the literal pong (auto-response)', async () => {
    const { runtime } = await connectedRuntime();
    runtime.sendRaw('ping');
    expect(await runtime.next()).toBe('pong');
    await runtime.close();
  });

  it('rejects frames before hello and frames that do not validate', async () => {
    const minted = await mintToken();
    const runtime = await connectRuntime(minted.token, minted.installId);

    runtime.send(frame('reply', { requestId: 'x', text: 'y' }));
    expect(await runtime.next()).toMatchObject({ type: 'error', code: 'hello_required' });

    await runtime.hello();
    runtime.sendRaw('{not json');
    expect(await runtime.next()).toMatchObject({ type: 'error', code: 'not_json' });
    runtime.send({ v: 2, type: 'hello', id: '1', ts: 1 });
    expect(await runtime.next()).toMatchObject({ type: 'error', code: 'invalid_frame' });
    runtime.send(frame('pair.offer', { codeHash: 'short', expiresAt: Date.now() + 1000 }));
    expect(await runtime.next()).toMatchObject({ type: 'error', code: 'invalid_frame' });
    runtime.send(frame('launch.missiles'));
    expect(await runtime.next()).toMatchObject({ type: 'error', code: 'invalid_frame' });
    await runtime.close();
  });

  it('routes by the token, not by hello.installationId (the runtime reports its local id)', async () => {
    const minted = await mintToken();
    const runtime = await connectRuntime(minted.token, minted.installId);
    const welcome = await runtime.hello('pending-setup');
    expect(welcome).toMatchObject({ type: 'welcome', paired: false });

    // Commands for the token's installation still reach this socket.
    const userId = nextUser();
    await pairRuntime(runtime, telegram, { userId });
    const posted = postWebhook(makeUpdate({ userId, text: '/status' }));
    const command = await runtime.next();
    expect(command.type).toBe('command');
    runtime.send(frame('reply', { requestId: command.requestId, text: 'ok' }));
    await posted;
    expect(telegram.sent.at(-1)).toEqual({ chatId: userId, text: 'ok' });
    await runtime.close();
  });

  it('a pair.offer in the past is refused', async () => {
    const { runtime } = await connectedRuntime();
    runtime.send(frame('pair.offer', { codeHash: 'a'.repeat(64), expiresAt: Date.now() - 1 }));
    expect(await runtime.next()).toMatchObject({ type: 'error', code: 'offer_expired' });
    await runtime.close();
  });

  it('welcome reports the existing link on reconnect', async () => {
    const minted = await mintToken();
    const first = await connectRuntime(minted.token, minted.installId);
    await first.hello();
    const userId = nextUser();
    await pairRuntime(first, telegram, { userId, username: 'bob' });
    await first.close();

    const second = await connectRuntime(minted.token, minted.installId);
    const welcome = await second.hello();
    expect(welcome).toMatchObject({
      type: 'welcome',
      paired: true,
      telegram: { userId, chatId: userId, displayName: '@bob' },
    });
    await second.close();
  });

  it('pair.revoke clears the link and unused codes and answers unpaired', async () => {
    const { runtime } = await connectedRuntime();
    const userId = nextUser();
    await pairRuntime(runtime, telegram, { userId });
    expect(await linkRow(runtime.installId)).not.toBeNull();

    runtime.send(frame('pair.revoke'));
    expect(await runtime.next()).toMatchObject({ type: 'unpaired', reason: 'revoked by runtime' });
    expect(await linkRow(runtime.installId)).toBeNull();

    // The user is a stranger again.
    const result = await postWebhook(makeUpdate({ userId, text: '/status' }));
    expect(result.body.outcome).toBe('unpaired_hint');
    expect(await runtime.maybeNext(300)).toBeNull();
    await runtime.close();
  });

  it('a new connection for the same installation supersedes the old one', async () => {
    const minted = await mintToken();
    const first = await connectRuntime(minted.token, minted.installId);
    await first.hello();
    const second = await connectRuntime(minted.token, minted.installId);
    await second.hello();
    const closed = await first.closed;
    expect(closed.code).toBe(4001);
    await second.close();
  });
});

describe('Hub: command forwarding', () => {
  it("forwards a linked user's /status and relays the runtime's reply to sendMessage", async () => {
    const { runtime } = await connectedRuntime();
    const userId = nextUser();
    await pairRuntime(runtime, telegram, { userId, username: 'carol' });

    const update = makeUpdate({ userId, text: '/status' });
    const posted = postWebhook(update);
    const command = await runtime.next();
    expect(command).toMatchObject({
      v: 1,
      type: 'command',
      updateId: update.update_id,
      telegram: { userId, chatId: userId, displayName: '@carol' },
      text: '/status',
    });
    expect(typeof command.requestId).toBe('string');
    expect(command.receivedAt).toBe(update.message.date * 1000);

    runtime.send(frame('reply', { requestId: command.requestId, text: 'PAPER · 2 positions' }));
    const { response, body } = await posted;
    expect(response.status).toBe(200);
    expect(body.outcome).toBe('forwarded');
    expect(telegram.sent.at(-1)).toEqual({ chatId: userId, text: 'PAPER · 2 positions' });
    await runtime.close();
  });

  it('answers "offline" when the runtime does not reply within the timeout', async () => {
    const { runtime } = await connectedRuntime();
    const userId = nextUser();
    await pairRuntime(runtime, telegram, { userId });

    const posted = postWebhook(makeUpdate({ userId, text: '/portfolio' }));
    const command = await runtime.next();
    expect(command.type).toBe('command');
    // The runtime stays silent.
    await posted;
    expect(telegram.sent.at(-1)).toEqual({ chatId: userId, text: OFFLINE_TEXT });

    // A reply after the deadline is ignored, not delivered.
    runtime.send(frame('reply', { requestId: command.requestId, text: 'too late' }));
    await settle(100);
    expect(telegram.sent.at(-1)).toEqual({ chatId: userId, text: OFFLINE_TEXT });
    await runtime.close();
  }, 15_000);

  it('notify reaches the linked chat and is ignored when unpaired', async () => {
    const { runtime } = await connectedRuntime();
    runtime.send(frame('notify', { kind: 'runtime', text: 'nobody is listening' }));
    await settle(100);
    expect(telegram.sent).toEqual([]);

    const userId = nextUser();
    await pairRuntime(runtime, telegram, { userId });
    runtime.send(frame('notify', { kind: 'trade', text: 'PAPER buy filled' }));
    await telegram.waitForSent(2);
    expect(telegram.sent.at(-1)).toEqual({ chatId: userId, text: 'PAPER buy filled' });
    await runtime.close();
  });
});

describe('Hub: alarm', () => {
  it('is armed while a socket exists and re-arms only while sockets remain', async () => {
    const stub = env.HUB.getByName(HUB_NAME);
    const { runtime } = await connectedRuntime();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // Re-armed because a live socket exists.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runtime.maybeNext(100)).toBeNull();

    await runtime.close();
    await settle(100);
    // The alarm set by the last run fires once more, finds no socket and
    // does not re-arm.
    await runDurableObjectAlarm(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
});

describe('Hub: inbound frame budget', () => {
  it('keeps the budgets small enough to still be budgets', () => {
    // A budget that drifts upward stops being one, and the tests below scale
    // with these numbers, so the numbers themselves are pinned.
    expect(FRAME_LIMIT_PER_MINUTE).toBeLessThanOrEqual(120);
    expect(NOTIFY_LIMIT_PER_HOUR).toBeLessThanOrEqual(60);
    expect(PAIR_OFFER_LIMIT_PER_MINUTE).toBeLessThanOrEqual(10);
  });

  it('closes a socket that spends the per-minute frame budget', async () => {
    // hello is the first frame of the window.
    const { runtime } = await connectedRuntime();
    // A reply nobody is waiting for is logged and answered with nothing, so
    // the budget is the only thing these frames spend.
    for (let i = 1; i < FRAME_LIMIT_PER_MINUTE; i += 1) {
      runtime.send(frame('reply', { requestId: `gone-${i}`, text: 'x' }));
    }
    expect(await runtime.maybeNext(300)).toBeNull();

    runtime.send(frame('reply', { requestId: 'one-too-many', text: 'x' }));
    expect(await runtime.next()).toMatchObject({ type: 'error', code: 'rate_limited' });
    expect((await runtime.closed).code).toBe(CLOSE_RATE_LIMITED);
  });

  it('stops relaying at the hourly notify budget and closes the socket', async () => {
    const { runtime } = await connectedRuntime();
    const userId = nextUser();
    await pairRuntime(runtime, telegram, { userId });
    const before = telegram.sent.length;

    for (let i = 0; i < NOTIFY_LIMIT_PER_HOUR; i += 1) {
      runtime.send(frame('notify', { kind: 'trade', text: `fill ${i}` }));
    }
    await telegram.waitForSent(before + NOTIFY_LIMIT_PER_HOUR, 10_000);

    runtime.send(frame('notify', { kind: 'trade', text: 'one too many' }));
    expect(await runtime.next()).toMatchObject({ type: 'error', code: 'rate_limited' });
    expect((await runtime.closed).code).toBe(CLOSE_RATE_LIMITED);
    await settle(200);
    // The frame over the cap costs no Telegram call.
    expect(telegram.sent).toHaveLength(before + NOTIFY_LIMIT_PER_HOUR);
  });

  it('closes a socket that offers more pair codes a minute than the budget allows', async () => {
    const { runtime } = await connectedRuntime();
    for (let i = 0; i < PAIR_OFFER_LIMIT_PER_MINUTE; i += 1) {
      const codeHash = `${i}`.padStart(64, 'b');
      runtime.send(frame('pair.offer', { codeHash, expiresAt: Date.now() + 60_000 }));
    }
    expect(await runtime.maybeNext(300)).toBeNull();

    runtime.send(frame('pair.offer', { codeHash: 'c'.repeat(64), expiresAt: Date.now() + 60_000 }));
    expect(await runtime.next()).toMatchObject({ type: 'error', code: 'rate_limited' });
    expect((await runtime.closed).code).toBe(CLOSE_RATE_LIMITED);
  });

  it('leaves a runtime that keeps to a normal rate alone', async () => {
    const { runtime } = await connectedRuntime();
    const userId = nextUser();
    await pairRuntime(runtime, telegram, { userId });
    const before = telegram.sent.length;

    for (let i = 0; i < 5; i += 1) {
      runtime.send(frame('notify', { kind: 'trade', text: `fill ${i}` }));
    }
    await telegram.waitForSent(before + 5);
    expect(await runtime.maybeNext(200)).toBeNull();

    // And the socket still answers a command afterwards.
    const posted = postWebhook(makeUpdate({ userId, text: '/status' }));
    const command = await runtime.next();
    runtime.send(frame('reply', { requestId: command.requestId, text: 'ok' }));
    await posted;
    expect(telegram.sent.at(-1)).toEqual({ chatId: userId, text: 'ok' });
    await runtime.close();
  });
});
