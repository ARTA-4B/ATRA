import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import type { AuditLog } from '../audit/audit.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
// Argon2id, constant-time compare and buffer wiping are the vault's
// primitives, shared with the operator login. Importing them is not a path to
// a key: this module derives a hash of the admin secret and nothing else.
import { DEFAULT_KDF_PARAMS, deriveKey, equalBytes, wipe } from '../wallet/crypto.js';
import type { KdfParams } from '../wallet/crypto.js';
import type { TreasuryStore } from './store.js';

/**
 * The project-admin gate.
 *
 * The treasury is controlled by a credential that is *not* the operator
 * password. The operator password opens the dashboard and the agent wallet
 * vault; it says nothing about who may move project money. So:
 *
 *  - the admin secret is set once, from a loopback client, by someone who
 *    already holds a dashboard session. It is stored as an Argon2id hash with
 *    its parameters, exactly like the operator password, and can never be
 *    read back;
 *  - a successful check issues a short-lived admin token, stored as a SHA-256
 *    and bound to the dashboard session that obtained it. A token copied out
 *    of one browser is useless from another session, and it dies with the
 *    session;
 *  - guesses are throttled before the KDF runs, the same five-strikes rule
 *    the operator login uses, so a burst of wrong secrets locks the check
 *    rather than burning CPU.
 *
 * Threat model, honestly: this is a second factor for a single-operator
 * install, not a multi-user permission system. Someone with code execution on
 * the machine, or with the database file and unlimited time against a weak
 * secret, is out of scope, the same as for the operator password. What it
 * does defend against is the realistic case: a dashboard session left open,
 * a browser extension, a CSRF-shaped request, or a bug elsewhere in the
 * runtime reaching a treasury route with only the operator's cookie.
 */

export const TREASURY_ADMIN_TOKEN_TTL_MS = 30 * 60 * 1_000;
export const TREASURY_ADMIN_FAILURE_LIMIT = 5;
export const TREASURY_ADMIN_FAILURE_WINDOW_MS = 15 * 60 * 1_000;
export const TREASURY_ADMIN_LOCKOUT_MS = 5 * 60 * 1_000;

/** Failed token presentations tolerated per session before that session is throttled. */
export const TREASURY_GATE_FAILURE_LIMIT = 20;
export const TREASURY_GATE_FAILURE_WINDOW_MS = 5 * 60 * 1_000;

export const MIN_ADMIN_SECRET_LENGTH = 16;
export const MAX_ADMIN_SECRET_LENGTH = 512;

export interface IssuedAdminToken {
  /** The bearer value. Returned once, never stored in plaintext. */
  token: string;
  expiresAt: string;
}

export interface AdminPrincipal {
  tokenId: string;
  sessionId: string;
  expiresAt: string;
}

export class TreasuryAdminAuth {
  readonly #store: TreasuryStore;
  readonly #audit: AuditLog;
  readonly #kdf: KdfParams;
  readonly #now: () => number;
  readonly #log = childLogger('treasury-admin');

  #failures: number[] = [];
  #lockedUntil = 0;
  /** Failed gate checks per session id, newest last. */
  readonly #gateFailures = new Map<string, number[]>();

  constructor(
    store: TreasuryStore,
    audit: AuditLog,
    kdf: KdfParams | undefined = DEFAULT_KDF_PARAMS,
    now: () => number = () => Date.now(),
  ) {
    this.#store = store;
    this.#audit = audit;
    this.#kdf = kdf ?? DEFAULT_KDF_PARAMS;
    this.#now = now;
  }

  get isConfigured(): boolean {
    return this.#store.getAdminCredential() !== undefined;
  }

  /**
   * Set the admin secret. Single-use: a second call is refused here and, if
   * two calls race past this check, refused again by the store's conditional
   * update.
   */
  async setSecret(secret: string, actor: string): Promise<void> {
    if (this.isConfigured) {
      throw new AppError(
        ErrorCode.ALREADY_INITIALIZED,
        'The treasury admin credential is already set',
      );
    }
    assertSecretStrength(secret);

    const salt = new Uint8Array(nodeRandomBytes(16));
    const hash = await deriveKey(secret, salt, this.#kdf);
    let written: boolean;
    try {
      written = this.#store.setAdminCredential({
        algorithm: 'argon2id',
        salt,
        hash,
        memoryKib: this.#kdf.memoryKib,
        iterations: this.#kdf.iterations,
        parallelism: this.#kdf.parallelism,
      });
    } finally {
      wipe(hash);
    }

    if (!written) {
      throw new AppError(
        ErrorCode.ALREADY_INITIALIZED,
        'The treasury admin credential is already set',
      );
    }

    this.#audit.append({
      category: 'system',
      action: 'treasury.admin.set',
      status: 'ok',
      summary: 'Treasury admin credential set',
      actor,
      mode: 'NONE',
    });
  }

  async verifySecret(secret: string): Promise<boolean> {
    const credential = this.#store.getAdminCredential();
    if (!credential) return false;

    const candidate = await deriveKey(secret, credential.salt, {
      memoryKib: credential.memoryKib,
      iterations: credential.iterations,
      parallelism: credential.parallelism,
    });
    try {
      return equalBytes(candidate, credential.hash);
    } finally {
      wipe(candidate);
    }
  }

  /** Check the secret and issue a token bound to the calling session. */
  async login(sessionId: string, secret: string, actor: string): Promise<IssuedAdminToken> {
    if (!this.isConfigured) {
      throw new AppError(ErrorCode.CONFLICT, 'Set the treasury admin credential first', {
        errors: [{ path: 'adminSecret', message: 'TREASURY_ADMIN_NOT_CONFIGURED' }],
      });
    }

    this.#assertNotLockedOut();

    if (!(await this.verifySecret(secret))) {
      this.#recordFailure();
      this.#audit.append({
        category: 'system',
        action: 'treasury.admin.login.failed',
        status: 'rejected',
        summary: 'Treasury admin sign-in with an incorrect secret',
        actor,
        mode: 'NONE',
        detail: { sessionId },
      });
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Incorrect treasury admin secret');
    }

    this.#failures = [];
    this.#store.pruneAdminTokens(new Date(this.#now()).toISOString());

    const token = `tadm_${nodeRandomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(this.#now() + TREASURY_ADMIN_TOKEN_TTL_MS).toISOString();
    const id = this.#store.insertAdminToken(hashToken(token), sessionId, expiresAt);

    this.#audit.append({
      category: 'system',
      action: 'treasury.admin.login',
      status: 'ok',
      summary: 'Treasury admin signed in',
      actor,
      mode: 'NONE',
      detail: { sessionId, tokenId: id, expiresAt },
    });

    return { token, expiresAt };
  }

  /**
   * Resolve a presented token for a session, or throw.
   *
   * A token is valid only for the session that obtained it. The failure
   * counter is per session, so one misbehaving client cannot lock the gate
   * for a legitimate one, and the counter is checked before the lookup so a
   * throttled session does not get to keep probing.
   */
  resolve(token: string | undefined, sessionId: string): AdminPrincipal {
    this.#assertGateNotThrottled(sessionId);

    if (!token) {
      throw new AppError(
        ErrorCode.REAUTH_REQUIRED,
        'This treasury action requires the project-admin token',
        { errors: [{ path: 'x-atra-treasury-admin', message: 'TREASURY_ADMIN_REQUIRED' }] },
      );
    }

    const row = this.#store.findAdminToken(hashToken(token));
    const nowIso = new Date(this.#now()).toISOString();
    const valid =
      row !== undefined &&
      row.revoked_at === null &&
      row.session_id === sessionId &&
      row.expires_at > nowIso;

    if (!valid) {
      this.#recordGateFailure(sessionId);
      throw new AppError(
        ErrorCode.REAUTH_INVALID,
        'The treasury admin token is invalid, expired or belongs to another session',
        { errors: [{ path: 'x-atra-treasury-admin', message: 'TREASURY_ADMIN_INVALID' }] },
      );
    }

    return { tokenId: row.id, sessionId: row.session_id, expiresAt: row.expires_at };
  }

  /** True when the session currently holds a live admin token. Never throws. */
  hasValidToken(token: string | undefined, sessionId: string): boolean {
    if (!token) return false;
    const row = this.#store.findAdminToken(hashToken(token));
    return (
      row !== undefined &&
      row.revoked_at === null &&
      row.session_id === sessionId &&
      row.expires_at > new Date(this.#now()).toISOString()
    );
  }

  revokeSession(sessionId: string, actor: string): number {
    const revoked = this.#store.revokeAdminTokens(sessionId);
    if (revoked > 0) {
      this.#audit.append({
        category: 'system',
        action: 'treasury.admin.logout',
        status: 'ok',
        summary: `Treasury admin token(s) revoked (${String(revoked)})`,
        actor,
        mode: 'NONE',
        detail: { sessionId, revoked },
      });
    }
    return revoked;
  }

  // --- throttling ----------------------------------------------------------

  #assertNotLockedOut(): void {
    const now = this.#now();
    if (now < this.#lockedUntil) {
      throw new AppError(ErrorCode.RATE_LIMITED, 'Too many failed treasury admin attempts', {
        retryAfterSec: Math.ceil((this.#lockedUntil - now) / 1_000),
      });
    }
  }

  #recordFailure(): void {
    const now = this.#now();
    this.#failures = this.#failures.filter((at) => now - at < TREASURY_ADMIN_FAILURE_WINDOW_MS);
    this.#failures.push(now);
    if (this.#failures.length >= TREASURY_ADMIN_FAILURE_LIMIT) {
      this.#lockedUntil = now + TREASURY_ADMIN_LOCKOUT_MS;
      this.#failures = [];
      this.#audit.append({
        category: 'system',
        action: 'treasury.admin.locked',
        status: 'rejected',
        summary: `Treasury admin checks locked for ${String(TREASURY_ADMIN_LOCKOUT_MS / 60_000)} minutes after repeated failures`,
        actor: 'treasury-admin',
        mode: 'NONE',
      });
      this.#log.warn('treasury admin checks locked out after repeated failures');
    }
  }

  #assertGateNotThrottled(sessionId: string): void {
    const now = this.#now();
    const recent = (this.#gateFailures.get(sessionId) ?? []).filter(
      (at) => now - at < TREASURY_GATE_FAILURE_WINDOW_MS,
    );
    this.#gateFailures.set(sessionId, recent);
    if (recent.length >= TREASURY_GATE_FAILURE_LIMIT) {
      const oldest = recent[0] ?? now;
      throw new AppError(
        ErrorCode.RATE_LIMITED,
        'Too many invalid treasury admin tokens from this session',
        { retryAfterSec: Math.ceil((oldest + TREASURY_GATE_FAILURE_WINDOW_MS - now) / 1_000) },
      );
    }
  }

  #recordGateFailure(sessionId: string): void {
    const recent = this.#gateFailures.get(sessionId) ?? [];
    recent.push(this.#now());
    this.#gateFailures.set(sessionId, recent);
  }
}

export function assertSecretStrength(secret: string): void {
  if (secret.length < MIN_ADMIN_SECRET_LENGTH) {
    throw new AppError(
      ErrorCode.SCHEMA_INVALID,
      `The treasury admin secret must be at least ${String(MIN_ADMIN_SECRET_LENGTH)} characters`,
      {
        errors: [
          {
            path: 'adminSecret',
            message: `must be at least ${String(MIN_ADMIN_SECRET_LENGTH)} characters`,
          },
        ],
      },
    );
  }
  if (secret.length > MAX_ADMIN_SECRET_LENGTH) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'The treasury admin secret is too long', {
      errors: [
        {
          path: 'adminSecret',
          message: `must be at most ${String(MAX_ADMIN_SECRET_LENGTH)} characters`,
        },
      ],
    });
  }
}

function hashToken(token: string): Uint8Array {
  // 32 random bytes: nothing to brute-force, and the lookup is on every request.
  return createHash('sha256').update(token).digest();
}
