import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import {
  CIPHER_ALGORITHM,
  DEFAULT_KDF_PARAMS,
  KDF_ALGORITHM,
  KEY_LENGTH,
  deriveKey,
  equalBytes,
  open,
  randomBytes,
  randomSalt,
  seal,
  wipe,
} from './crypto.js';
import type { KdfParams } from './crypto.js';

/**
 * The Wallet Vault.
 *
 * Key hierarchy:
 *
 *   operator password --Argon2id--> KEK --XChaCha20-Poly1305--> DEK
 *   DEK --XChaCha20-Poly1305--> individual secrets
 *
 * Only the DEK is held in memory while unlocked, and only for as long as the
 * session is active. Changing the password rewraps the DEK; the per-secret
 * ciphertexts are untouched, so a password change is atomic and cheap.
 *
 * Hard rules enforced here:
 *  - plaintext secrets are returned as Uint8Array to a callback that runs
 *    synchronously, and the buffer is wiped when it returns
 *  - no method returns a secret as a string except {@link exportSecret}, which
 *    is what the explicitly re-authenticated export endpoint calls
 *  - nothing in this module logs a value, only counts and identifiers
 */

export const VAULT_VERSION = 1;

export type SecretKind = 'evm_private_key' | 'solana_keypair' | 'provider_api_key';

export interface VaultHeaderRow {
  version: number;
  kdf: string;
  kdf_salt: Uint8Array;
  kdf_memory_kib: number;
  kdf_iterations: number;
  kdf_parallelism: number;
  cipher: string;
  wrapped_dek: Uint8Array;
  wrap_nonce: Uint8Array;
  created_at: string;
  rotated_at: string | null;
}

interface SecretRow {
  id: string;
  kind: SecretKind;
  label: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  aad: string;
  created_at: string;
}

export interface SecretDescriptor {
  id: string;
  kind: SecretKind;
  label: string;
  createdAt: string;
}

const WRAP_AAD = 'atra.vault.dek.v1';

function secretAad(id: string, kind: SecretKind): string {
  return `atra.vault.secret.v1:${kind}:${id}`;
}

export class Vault {
  readonly #db: Db;
  readonly #log = childLogger('vault');

  /** The unwrapped DEK. Present only while unlocked. */
  #dek: Uint8Array | undefined;
  #unlockedAt: number | undefined;
  #lastUsedAt: number | undefined;
  readonly #autolockMs: number;
  readonly #defaultKdf: KdfParams;

  constructor(db: Db, options: { autolockMs?: number; kdfParams?: KdfParams | undefined } = {}) {
    this.#db = db;
    this.#autolockMs = options.autolockMs ?? 30 * 60_000;
    this.#defaultKdf = options.kdfParams ?? DEFAULT_KDF_PARAMS;
  }

  get isInitialized(): boolean {
    return this.#header() !== undefined;
  }

  get isUnlocked(): boolean {
    this.#enforceAutolock();
    return this.#dek !== undefined;
  }

  get unlockedAt(): string | undefined {
    return this.#unlockedAt === undefined ? undefined : new Date(this.#unlockedAt).toISOString();
  }

  /**
   * Create the vault.
   *
   * Generates a fresh 32-byte DEK, wraps it with a key derived from the
   * password, and leaves the vault unlocked so that setup can immediately
   * generate wallets without asking for the password twice.
   */
  async initialize(password: string, params: KdfParams = this.#defaultKdf): Promise<void> {
    if (this.isInitialized) {
      throw new AppError(ErrorCode.VAULT_ALREADY_EXISTS, 'The vault has already been created');
    }

    const salt = randomSalt();
    const dek = randomBytes(KEY_LENGTH);
    const kek = await deriveKey(password, salt, params);

    try {
      const wrapped = seal(kek, dek, WRAP_AAD);
      this.#db
        .prepare(
          'INSERT INTO vault_header (id, version, kdf, kdf_salt, kdf_memory_kib, kdf_iterations,' +
            ' kdf_parallelism, cipher, wrapped_dek, wrap_nonce, created_at)' +
            ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          VAULT_VERSION,
          KDF_ALGORITHM,
          salt,
          params.memoryKib,
          params.iterations,
          params.parallelism,
          CIPHER_ALGORITHM,
          wrapped.ciphertext,
          wrapped.nonce,
          new Date().toISOString(),
        );

      this.#dek = dek;
      this.#touch();
      this.#log.info({ kdf: KDF_ALGORITHM, cipher: CIPHER_ALGORITHM }, 'vault initialized');
    } catch (error) {
      wipe(dek);
      this.#dek = undefined;
      throw error;
    } finally {
      wipe(kek);
    }
  }

  /**
   * Unlock with the operator password.
   *
   * A wrong password fails at the Poly1305 tag check, which is why there is no
   * separate "verify password" path that could be turned into an oracle.
   */
  async unlock(password: string): Promise<void> {
    const header = this.#header();
    if (!header) {
      throw new AppError(ErrorCode.VAULT_NOT_FOUND, 'No vault exists yet; run setup first');
    }
    if (header.version !== VAULT_VERSION) {
      throw new AppError(ErrorCode.VAULT_CORRUPT, 'Unsupported vault version', {
        details: { found: header.version, supported: VAULT_VERSION },
      });
    }

    const kek = await deriveKey(password, header.kdf_salt, {
      memoryKib: header.kdf_memory_kib,
      iterations: header.kdf_iterations,
      parallelism: header.kdf_parallelism,
    });

    try {
      const dek = open(
        kek,
        {
          nonce: header.wrap_nonce,
          ciphertext: header.wrapped_dek,
        },
        WRAP_AAD,
        'the vault key',
      );
      this.#replaceDek(dek);
      this.#log.info('vault unlocked');
    } finally {
      wipe(kek);
    }
  }

  /** Drop the DEK. Idempotent. */
  lock(): void {
    if (this.#dek) {
      wipe(this.#dek);
      this.#log.info('vault locked');
    }
    this.#dek = undefined;
    this.#unlockedAt = undefined;
    this.#lastUsedAt = undefined;
  }

  /**
   * Re-wrap the DEK under a new password.
   *
   * The old password is verified by unwrapping, so a caller cannot change the
   * password without proving they can already open the vault.
   */
  async changePassword(
    currentPassword: string,
    newPassword: string,
    params: KdfParams = this.#defaultKdf,
  ): Promise<void> {
    const header = this.#header();
    if (!header) {
      throw new AppError(ErrorCode.VAULT_NOT_FOUND, 'No vault exists yet');
    }

    const oldKek = await deriveKey(currentPassword, header.kdf_salt, {
      memoryKib: header.kdf_memory_kib,
      iterations: header.kdf_iterations,
      parallelism: header.kdf_parallelism,
    });

    let dek: Uint8Array | undefined;
    let newKek: Uint8Array | undefined;
    try {
      dek = open(
        oldKek,
        {
          nonce: header.wrap_nonce,
          ciphertext: header.wrapped_dek,
        },
        WRAP_AAD,
        'the vault key',
      );

      const salt = randomSalt();
      newKek = await deriveKey(newPassword, salt, params);
      const wrapped = seal(newKek, dek, WRAP_AAD);

      this.#db
        .prepare(
          'UPDATE vault_header SET kdf_salt = ?, kdf_memory_kib = ?, kdf_iterations = ?,' +
            ' kdf_parallelism = ?, wrapped_dek = ?, wrap_nonce = ?, rotated_at = ? WHERE id = 1',
        )
        .run(
          salt,
          params.memoryKib,
          params.iterations,
          params.parallelism,
          wrapped.ciphertext,
          wrapped.nonce,
          new Date().toISOString(),
        );

      // Keep the session usable after a password change.
      this.#replaceDek(Uint8Array.from(dek));
      this.#log.info('vault password rotated');
    } finally {
      wipe(oldKek, newKek, dek);
    }
  }

  /** Store a secret. Returns its identifier. */
  putSecret(kind: SecretKind, label: string, plaintext: Uint8Array): string {
    const dek = this.#requireDek();
    const id = randomUUID();
    const aad = secretAad(id, kind);
    const sealed = seal(dek, plaintext, aad);

    this.#db
      .prepare(
        'INSERT INTO vault_secrets (id, kind, label, nonce, ciphertext, aad, created_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, kind, label, sealed.nonce, sealed.ciphertext, aad, new Date().toISOString());

    this.#log.info({ secretId: id, kind }, 'secret stored');
    return id;
  }

  /**
   * Decrypt a secret, hand it to `use`, then wipe it.
   *
   * The callback is deliberately synchronous: it must not hold the plaintext
   * across an await, where it could survive for an unbounded time.
   */
  useSecret<T>(id: string, use: (plaintext: Uint8Array) => T): T {
    const dek = this.#requireDek();
    const row = this.#db
      .prepare<[string], SecretRow>('SELECT * FROM vault_secrets WHERE id = ?')
      .get(id);

    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, 'No such secret', { details: { secretId: id } });
    }

    const plaintext = open(
      dek,
      { nonce: row.nonce, ciphertext: row.ciphertext },
      row.aad,
      `secret ${id}`,
    );

    try {
      return use(plaintext);
    } finally {
      wipe(plaintext);
    }
  }

  /**
   * Export a secret in a caller-chosen encoding.
   *
   * This is the one path that turns key material into a string. It is reached
   * only from the export endpoint, which requires a fresh re-authentication and
   * is restricted to loopback callers. The audit trail records that an export
   * happened; it never records what was exported.
   */
  exportSecret<T>(id: string, encode: (plaintext: Uint8Array) => T): T {
    return this.useSecret(id, encode);
  }

  listSecrets(): SecretDescriptor[] {
    return this.#db
      .prepare<[], SecretRow>(
        'SELECT id, kind, label, created_at, nonce, ciphertext, aad FROM vault_secrets ORDER BY created_at',
      )
      .all()
      .map((row) => ({ id: row.id, kind: row.kind, label: row.label, createdAt: row.created_at }));
  }

  /** Verify a password without changing lock state (used before export). */
  async verifyPassword(password: string): Promise<boolean> {
    const header = this.#header();
    if (!header) return false;

    const kek = await deriveKey(password, header.kdf_salt, {
      memoryKib: header.kdf_memory_kib,
      iterations: header.kdf_iterations,
      parallelism: header.kdf_parallelism,
    });

    let dek: Uint8Array | undefined;
    try {
      dek = open(
        kek,
        {
          nonce: header.wrap_nonce,
          ciphertext: header.wrapped_dek,
        },
        WRAP_AAD,
        'the vault key',
      );
      // If the vault is already unlocked, confirm the same key came back.
      return this.#dek ? equalBytes(this.#dek, dek) : true;
    } catch {
      return false;
    } finally {
      wipe(kek, dek);
    }
  }

  #header(): VaultHeaderRow | undefined {
    return this.#db.prepare<[], VaultHeaderRow>('SELECT * FROM vault_header WHERE id = 1').get();
  }

  #requireDek(): Uint8Array {
    this.#enforceAutolock();
    if (!this.#dek) {
      throw new AppError(ErrorCode.VAULT_LOCKED, 'The vault is locked; sign in again');
    }
    this.#touch();
    return this.#dek;
  }

  #replaceDek(dek: Uint8Array): void {
    if (this.#dek) wipe(this.#dek);
    this.#dek = dek;
    this.#unlockedAt = Date.now();
    this.#touch();
  }

  #touch(): void {
    this.#lastUsedAt = Date.now();
  }

  #enforceAutolock(): void {
    if (this.#dek === undefined || this.#lastUsedAt === undefined) return;
    if (Date.now() - this.#lastUsedAt >= this.#autolockMs) {
      this.#log.info({ autolockMs: this.#autolockMs }, 'vault auto-locked after inactivity');
      this.lock();
    }
  }
}
