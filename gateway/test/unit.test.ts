import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sha256Hex, timingSafeEqualStrings, uuidv7 } from '../src/crypto.js';
import { hashPairCode, normalizePairCode, purgeStale } from '../src/pairing.js';
import { decodeRuntimeFrame, encodeFrame } from '../src/protocol.js';
import { displayNameOf, parseCommand } from '../src/telegram.js';
import { TOKEN_RE, bearerToken, generateToken } from '../src/tokens.js';

describe('protocol', () => {
  it('decodes every runtime frame type and rejects the rest', () => {
    const base = { v: 1, id: 'f1', ts: 1 };
    const ok = [
      { ...base, type: 'hello', installationId: 'i', runtimeVersion: '1', capabilities: [] },
      { ...base, type: 'pair.offer', codeHash: 'a'.repeat(64), expiresAt: 10 },
      { ...base, type: 'pair.revoke' },
      { ...base, type: 'reply', requestId: 'r', text: 'hi' },
      { ...base, type: 'notify', kind: 'k', text: 'hi' },
    ];
    for (const f of ok) expect(decodeRuntimeFrame(JSON.stringify(f)).ok).toBe(true);

    expect(decodeRuntimeFrame('nope')).toMatchObject({ ok: false, code: 'not_json' });
    expect(decodeRuntimeFrame(JSON.stringify({ ...base, type: 'command' }))).toMatchObject({
      ok: false,
      code: 'invalid_frame',
    });
    expect(
      decodeRuntimeFrame(JSON.stringify({ ...base, v: 2, type: 'pair.revoke' })),
    ).toMatchObject({ ok: false, code: 'invalid_frame' });
    expect(decodeRuntimeFrame(`"${'x'.repeat(17_000)}"`)).toMatchObject({
      ok: false,
      code: 'too_large',
    });
  });

  it('encodes gateway frames with the envelope', () => {
    const parsed = JSON.parse(encodeFrame({ type: 'unpaired', reason: 'r' }, 123));
    expect(parsed).toMatchObject({ v: 1, type: 'unpaired', ts: 123, reason: 'r' });
    expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('pair codes', () => {
  it('normalizes and hashes exactly like the runtime', async () => {
    expect(normalizePairCode('abcd-2345')).toBe('ABCD2345');
    expect(normalizePairCode(' ABCD 2345 ')).toBe('ABCD2345');
    expect(normalizePairCode('ABCD-0123')).toBeNull(); // 0 and 1 are not in the alphabet
    expect(normalizePairCode('ABCD-23')).toBeNull();
    expect(await hashPairCode('ABCD2345')).toBe(await sha256Hex('ABCD2345'));
    expect(await sha256Hex('ABCD2345')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('tokens', () => {
  it('generates tokens in the documented format', () => {
    const token = generateToken();
    expect(token).toMatch(TOKEN_RE);
    expect(generateToken()).not.toBe(token);
  });

  it('parses bearer headers', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
  });

  it('uuidv7 is ordered by time and well formed', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('constant-time comparison handles different lengths', async () => {
    expect(await timingSafeEqualStrings('abc', 'abc')).toBe(true);
    expect(await timingSafeEqualStrings('abc', 'abcd')).toBe(false);
    expect(await timingSafeEqualStrings('', 'a')).toBe(false);
  });
});

describe('telegram helpers', () => {
  it('parses commands with and without a bot suffix', () => {
    expect(parseCommand('/pair ABCD-2345')).toEqual({ name: 'pair', args: 'ABCD-2345' });
    expect(parseCommand('/Status@atra_bot')).toEqual({ name: 'status', args: '' });
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('/')).toBeNull();
  });

  it('prefers the username and never a phone number', () => {
    expect(displayNameOf({ id: 1, username: 'x', first_name: 'A' })).toBe('@x');
    expect(displayNameOf({ id: 1, first_name: 'A', last_name: 'B' })).toBe('A B');
    expect(displayNameOf({ id: 7 })).toBe('user 7');
  });
});

describe('housekeeping', () => {
  it('purges tg_updates older than 24 h and dead pair codes', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO tg_updates (chat_id, update_id, received_at) VALUES (?, ?, ?)',
      ).bind(1, 1, now - 25 * 60 * 60_000),
      env.DB.prepare(
        'INSERT INTO tg_updates (chat_id, update_id, received_at) VALUES (?, ?, ?)',
      ).bind(1, 2, now),
      env.DB.prepare(
        'INSERT INTO pair_codes (code_hash, install_id, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind('u'.repeat(64), 'i', now + 1000, now, now),
      env.DB.prepare(
        'INSERT INTO pair_codes (code_hash, install_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)',
      ).bind('l'.repeat(64), 'i', now + 1000, now),
    ]);
    const removed = await purgeStale(env.DB, now);
    expect(removed).toEqual({ updates: 1, codes: 1 });
    const left = await env.DB.prepare(
      'SELECT count(*) AS n FROM tg_updates WHERE chat_id = 1',
    ).first<{ n: number }>();
    expect(left?.n).toBe(1);
  });
});
