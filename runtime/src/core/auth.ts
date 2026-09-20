import { createHash, randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { AuditLog } from '../audit/audit.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import { DEFAULT_KDF_PARAMS, deriveKey, equalBytes, wipe } from '../wallet/crypto.js';
import type { KdfParams } from '../wallet/crypto.js';

/**
 * Local operator authentication.
 *
 * ATRA is a single-operator service bound to loopback, so there are no user
 * accounts: there is one password, which both opens the dashboard and unlocks
 * the wallet vault. Two token types exist:
 *
 *  - a session token, stored as a cookie, valid for a working day;
 *  - a re-authentication token, single-use and short-lived, required for
 *    anything that can move or reveal funds (export, withdraw, LIVE
 *    activation, password change).
 *
 * Only hashes are stored. A stolen database yields no usable token, and the
 * password hash is Argon2id with the same parameters as the vault.
 */

export const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
export const REAUTH_TTL_MS = 5 * 60 * 1_000;

/**
 * Password-guess throttling.
 *
 * ATRA has one operator, so a burst of wrong passwords is either a typo streak
 * or an attacker. Five failures in the window lock the password check for the
 * lockout period. The KDF already makes each guess cost about a second; this
 * bounds the guess rate regardless of how many requests arrive in parallel.
 *
 * Two properties make that true, and both are easy to lose:
 *
 *  - the attempt is counted *before* the KDF is awaited, so N requests that
 *    arrive together are not all evaluated against a count none of them has
 *    updated yet;
 *  - the count lives in the database, so restarting the process does not hand
 *    a guesser a fresh budget.
 */
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1_000;
export const LOGIN_LOCKOUT_MS = 5 * 60 * 1_000;

export type ReauthPurpose =
  | 'wallet.export'
  | 'wallet.withdraw'
  | 'mode.live'
  | 'emergency.clear'
  | 'auth.password'
  | 'settings.reset'
  | 'settings.secret';

interface CredentialRow {
  algorithm: string;
  salt: Uint8Array;
  hash: Uint8Array;
  memory_kib: number;
  iterations: number;
  parallelism: number;
}

interface SessionRow {
  id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface ReauthRow {
  id: string;
  session_id: string;
  purpose: string;
  expires_at: string;
  used_at: string | null;
}

interface ThrottleRow {
  failures: string;
  locked_until: number | null;
}

export interface Session {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export interface IssuedSession extends Session {
  /** The bearer value. Returned once, never stored in plaintext. */
  token: string;
}

export class AuthService {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #log = childLogger('auth');
  readonly #kdf: KdfParams;
  readonly #now: () => number;

  constructor(
    db: Db,
    audit: AuditLog,
    kdf: KdfParams | undefined = DEFAULT_KDF_PARAMS,
    now: () => number = () => Date.now(),
  ) {
    this.#db = db;
    this.#audit = audit;
    this.#kdf = kdf ?? DEFAULT_KDF_PARAMS;
    this.#now = now;
  }

  /**
   * Charge this attempt to the throttle, then refuse it if the throttle has
   * tripped.
   *
   * The write happens before the caller awaits the KDF, which is what makes
   * the limit hold under concurrency: the attempt that takes the count to the
   * limit locks the check for every attempt behind it, whether or not any of
   * them has finished deriving a key. An attempt that turns out to be the
   * right password clears the count again.
   */
  #beginAttempt(): void {
    const now = this.#now();
    const state = this.#throttle();

    if (state.lockedUntil !== null && now < state.lockedUntil) {
      throw new AppError(ErrorCode.RATE_LIMITED, 'Too many failed password attempts', {
        retryAfterSec: Math.ceil((state.lockedUntil - now) / 1_000),
      });
    }

    const failures = state.failures.filter((at) => now - at < LOGIN_FAILURE_WINDOW_MS);
    failures.push(now);

    if (failures.length >= LOGIN_FAILURE_LIMIT) {
      this.#writeThrottle([], now + LOGIN_LOCKOUT_MS);
      this.#audit.append({
        category: 'auth',
        action: 'login.locked',
        status: 'rejected',
        summary: `Password checks locked for ${String(LOGIN_LOCKOUT_MS / 60_000)} minutes after repeated failures`,
      });
      this.#log.warn('password checks locked out after repeated failures');
      return;
    }

    this.#writeThrottle(failures, null);
  }

  #recordSuccess(): void {
    this.#writeThrottle([], null);
  }

  #throttle(): { failures: number[]; lockedUntil: number | null } {
    const row = this.#db
      .prepare<[], ThrottleRow>('SELECT failures, locked_until FROM auth_throttle WHERE id = 1')
      .get();

    if (!row) return { failures: [], lockedUntil: null };

    let failures: number[] = [];
    try {
      const parsed: unknown = JSON.parse(row.failures);
      if (Array.isArray(parsed)) {
        failures = parsed.filter((value): value is number => typeof value === 'number');
      }
    } catch {
      // A corrupt counter must not become an open door: an unreadable list is
      // treated as empty, and the row is rewritten on the next attempt.
    }

    return { failures, lockedUntil: row.locked_until };
  }

  #writeThrottle(failures: number[], lockedUntil: number | null): void {
    this.#db
      .prepare<[string, number | null, string, string, number | null, string]>(
        'INSERT INTO auth_throttle (id, failures, locked_until, updated_at) VALUES (1, ?, ?, ?)' +
          ' ON CONFLICT(id) DO UPDATE SET failures = ?, locked_until = ?, updated_at = ?',
      )
      .run(
        JSON.stringify(failures),
        lockedUntil,
        new Date(this.#now()).toISOString(),
        JSON.stringify(failures),
        lockedUntil,
        new Date(this.#now()).toISOString(),
      );
  }

  get isConfigured(): boolean {
    return this.#credential() !== undefined;
  }

  /** Set the operator password for the first time. */
  async setPassword(password: string): Promise<void> {
    if (this.isConfigured) {
      throw new AppError(ErrorCode.ALREADY_INITIALIZED, 'A password is already set');
    }
    assertPasswordStrength(password);

    const salt = new Uint8Array(nodeRandomBytes(16));
    const hash = await deriveKey(password, salt, this.#kdf);
    const now = new Date().toISOString();

    try {
      this.#db
        .prepare(
          'INSERT INTO auth_credential (id, algorithm, salt, hash, memory_kib, iterations,' +
            ' parallelism, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'argon2id',
          salt,
          hash,
          this.#kdf.memoryKib,
          this.#kdf.iterations,
          this.#kdf.parallelism,
          now,
          now,
        );
    } finally {
      wipe(hash);
    }

    this.#audit.append({
      category: 'auth',
      action: 'password.set',
      status: 'ok',
      summary: 'Dashboard password set',
    });
  }

  /**
   * Change the password.
   *
   * The vault must be rewrapped by the caller in the same operation; this
   * service only owns the login credential.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (!(await this.verifyPassword(currentPassword))) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'The current password is incorrect');
    }
    assertPasswordStrength(newPassword);

    const salt = new Uint8Array(nodeRandomBytes(16));
    const hash = await deriveKey(newPassword, salt, this.#kdf);

    try {
      this.#db
        .prepare(
          'UPDATE auth_credential SET salt = ?, hash = ?, memory_kib = ?, iterations = ?,' +
            ' parallelism = ?, updated_at = ? WHERE id = 1',
        )
        .run(
          salt,
          hash,
          this.#kdf.memoryKib,
          this.#kdf.iterations,
          this.#kdf.parallelism,
          new Date().toISOString(),
        );
    } finally {
      wipe(hash);
    }

    // Every existing session is invalidated: a password change is the action an
    // operator takes when they think someone else may have access.
    this.revokeAllSessions('password changed');

    this.#audit.append({
      category: 'auth',
      action: 'password.changed',
      status: 'ok',
      summary: 'Dashboard password changed and all sessions revoked',
    });
  }

  async verifyPassword(password: string): Promise<boolean> {
    const credential = this.#credential();
    if (!credential) return false;

    const candidate = await deriveKey(password, credential.salt, {
      memoryKib: credential.memory_kib,
      iterations: credential.iterations,
      parallelism: credential.parallelism,
    });

    try {
      return equalBytes(candidate, credential.hash);
    } finally {
      wipe(candidate);
    }
  }

  /** Verify the password and start a session. */
  async login(password: string): Promise<IssuedSession> {
    if (!this.isConfigured) {
      throw new AppError(ErrorCode.SETUP_REQUIRED, 'Run first-time setup before signing in');
    }

    this.#beginAttempt();

    if (!(await this.verifyPassword(password))) {
      this.#audit.append({
        category: 'auth',
        action: 'login.failed',
        status: 'rejected',
        summary: 'Sign-in attempt with an incorrect password',
      });
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Incorrect password');
    }

    this.#recordSuccess();
    const session = this.createSession();
    this.#audit.append({
      category: 'auth',
      action: 'login',
      status: 'ok',
      summary: 'Operator signed in',
      detail: { sessionId: session.id },
    });
    return session;
  }

  /** Issue a session without checking a password (used right after setup). */
  createSession(): IssuedSession {
    this.#pruneExpired();

    const id = randomUUID();
    const token = `atra_${base64url(nodeRandomBytes(32))}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

    this.#db
      .prepare(
        'INSERT INTO sessions (id, token_hash, created_at, expires_at, last_seen_at)' +
          ' VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, hashToken(token), now.toISOString(), expiresAt.toISOString(), now.toISOString());

    return {
      id,
      token,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** Resolve a bearer token to a live session, or undefined. */
  resolveSession(token: string | undefined): Session | undefined {
    if (!token) return undefined;

    const row = this.#db
      .prepare<[Uint8Array], SessionRow>('SELECT * FROM sessions WHERE token_hash = ?')
      .get(hashToken(token));

    if (!row || row.revoked_at !== null) return undefined;
    if (Date.parse(row.expires_at) <= Date.now()) return undefined;

    this.#db
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);

    return { id: row.id, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  revokeSession(sessionId: string): void {
    this.#db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), sessionId);
  }

  revokeAllSessions(reason: string): void {
    this.#db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL')
      .run(new Date().toISOString());
    this.#log.warn({ reason }, 'all sessions revoked');
  }

  /**
   * Issue a single-use token for a sensitive operation.
   *
   * The password is required again even though the caller already has a valid
   * session: a session cookie left open in a browser should not be enough to
   * export a private key.
   */
  async issueReauthToken(
    sessionId: string,
    purpose: ReauthPurpose,
    password: string,
  ): Promise<{ token: string; expiresAt: string }> {
    this.#beginAttempt();

    if (!(await this.verifyPassword(password))) {
      this.#audit.append({
        category: 'auth',
        action: 'reauth.failed',
        status: 'rejected',
        summary: `Re-authentication failed for ${purpose}`,
        detail: { purpose },
      });
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Incorrect password');
    }

    this.#recordSuccess();
    const token = `reauth_${base64url(nodeRandomBytes(32))}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + REAUTH_TTL_MS);

    this.#db
      .prepare(
        'INSERT INTO reauth_tokens (id, token_hash, session_id, purpose, created_at, expires_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        hashToken(token),
        sessionId,
        purpose,
        now.toISOString(),
        expiresAt.toISOString(),
      );

    this.#audit.append({
      category: 'auth',
      action: 'reauth.issued',
      status: 'ok',
      summary: `Re-authentication granted for ${purpose}`,
      detail: { purpose },
    });

    return { token, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Consume a re-authentication token.
   *
   * Marking it used happens in the same statement that checks it, so two
   * concurrent requests cannot both spend the same token.
   */
  consumeReauthToken(token: string | undefined, purpose: ReauthPurpose, sessionId: string): void {
    if (!token) {
      throw new AppError(ErrorCode.REAUTH_REQUIRED, `This action requires re-authentication`, {
        details: { purpose },
      });
    }

    const now = new Date().toISOString();
    const row = this.#db
      .prepare<[string, Uint8Array, string, string, string], ReauthRow>(
        'UPDATE reauth_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ?' +
          ' AND session_id = ? AND used_at IS NULL AND expires_at > ? RETURNING *',
      )
      .get(now, hashToken(token), purpose, sessionId, now);

    if (!row) {
      throw new AppError(
        ErrorCode.REAUTH_INVALID,
        'Re-authentication has expired or was already used',
        { details: { purpose } },
      );
    }
  }

  #credential(): CredentialRow | undefined {
    return this.#db.prepare<[], CredentialRow>('SELECT * FROM auth_credential WHERE id = 1').get();
  }

  #pruneExpired(): void {
    const now = new Date().toISOString();
    this.#db.prepare('DELETE FROM reauth_tokens WHERE expires_at <= ?').run(now);
    this.#db
      .prepare(
        'DELETE FROM sessions WHERE expires_at <= ? AND id NOT IN (SELECT session_id FROM reauth_tokens)',
      )
      .run(now);
  }
}

/**
 * Minimum password rules.
 *
 * Length only. Composition rules (a digit, a symbol) push people towards
 * "Password1!" and buy nothing; a long passphrase is both stronger and easier
 * to type into a dashboard every morning.
 */
export function assertPasswordStrength(password: string): void {
  if (password.length < 12) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'The password must be at least 12 characters', {
      errors: [{ path: 'password', message: 'must be at least 12 characters' }],
    });
  }
  if (password.length > 512) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'The password is too long', {
      errors: [{ path: 'password', message: 'must be at most 512 characters' }],
    });
  }
}

function hashToken(token: string): Uint8Array {
  // A token is 32 random bytes, so a fast hash is the right primitive here:
  // there is nothing to brute force, and the lookup happens on every request.
  return createHash('sha256').update(token).digest();
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}
