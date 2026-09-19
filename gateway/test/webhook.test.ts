import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HELP_TEXT,
  OFFLINE_TEXT,
  PAIR_FAILED_TEXT,
  REFUSED_TEXT,
  UNPAIRED_HINT,
  pairedText,
} from '../src/webhook.js';
import {
  connectedRuntime,
  frame,
  linkRow,
  makeUpdate,
  mintToken,
  pairCodeRow,
  pairRuntime,
  postWebhook,
  settle,
  sha256Hex,
  stubTelegram,
} from './helpers.js';
import type { TelegramStub } from './helpers.js';

let telegram: TelegramStub;
let userSeq = 0;
const nextUser = () => 700_000_000 + userSeq++ * 7 + Math.floor(Math.random() * 5);

beforeEach(() => {
  telegram = stubTelegram();
});
afterEach(() => {
  telegram.restore();
});

describe('POST /tg/webhook: authentication', () => {
  it('rejects a missing secret header with 401 and sends nothing', async () => {
    const { response } = await postWebhook(makeUpdate({ userId: nextUser(), text: '/start' }), {
      secret: null,
    });
    expect(response.status).toBe(401);
    expect(telegram.sent).toEqual([]);
  });

  it('rejects a wrong secret header with 401', async () => {
    const { response } = await postWebhook(makeUpdate({ userId: nextUser(), text: '/start' }), {
      secret: 'not-the-secret',
    });
    expect(response.status).toBe(401);
    expect(telegram.sent).toEqual([]);
  });

  it('acknowledges a malformed body with 200 so Telegram does not retry it', async () => {
    const { response } = await postWebhook('{not json');
    expect(response.status).toBe(200);
    const shape = await postWebhook({ hello: 'world' });
    expect(shape.response.status).toBe(200);
    expect(telegram.sent).toEqual([]);
  });
});

describe('POST /tg/webhook: local commands', () => {
  it('answers /start and /help with the pairing instructions', async () => {
    const userId = nextUser();
    const start = await postWebhook(makeUpdate({ userId, text: '/start' }));
    expect(start.response.status).toBe(200);
    expect(start.body.outcome).toBe('help');
    const help = await postWebhook(makeUpdate({ userId, text: '/help@atra_test_bot' }));
    expect(help.body.outcome).toBe('help');
    expect(telegram.sent).toEqual([
      { chatId: userId, text: HELP_TEXT },
      { chatId: userId, text: HELP_TEXT },
    ]);
    expect(HELP_TEXT).toContain('/pair');
  });

  it('deduplicates (chat_id, update_id): a redelivered update is acknowledged silently', async () => {
    const userId = nextUser();
    const update = makeUpdate({ userId, text: '/start' });
    const first = await postWebhook(update);
    expect(first.body.outcome).toBe('help');
    const again = await postWebhook(update);
    expect(again.response.status).toBe(200);
    expect(again.body.outcome).toBe('duplicate');
    expect(telegram.sent).toHaveLength(1);
  });

  it('ignores group chats, bots and non-text messages', async () => {
    const userId = nextUser();
    const group = await postWebhook(
      makeUpdate({ userId, chatId: -100123, chatType: 'supergroup', text: '/start' }),
    );
    expect(group.body.outcome).toBe('ignored');
    const bot = await postWebhook(makeUpdate({ userId, text: '/start', isBot: true }));
    expect(bot.body.outcome).toBe('ignored');
    const noText = await postWebhook({
      update_id: 42,
      message: { message_id: 1, date: 1, chat: { id: userId, type: 'private' } },
    });
    expect(noText.body.outcome).toBe('ignored');
    expect(telegram.sent).toEqual([]);
  });
});

describe('POST /tg/webhook: pairing', () => {
  it('/pair CODE marks the code used, links the user and tells the runtime', async () => {
    const { runtime, welcome } = await connectedRuntime();
    expect(welcome.type).toBe('welcome');
    expect(welcome.paired).toBe(false);

    const userId = nextUser();
    const { paired, code } = await pairRuntime(runtime, telegram, { userId, username: 'alice' });

    expect(telegram.sent.at(-1)).toEqual({ chatId: userId, text: pairedText(runtime.installId) });
    expect(paired.type).toBe('paired');
    expect(paired.v).toBe(1);
    expect(paired.telegram).toEqual({ userId, chatId: userId, displayName: '@alice' });
    expect(typeof paired.pairedAt).toBe('number');

    const row = await pairCodeRow(await sha256Hex(code.replace('-', '')));
    expect(row?.install_id).toBe(runtime.installId);
    expect(row?.used_at).not.toBeNull();

    const link = await linkRow(runtime.installId);
    expect(link).toEqual({
      install_id: runtime.installId,
      tg_user_id: userId,
      tg_chat_id: userId,
      display_name: '@alice',
    });
    await runtime.close();
  });

  it('accepts the code in lower case and without the dash', async () => {
    const { runtime } = await connectedRuntime();
    const userId = nextUser();
    const codeHash = await sha256Hex('WXYZ2345');
    runtime.send(frame('pair.offer', { codeHash, expiresAt: Date.now() + 60_000 }));
    await settle();
    await postWebhook(makeUpdate({ userId, text: '/pair wxyz2345' }));
    expect(telegram.sent.at(-1)?.text).toBe(pairedText(runtime.installId));
    await runtime.close();
  });

  it('a replayed code fails: single use', async () => {
    const { runtime } = await connectedRuntime();
    const owner = nextUser();
    const { code } = await pairRuntime(runtime, telegram, { userId: owner });

    const attacker = nextUser();
    const replay = await postWebhook(makeUpdate({ userId: attacker, text: `/pair ${code}` }));
    expect(replay.body.outcome).toBe('pair_failed');
    expect(telegram.sent.at(-1)).toEqual({ chatId: attacker, text: PAIR_FAILED_TEXT });

    // The original link is untouched.
    const link = await linkRow(runtime.installId);
    expect(link?.tg_user_id).toBe(owner);
    await runtime.close();
  });

  it('an expired code fails', async () => {
    const minted = await mintToken();
    const codeHash = await sha256Hex('EXPD2345');
    await env.DB.prepare(
      'INSERT INTO pair_codes (code_hash, install_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)',
    )
      .bind(codeHash, minted.installId, Date.now() - 1_000, Date.now() - 400_000)
      .run();

    const userId = nextUser();
    const result = await postWebhook(makeUpdate({ userId, text: '/pair EXPD-2345' }));
    expect(result.body.outcome).toBe('pair_failed');
    expect(telegram.sent).toEqual([{ chatId: userId, text: PAIR_FAILED_TEXT }]);
    expect(await linkRow(minted.installId)).toBeNull();
    const row = await pairCodeRow(codeHash);
    expect(row?.used_at).toBeNull();
  });

  it('a malformed or unknown code fails without touching the database', async () => {
    const userId = nextUser();
    for (const text of ['/pair', '/pair ABC', '/pair ABCD-0OI1', '/pair ZZZZ-9999']) {
      const result = await postWebhook(makeUpdate({ userId, text }));
      expect(result.body.outcome).toBe('pair_failed');
    }
    expect(telegram.sent.every((m) => m.text === PAIR_FAILED_TEXT)).toBe(true);
    expect(telegram.sent).toHaveLength(4);
  });

  it('a new pair.offer replaces the unused code of the same installation', async () => {
    const { runtime } = await connectedRuntime();
    const first = await sha256Hex('FIRST234');
    const second = await sha256Hex('SECD2345');
    runtime.send(frame('pair.offer', { codeHash: first, expiresAt: Date.now() + 60_000 }));
    await settle();
    runtime.send(frame('pair.offer', { codeHash: second, expiresAt: Date.now() + 60_000 }));
    await settle();
    expect(await pairCodeRow(first)).toBeNull();
    expect((await pairCodeRow(second))?.install_id).toBe(runtime.installId);
    await runtime.close();
  });

  it('a user who pairs a second installation is moved, and the old one is told', async () => {
    const a = await connectedRuntime();
    const b = await connectedRuntime();
    const userId = nextUser();
    await pairRuntime(a.runtime, telegram, { userId }, 'AAAA-2345');
    await pairRuntime(b.runtime, telegram, { userId }, 'BBBB-2345');

    const unpaired = await a.runtime.next();
    expect(unpaired.type).toBe('unpaired');
    expect(await linkRow(a.runtime.installId)).toBeNull();
    expect((await linkRow(b.runtime.installId))?.tg_user_id).toBe(userId);
    await a.runtime.close();
    await b.runtime.close();
  });
});

describe('POST /tg/webhook: unlinked users', () => {
  it('gets the generic pairing hint and nothing reaches any runtime', async () => {
    const { runtime } = await connectedRuntime();
    await pairRuntime(runtime, telegram, { userId: nextUser() });

    const stranger = nextUser();
    const result = await postWebhook(makeUpdate({ userId: stranger, text: '/status' }));
    expect(result.body.outcome).toBe('unpaired_hint');
    expect(telegram.sent.at(-1)).toEqual({ chatId: stranger, text: UNPAIRED_HINT });
    expect(await runtime.maybeNext(300)).toBeNull();

    const plain = await postWebhook(makeUpdate({ userId: stranger, text: 'hello there' }));
    expect(plain.body.outcome).toBe('unpaired_hint');
    expect(await runtime.maybeNext(300)).toBeNull();
    await runtime.close();
  });

  it('is rate limited by the RL_UNPAIRED binding when present', async () => {
    const limited = {
      ...env,
      RL_UNPAIRED: { limit: () => Promise.resolve({ success: false }) },
    } as typeof env;
    const stranger = nextUser();
    const result = await postWebhook(makeUpdate({ userId: stranger, text: 'hi' }), {
      env: limited,
    });
    expect(result.body.outcome).toBe('rate_limited');
    expect(telegram.sent).toEqual([]);
  });

  it('is rate limited per chat by the RL_WEBHOOK binding when present', async () => {
    const limited = {
      ...env,
      RL_WEBHOOK: { limit: () => Promise.resolve({ success: false }) },
    } as typeof env;
    const result = await postWebhook(makeUpdate({ userId: nextUser(), text: '/start' }), {
      env: limited,
    });
    expect(result.body.outcome).toBe('rate_limited');
    expect(telegram.sent).toEqual([]);
  });
});

describe('POST /tg/webhook: linked users', () => {
  it('replies "offline" when the installation has no runtime connected', async () => {
    const { runtime } = await connectedRuntime();
    const userId = nextUser();
    await pairRuntime(runtime, telegram, { userId });
    await runtime.close();
    await settle();

    const result = await postWebhook(makeUpdate({ userId, text: '/status' }));
    expect(result.body.outcome).toBe('forwarded');
    expect(telegram.sent.at(-1)).toEqual({ chatId: userId, text: OFFLINE_TEXT });
  });

  it('refuses wallet export and withdrawal commands without forwarding them', async () => {
    const { runtime } = await connectedRuntime();
    const userId = nextUser();
    await pairRuntime(runtime, telegram, { userId });

    for (const text of ['/export', '/withdraw 1 ETH', '/seed', '/privatekey']) {
      const result = await postWebhook(makeUpdate({ userId, text }));
      expect(result.body.outcome).toBe('refused');
      expect(telegram.sent.at(-1)).toEqual({ chatId: userId, text: REFUSED_TEXT });
    }
    expect(await runtime.maybeNext(300)).toBeNull();
    await runtime.close();
  });
});
