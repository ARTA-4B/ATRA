/**
 * Installation tokens.
 *
 * Format: "atra_" + uuidv7 + "." + 32 random bytes base64url. The uuid is the
 * token id (not the installation id), so a rotated token for the same
 * installation gets a fresh id. The database stores only
 * HMAC-SHA256(TOKEN_PEPPER, token): a leaked D1 export cannot be replayed
 * without the pepper, and the pepper (a Worker secret) never touches D1.
 *
 * TODO(phase-5): rotation. POST /v1/admin/installs/{id}/rotate should mint a
 * new token whose rotated_from is the old hash and set the old row's
 * expires_at to now + 300 s, so a runtime mid-restart still connects during
 * the grace window. Until then a compromised token is revoked through
 * POST /v1/admin/installs/{id}/revoke (admin.ts), which sets revoked_at, and
 * the installation gets a fresh token from the mint endpoint.
 */
import { bytesToBase64Url, hmacSha256Hex, randomBytes, uuidv7 } from './crypto.js';

export const TOKEN_PREFIX = 'atra_';
export const TOKEN_RE =
  /^atra_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;

/**
 * What a runtime token carries unless the admin endpoint says otherwise:
 * Telegram routing plus the two read-only proxies. `inference` is opt-in
 * because the route is off by default and costs the project money when on.
 */
export const DEFAULT_SCOPES = ['telegram', 'rpc', 'market'] as const;
/** Tokens expire after a year unless the admin endpoint is told otherwise. */
export const DEFAULT_TOKEN_TTL_MS = 365 * 24 * 60 * 60_000;

export interface MintOptions {
  installId?: string;
  scopes?: readonly string[];
  ttlMs?: number | null;
  now?: number;
}

export interface MintedToken {
  installId: string;
  token: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
}

export interface InstallPrincipal {
  installId: string;
  scopes: string[];
  tokenHash: string;
}

export function generateToken(now: number = Date.now()): string {
  return `${TOKEN_PREFIX}${uuidv7(now)}.${bytesToBase64Url(randomBytes(32))}`;
}

export function hashToken(pepper: string, token: string): Promise<string> {
  return hmacSha256Hex(pepper, token);
}

/** Mint and persist a token. The clear-text token is returned exactly once. */
export async function mintInstallToken(
  db: D1Database,
  pepper: string,
  options: MintOptions = {},
): Promise<MintedToken> {
  const now = options.now ?? Date.now();
  const installId = options.installId ?? uuidv7(now);
  const scopes = [...(options.scopes ?? DEFAULT_SCOPES)];
  const ttl = options.ttlMs === undefined ? DEFAULT_TOKEN_TTL_MS : options.ttlMs;
  const expiresAt = ttl === null ? null : now + ttl;
  const token = generateToken(now);
  const tokenHash = await hashToken(pepper, token);

  await db
    .prepare(
      'INSERT INTO install_tokens (token_hash, install_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(tokenHash, installId, JSON.stringify(scopes), now, expiresAt)
    .run();

  return { installId, token, scopes, createdAt: now, expiresAt };
}

interface TokenRow {
  install_id: string;
  scopes: string;
  expires_at: number | null;
  revoked_at: number | null;
}

/**
 * Resolve a presented token to its installation, or null. The format check
 * happens before any hashing so junk never costs an HMAC or a D1 read.
 */
export async function authenticateInstallToken(
  db: D1Database,
  pepper: string,
  token: string,
  now: number = Date.now(),
): Promise<InstallPrincipal | null> {
  if (!TOKEN_RE.test(token)) return null;
  const tokenHash = await hashToken(pepper, token);
  const row = await db
    .prepare(
      'SELECT install_id, scopes, expires_at, revoked_at FROM install_tokens WHERE token_hash = ?',
    )
    .bind(tokenHash)
    .first<TokenRow>();
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;

  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    scopes = [];
  }
  return { installId: row.install_id, scopes, tokenHash };
}

/** Extract a bearer token from an Authorization header value, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
