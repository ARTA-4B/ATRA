import { afterEach, describe, expect, it } from 'vitest';
import { shutdownServices } from '../src/core/services.js';
import { AppError, ErrorCode } from '../src/util/errors.js';
import { PairingService } from '../src/telegram/pairing.js';
import {
  PAIR_CODE_ALPHABET,
  PAIR_CODE_RE,
  PAIR_CODE_TTL_MS,
  generatePairCode,
  hashPairCode,
  normalizePairCode,
} from '../src/telegram/protocol.js';
import { OPERATOR, STRANGER, harness } from './telegram-harness.js';
import type { Harness } from './telegram-harness.js';

/**
 * Pairing is the only moment an unknown Telegram user can become the one
 * user this installation obeys, so every property of the code is asserted:
 * shape, alphabet, lifetime, single use, supersession, that the database
 * holds only a hash, and that a link can never be taken over by a second
 * account without a local unpair first.
 */

describe('pair codes', () => {
  it('match the contract shape and use the unambiguous alphabet', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generatePairCode();
      expect(code).toMatch(PAIR_CODE_RE);
      for (const char of code.replace('-', '')) expect(PAIR_CODE_ALPHABET).toContain(char);
      expect(code).not.toMatch(/[01OI]/);
    }
  });

  it('are generated from the injected random bytes without modulo bias', () => {
    const code = generatePairCode(() => new Uint8Array([0, 1, 31, 32, 33, 63, 255, 2]));
    // Indexes 0, 1, 31, 32&31=0, 33&31=1, 63&31=31, 255&31=31, 2 → A B 9 A B 9 9 C.
    expect(code).toBe('AB9A-B99C');
  });

  it('normalise what the operator typed and hash the dashless upper-case form', () => {
    expect(normalizePairCode('k7zq-4mwd')).toBe('K7ZQ-4MWD');
    expect(normalizePairCode('k7zq4mwd')).toBe('K7ZQ-4MWD');
    expect(normalizePairCode('  K7ZQ 4MWD ')).toBe('K7ZQ-4MWD');
    expect(normalizePairCode('K7ZQ-4MW')).toBeNull();
    expect(normalizePairCode('K7ZQ-4MW0')).toBeNull();
    expect(normalizePairCode('drop table')).toBeNull();
    expect(hashPairCode('K7ZQ-4MWD')).toBe(hashPairCode('k7zq4mwd'));
    expect(hashPairCode('K7ZQ-4MWD')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PairingService', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  function pairing(): PairingService {
    return new PairingService({
      db: h.services.db,
      audit: h.services.audit,
      now: () => h.clock.now,
    });
  }

  it('stores only the hash, with the stated TTL', async () => {
    h = await harness();
    const p = pairing();
    const issued = p.issue('direct');
    expect(issued.expiresAt).toBe(h.clock.now + PAIR_CODE_TTL_MS);
    expect(PAIR_CODE_TTL_MS).toBe(5 * 60_000);

    const rows = h.services.db
      .prepare<[], { code_hash: string }>('SELECT code_hash FROM telegram_pair_codes')
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).toBe(issued.codeHash);
    expect(rows[0]!.code_hash).not.toContain(issued.code.replace('-', ''));
    expect(p.status(issued.code)).toBe('pending');
  });

  it('verifies once, links the identity, and refuses a replay', async () => {
    h = await harness();
    const p = pairing();
    const issued = p.issue('direct');

    const first = p.verify(issued.code.toLowerCase(), OPERATOR, 'direct');
    expect(first.ok).toBe(true);
    expect(p.link()?.userId).toBe(OPERATOR.userId);
    expect(p.link()?.chatId).toBe(OPERATOR.chatId);
    expect(p.status(issued.code)).toBe('confirmed');

    // A stranger is stopped by the link itself, before the code is even read.
    const replay = p.verify(issued.code, STRANGER, 'direct');
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('already_paired');
    // The paired account passes that gate and meets the single-use guard.
    const own = p.verify(issued.code, OPERATOR, 'direct');
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own.reason).toBe('used');
    // The link is untouched by the failed replays.
    expect(p.link()?.userId).toBe(OPERATOR.userId);

    const actions = h.services.audit.list({ category: 'telegram' }).map((row) => row.action);
    expect(actions).toContain('telegram.paired');
    expect(actions).toContain('telegram.pair.rejected');
  });

  it('expires after five minutes', async () => {
    h = await harness();
    const p = pairing();
    const issued = p.issue('direct');
    h.clock.now += PAIR_CODE_TTL_MS + 1;
    expect(p.status(issued.code)).toBe('expired');
    const result = p.verify(issued.code, OPERATOR, 'direct');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
    expect(p.link()).toBeUndefined();
  });

  it('retires older unused codes when a new one is issued', async () => {
    h = await harness();
    const p = pairing();
    const old = p.issue('direct');
    const fresh = p.issue('direct');
    expect(p.status(old.code)).toBe('expired');
    expect(p.status(fresh.code)).toBe('pending');
    const stale = p.verify(old.code, OPERATOR, 'direct');
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('superseded');
    expect(p.verify(fresh.code, OPERATOR, 'direct').ok).toBe(true);
  });

  it('rejects malformed and unknown codes without touching the link', async () => {
    h = await harness();
    const p = pairing();
    p.issue('direct');
    expect(p.verify('nope', OPERATOR, 'direct')).toEqual({ ok: false, reason: 'malformed' });
    expect(p.verify('AAAA-2222', OPERATOR, 'direct')).toEqual({ ok: false, reason: 'unknown' });
    expect(p.status('AAAA-2222')).toBe('expired');
    expect(p.link()).toBeUndefined();
  });

  it('confirms a gateway pairing by consuming the pending code', async () => {
    h = await harness();
    const p = pairing();
    const issued = p.issue('gateway');
    expect(p.pending()?.codeHash).toBe(issued.codeHash);
    const link = p.confirmFromGateway(OPERATOR, h.clock.now);
    expect(link?.transport).toBe('gateway');
    expect(p.status(issued.code)).toBe('confirmed');
    expect(p.pending()).toBeUndefined();
  });

  it('unpairs, retiring any unused code, and re-pairing replaces the singleton', async () => {
    h = await harness();
    const p = pairing();
    expect(p.verify(p.issue('direct').code, OPERATOR, 'direct').ok).toBe(true);
    // Moving the link to another account starts with an unpair, never a code.
    expect(() => p.issue('direct')).toThrow(/already paired/i);
    expect(p.unpair('operator', 'test')).toBe(true);
    expect(p.link()).toBeUndefined();
    expect(p.unpair('operator', 'again')).toBe(false);

    const pendingAfterUnpair = p.issue('direct');
    expect(p.unpair('operator', 'third')).toBe(false);
    expect(p.status(pendingAfterUnpair.code)).toBe('expired');

    expect(p.verify(p.issue('direct').code, STRANGER, 'direct').ok).toBe(true);
    expect(p.link()?.userId).toBe(STRANGER.userId);
    expect(
      h.services.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM telegram_link').get()?.n,
    ).toBe(1);
  });

  it('refuses to issue a code while paired, with the contract error code', async () => {
    h = await harness();
    const p = pairing();
    expect(p.verify(p.issue('direct').code, OPERATOR, 'direct').ok).toBe(true);

    let thrown: unknown;
    try {
      p.issue('direct');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe(ErrorCode.TELEGRAM_ALREADY_PAIRED);
    expect((thrown as AppError).status).toBe(409);
    // Nothing was written: the operator's own pairing is left exactly as it was.
    expect(p.link()?.userId).toBe(OPERATOR.userId);
    expect(p.pending()).toBeUndefined();
    expect(
      h.services.db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM telegram_pair_codes')
        .get()?.n,
    ).toBe(1);
  });

  it('refuses a live code from another account without consuming it', async () => {
    h = await harness();
    const p = pairing();
    const issued = p.issue('direct');
    // issue() now keeps a code and a link from coexisting, so the state this
    // guard defends against has to be written behind the service's back.
    const iso = new Date(h.clock.now).toISOString();
    h.services.db
      .prepare(
        'INSERT INTO telegram_link (id, user_id, chat_id, display_name, transport, paired_at,' +
          ' updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
      )
      .run(OPERATOR.userId, OPERATOR.chatId, OPERATOR.displayName, 'direct', iso, iso);

    const takeover = p.verify(issued.code, STRANGER, 'direct');
    expect(takeover).toEqual({ ok: false, reason: 'already_paired' });
    expect(p.link()?.userId).toBe(OPERATOR.userId);
    // The operator's own code survives the attempt.
    expect(p.status(issued.code)).toBe('pending');
    expect(
      h.services.audit
        .list({ category: 'telegram' })
        .some(
          (row) =>
            row.action === 'telegram.pair.rejected' && row.detail['reason'] === 'already_paired',
        ),
    ).toBe(true);

    // The same account pairing a second chat is a re-pair, not a take-over.
    const moved = p.verify(issued.code, { ...OPERATOR, chatId: 555 }, 'direct');
    expect(moved.ok).toBe(true);
    expect(p.link()?.chatId).toBe(555);
  });

  it('refuses a gateway confirmation that names another account, and audits it', async () => {
    h = await harness();
    const p = pairing();
    const issued = p.issue('gateway');
    expect(p.confirmFromGateway(OPERATOR, h.clock.now)?.userId).toBe(OPERATOR.userId);

    expect(p.confirmFromGateway(STRANGER, h.clock.now)).toBeUndefined();
    expect(p.link()?.userId).toBe(OPERATOR.userId);
    expect(p.status(issued.code)).toBe('confirmed');

    const refused = h.services.audit
      .list({ category: 'telegram' })
      .find((row) => row.action === 'telegram.pair.refused');
    expect(refused?.status).toBe('failed');
    expect(refused?.detail['userIdMasked']).toBe('******321');
    expect(JSON.stringify(refused)).not.toContain(String(STRANGER.userId));

    // The same account reconnecting and re-confirming is still accepted.
    expect(p.confirmFromGateway(OPERATOR, h.clock.now)?.userId).toBe(OPERATOR.userId);
  });
});
