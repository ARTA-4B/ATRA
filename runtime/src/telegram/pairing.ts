import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { AuditLog } from '../audit/audit.js';
import { childLogger } from '../logging/logger.js';
import { PAIR_CODE_TTL_MS, generatePairCode, hashPairCode, normalizePairCode } from './protocol.js';
import type { PairStatus, TelegramIdentity, TelegramLink, TransportKind } from './types.js';
import { maskUserId } from './types.js';

/**
 * Pairing: the one-time handshake between this installation and a Telegram
 * account.
 *
 *   dashboard: POST /telegram/pair ──> code shown once, sha256 stored
 *   operator:  /pair CODE to the bot
 *   gateway or direct transport: verify ──> UPDATE ... WHERE used_at IS NULL
 *                                           AND expires_at > now
 *   runtime:   telegram_link written; every command is checked against it
 *
 * The database never holds the code itself. A new code retires every older
 * unused one, so there is exactly one code that can succeed at any moment.
 */

export interface PairingDeps {
  db: Db;
  audit: AuditLog;
  now?: () => number;
}

export interface IssuedPairCode {
  code: string;
  codeHash: string;
  expiresAt: number;
}

export type VerifyResult =
  | { ok: true; link: TelegramLink }
  | { ok: false; reason: 'malformed' | 'unknown' | 'expired' | 'used' | 'superseded' };

interface CodeRow {
  id: string;
  code_hash: string;
  transport: TransportKind;
  expires_at: number;
  used_at: number | null;
  invalidated_at: number | null;
}

interface LinkRow {
  user_id: number;
  chat_id: number;
  display_name: string;
  transport: TransportKind;
  paired_at: string;
}

export class PairingService {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #now: () => number;
  readonly #log = childLogger('telegram-pairing');

  constructor(deps: PairingDeps) {
    this.#db = deps.db;
    this.#audit = deps.audit;
    this.#now = deps.now ?? (() => Date.now());
  }

  /** Issue a code. Every older unused code is retired in the same transaction. */
  issue(transport: TransportKind): IssuedPairCode {
    const now = this.#now();
    const code = generatePairCode();
    const codeHash = hashPairCode(code);
    const expiresAt = now + PAIR_CODE_TTL_MS;

    const write = this.#db.transaction(() => {
      this.#db
        .prepare(
          'UPDATE telegram_pair_codes SET invalidated_at = ?' +
            ' WHERE used_at IS NULL AND invalidated_at IS NULL',
        )
        .run(now);
      this.#db
        .prepare(
          'INSERT INTO telegram_pair_codes (id, code_hash, transport, created_at, expires_at)' +
            ' VALUES (?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), codeHash, transport, new Date(now).toISOString(), expiresAt);
      this.#prune(now);
    });
    write();

    this.#audit.append({
      category: 'telegram',
      action: 'telegram.pair.issued',
      status: 'pending',
      summary: 'Telegram pairing code issued',
      actor: 'operator',
      detail: { transport, expiresAt: new Date(expiresAt).toISOString() },
    });

    return { code, codeHash, expiresAt };
  }

  /** The dashboard polls this. Unknown codes read as expired: nothing to learn from them. */
  status(code: string): PairStatus {
    const normalized = normalizePairCode(code);
    if (!normalized) return 'expired';
    const row = this.#db
      .prepare<[string], CodeRow>('SELECT * FROM telegram_pair_codes WHERE code_hash = ?')
      .get(hashPairCode(normalized));
    if (!row) return 'expired';
    if (row.used_at !== null) return 'confirmed';
    if (row.invalidated_at !== null || row.expires_at <= this.#now()) return 'expired';
    return 'pending';
  }

  /** The current pending offer, so a reconnecting gateway transport can re-offer it. */
  pending(): { codeHash: string; expiresAt: number } | undefined {
    const row = this.#db
      .prepare<[number], CodeRow>(
        'SELECT * FROM telegram_pair_codes WHERE used_at IS NULL AND invalidated_at IS NULL' +
          ' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1',
      )
      .get(this.#now());
    return row ? { codeHash: row.code_hash, expiresAt: row.expires_at } : undefined;
  }

  /**
   * Direct transport: verify a code the operator sent to the bot and link the
   * identity, atomically. The UPDATE is the single-use guard; two concurrent
   * attempts with the same code cannot both see `changes === 1`.
   */
  verify(code: string, identity: TelegramIdentity, transport: TransportKind): VerifyResult {
    const normalized = normalizePairCode(code);
    if (!normalized) {
      this.#auditRejected(identity, 'malformed');
      return { ok: false, reason: 'malformed' };
    }
    const codeHash = hashPairCode(normalized);
    const now = this.#now();

    const outcome = this.#db.transaction((): VerifyResult => {
      const consumed = this.#db
        .prepare(
          'UPDATE telegram_pair_codes SET used_at = ? WHERE code_hash = ?' +
            ' AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > ?',
        )
        .run(now, codeHash, now);

      if (Number(consumed.changes) !== 1) {
        const row = this.#db
          .prepare<[string], CodeRow>('SELECT * FROM telegram_pair_codes WHERE code_hash = ?')
          .get(codeHash);
        const reason: Exclude<VerifyResult, { ok: true }>['reason'] = !row
          ? 'unknown'
          : row.used_at !== null
            ? 'used'
            : row.invalidated_at !== null
              ? 'superseded'
              : 'expired';
        return { ok: false, reason };
      }

      return { ok: true, link: this.#writeLink(identity, transport, now) };
    })();

    if (outcome.ok) {
      this.#auditPaired(outcome.link, 'code verified locally');
    } else {
      this.#auditRejected(identity, outcome.reason);
    }
    return outcome;
  }

  /**
   * Gateway transport: the gateway matched the code and tells us who paired.
   * The pending code is consumed here so the dashboard's poll flips to
   * `confirmed`; the identity is stored as the gateway reported it.
   */
  confirmFromGateway(identity: TelegramIdentity, pairedAt: number): TelegramLink {
    const now = this.#now();
    const link = this.#db.transaction(() => {
      this.#db
        .prepare(
          'UPDATE telegram_pair_codes SET used_at = ?' +
            ' WHERE used_at IS NULL AND invalidated_at IS NULL AND expires_at > ?',
        )
        .run(now, now);
      return this.#writeLink(identity, 'gateway', pairedAt);
    })();
    this.#auditPaired(link, 'confirmed by the gateway');
    return link;
  }

  link(): TelegramLink | undefined {
    const row = this.#db.prepare<[], LinkRow>('SELECT * FROM telegram_link WHERE id = 1').get();
    if (!row) return undefined;
    return {
      userId: row.user_id,
      chatId: row.chat_id,
      displayName: row.display_name,
      transport: row.transport,
      pairedAt: row.paired_at,
    };
  }

  /** Remove the link and retire any unused code. Returns whether a link existed. */
  unpair(actor: string, reason: string): boolean {
    const existing = this.link();
    const now = this.#now();
    const write = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM telegram_link WHERE id = 1').run();
      this.#db
        .prepare(
          'UPDATE telegram_pair_codes SET invalidated_at = ?' +
            ' WHERE used_at IS NULL AND invalidated_at IS NULL',
        )
        .run(now);
    });
    write();

    if (existing) {
      this.#audit.append({
        category: 'telegram',
        action: 'telegram.unpaired',
        status: 'ok',
        summary: `Telegram unpaired: ${reason}`,
        actor,
        detail: { userIdMasked: maskUserId(existing.userId), transport: existing.transport },
      });
      this.#log.warn({ actor, reason }, 'telegram unpaired');
    }
    return existing !== undefined;
  }

  #writeLink(identity: TelegramIdentity, transport: TransportKind, pairedAt: number): TelegramLink {
    const pairedIso = new Date(pairedAt).toISOString();
    const nowIso = new Date(this.#now()).toISOString();
    this.#db
      .prepare(
        'INSERT INTO telegram_link (id, user_id, chat_id, display_name, transport, paired_at, updated_at)' +
          ' VALUES (1, ?, ?, ?, ?, ?, ?)' +
          ' ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, chat_id = excluded.chat_id,' +
          ' display_name = excluded.display_name, transport = excluded.transport,' +
          ' paired_at = excluded.paired_at, updated_at = excluded.updated_at',
      )
      .run(
        identity.userId,
        identity.chatId,
        identity.displayName.slice(0, 128),
        transport,
        pairedIso,
        nowIso,
      );
    return {
      ...identity,
      displayName: identity.displayName.slice(0, 128),
      transport,
      pairedAt: pairedIso,
    };
  }

  #auditPaired(link: TelegramLink, how: string): void {
    this.#audit.append({
      category: 'telegram',
      action: 'telegram.paired',
      status: 'ok',
      summary: `Telegram paired with ${link.displayName} (${how})`,
      actor: `telegram:${maskUserId(link.userId)}`,
      detail: { userIdMasked: maskUserId(link.userId), transport: link.transport },
    });
    this.#log.info({ transport: link.transport }, 'telegram paired');
  }

  #auditRejected(identity: TelegramIdentity, reason: string): void {
    this.#audit.append({
      category: 'telegram',
      action: 'telegram.pair.rejected',
      status: 'rejected',
      summary: `Telegram pairing attempt refused (${reason})`,
      actor: `telegram:${maskUserId(identity.userId)}`,
      detail: { reason, userIdMasked: maskUserId(identity.userId) },
    });
  }

  /** Codes older than a day are noise. Called inside the issue transaction. */
  #prune(now: number): void {
    this.#db
      .prepare('DELETE FROM telegram_pair_codes WHERE expires_at < ?')
      .run(now - 24 * 60 * 60 * 1_000);
  }
}
