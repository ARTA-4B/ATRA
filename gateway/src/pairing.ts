/**
 * Pairing codes and Telegram links.
 *
 * The runtime generates a code XXXX-XXXX, shows it in the dashboard and sends
 * the gateway only sha256(code without the dash, upper-case) in a "pair.offer"
 * frame. The user sends "/pair CODE" to the bot; the gateway normalizes and
 * hashes the same way and consumes the row with one atomic UPDATE. The code
 * itself is never stored anywhere, and neither is the wire hash: a code has
 * only 40 bits, so a plain sha256 in a leaked D1 export is a brute-forceable
 * code. What pair_codes holds is HMAC-SHA256(TOKEN_PEPPER, wire hash), like
 * the install tokens, and the pepper never touches D1.
 */
import { hmacSha256Hex, sha256Hex } from './crypto.js';
import { PAIR_CODE_NORMALIZED_RE, PAIR_OFFER_MAX_TTL_MS } from './protocol.js';
import type { TelegramIdentity } from './protocol.js';

/** Upper-case, strip the dash and whitespace, validate. Null when malformed. */
export function normalizePairCode(input: string): string | null {
  const normalized = input.trim().toUpperCase().replace(/[-\s]/g, '');
  return PAIR_CODE_NORMALIZED_RE.test(normalized) ? normalized : null;
}

/** sha256 of the normalized code, lowercase hex. Same as the runtime's. */
export function hashPairCode(normalizedCode: string): Promise<string> {
  return sha256Hex(normalizedCode);
}

/** The value kept in pair_codes.code_hash for a wire hash. */
export function storedPairHash(pepper: string, codeHash: string): Promise<string> {
  return hmacSha256Hex(pepper, codeHash);
}

export type StoreOfferResult =
  { ok: true; expiresAt: number } | { ok: false; reason: 'code_in_use' };

/**
 * Store an offered code, replacing any unused code for the same installation
 * so at most one code is live per install. A runtime cannot offer a code that
 * lives longer than PAIR_OFFER_MAX_TTL_MS: it is clamped, not rejected.
 *
 * A hash that another installation is still offering (unused, unexpired) is
 * refused rather than taken over: code_hash is the primary key, and a plain
 * upsert would let one runtime that learned another's hash redirect that
 * runtime's pairing to itself. The upsert's WHERE makes the decision in the
 * same statement, so two offers of one hash cannot both win.
 */
export async function storePairOffer(
  db: D1Database,
  pepper: string,
  installId: string,
  codeHash: string,
  expiresAt: number,
  now: number = Date.now(),
): Promise<StoreOfferResult> {
  const clamped = Math.min(expiresAt, now + PAIR_OFFER_MAX_TTL_MS);
  const stored = await storedPairHash(pepper, codeHash);
  const [, upsert] = await db.batch([
    db.prepare('DELETE FROM pair_codes WHERE install_id = ? AND used_at IS NULL').bind(installId),
    db
      .prepare(
        `INSERT INTO pair_codes (code_hash, install_id, expires_at, used_at, created_at)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT (code_hash) DO UPDATE SET
           install_id = excluded.install_id,
           expires_at = excluded.expires_at,
           used_at = NULL,
           created_at = excluded.created_at
         WHERE pair_codes.used_at IS NOT NULL OR pair_codes.expires_at <= excluded.created_at`,
      )
      .bind(stored, installId, clamped, now),
  ]);
  if ((upsert?.meta.changes ?? 0) === 0) return { ok: false, reason: 'code_in_use' };
  return { ok: true, expiresAt: clamped };
}

/**
 * Consume a code. Exactly one caller can win: the UPDATE only matches an
 * unused, unexpired row and SQLite applies it atomically.
 */
export async function consumePairCode(
  db: D1Database,
  pepper: string,
  codeHash: string,
  now: number = Date.now(),
): Promise<string | null> {
  const row = await db
    .prepare(
      'UPDATE pair_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING install_id',
    )
    .bind(now, await storedPairHash(pepper, codeHash), now)
    .first<{ install_id: string }>();
  return row?.install_id ?? null;
}

export interface LinkRow {
  install_id: string;
  tg_user_id: number;
  tg_chat_id: number;
  display_name: string;
  paired_at: number;
}

export interface TelegramLink {
  installId: string;
  telegram: TelegramIdentity;
  pairedAt: number;
}

function toLink(row: LinkRow): TelegramLink {
  return {
    installId: row.install_id,
    telegram: { userId: row.tg_user_id, chatId: row.tg_chat_id, displayName: row.display_name },
    pairedAt: row.paired_at,
  };
}

export async function getLinkByInstall(
  db: D1Database,
  installId: string,
): Promise<TelegramLink | null> {
  const row = await db
    .prepare(
      'SELECT install_id, tg_user_id, tg_chat_id, display_name, paired_at FROM tg_links WHERE install_id = ?',
    )
    .bind(installId)
    .first<LinkRow>();
  return row ? toLink(row) : null;
}

export async function getLinkByUser(db: D1Database, userId: number): Promise<TelegramLink | null> {
  const row = await db
    .prepare(
      'SELECT install_id, tg_user_id, tg_chat_id, display_name, paired_at FROM tg_links WHERE tg_user_id = ? ORDER BY paired_at DESC LIMIT 1',
    )
    .bind(userId)
    .first<LinkRow>();
  return row ? toLink(row) : null;
}

/**
 * Link a Telegram identity to an installation. One installation has one
 * link, and one Telegram user drives one installation: any other installs
 * this user was linked to are unlinked and returned so the hub can tell them.
 */
export async function linkTelegram(
  db: D1Database,
  installId: string,
  telegram: TelegramIdentity,
  now: number = Date.now(),
): Promise<{ link: TelegramLink; displaced: string[] }> {
  const others = await db
    .prepare('SELECT install_id FROM tg_links WHERE tg_user_id = ? AND install_id <> ?')
    .bind(telegram.userId, installId)
    .all<{ install_id: string }>();
  const displaced = others.results.map((r) => r.install_id);

  const statements = [
    db
      .prepare(
        'INSERT OR REPLACE INTO tg_links (install_id, tg_user_id, tg_chat_id, display_name, paired_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(installId, telegram.userId, telegram.chatId, telegram.displayName, now),
  ];
  if (displaced.length > 0) {
    statements.push(
      db
        .prepare('DELETE FROM tg_links WHERE tg_user_id = ? AND install_id <> ?')
        .bind(telegram.userId, installId),
    );
  }
  await db.batch(statements);

  return { link: { installId, telegram, pairedAt: now }, displaced };
}

/** Remove the link and any unused codes for an installation. */
export async function unlinkInstall(db: D1Database, installId: string): Promise<boolean> {
  const [links] = await db.batch([
    db.prepare('DELETE FROM tg_links WHERE install_id = ?').bind(installId),
    db.prepare('DELETE FROM pair_codes WHERE install_id = ? AND used_at IS NULL').bind(installId),
  ]);
  return (links?.meta.changes ?? 0) > 0;
}

/** Housekeeping for the cron trigger. Returns the number of rows removed. */
export async function purgeStale(
  db: D1Database,
  now: number = Date.now(),
): Promise<{ updates: number; codes: number }> {
  const dayAgo = now - 24 * 60 * 60_000;
  const [updates, codes] = await db.batch([
    db.prepare('DELETE FROM tg_updates WHERE received_at < ?').bind(dayAgo),
    // Used codes and codes that expired more than a day ago carry no
    // information any more; the hash of a dead code is not worth keeping.
    db.prepare('DELETE FROM pair_codes WHERE used_at IS NOT NULL OR expires_at < ?').bind(dayAgo),
  ]);
  return { updates: updates?.meta.changes ?? 0, codes: codes?.meta.changes ?? 0 };
}
