import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { AppError, ErrorCode } from '../util/errors.js';

/**
 * Cryptographic primitives for the wallet vault.
 *
 * Choices and why:
 *  - Argon2id (RFC 9106) for password stretching. The parameters live in the
 *    vault header, so they can be raised on a future install without breaking
 *    existing ones.
 *  - XChaCha20-Poly1305 for authenticated encryption. The 192-bit nonce makes
 *    random nonces safe without a counter, which matters because the vault is
 *    rewritten by several independent code paths.
 *  - Pure-JS implementations from the audited @noble suite: no native build
 *    step, identical behaviour on Windows, Linux and inside a container.
 *
 * Everything here works on Uint8Array. Key material is never converted to a
 * JavaScript string (strings are immutable and cannot be wiped) except at the
 * single export boundary, where the operator has explicitly asked for it.
 */

export const KDF_ALGORITHM = 'argon2id';
export const CIPHER_ALGORITHM = 'xchacha20poly1305';

export const KEY_LENGTH = 32;
export const SALT_LENGTH = 16;
export const NONCE_LENGTH = 24;

export interface KdfParams {
  memoryKib: number;
  iterations: number;
  parallelism: number;
}

/**
 * Default Argon2id parameters.
 *
 * RFC 9106's second recommended option is m=64 MiB / t=3 / p=4 and OWASP's
 * floor is m=19 MiB / t=2 / p=1. We sit between them at 46 MiB / t=2 / p=1.
 *
 * p=1 because this implementation is single-threaded, so extra lanes cost
 * memory without adding work. The memory figure was chosen by measurement, not
 * taste: on the reference development machine (Ryzen 7 7735HS) these numbers
 * derive a key in ~1.5 s, which keeps a dashboard unlock responsive while
 * staying well above the OWASP floor. Parameters are persisted per install, so
 * raising them later does not invalidate an existing vault.
 */
export const DEFAULT_KDF_PARAMS: KdfParams = {
  memoryKib: 47_104,
  iterations: 2,
  parallelism: 1,
};

export function randomBytes(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length));
}

export function randomNonce(): Uint8Array {
  return randomBytes(NONCE_LENGTH);
}

export function randomSalt(): Uint8Array {
  return randomBytes(SALT_LENGTH);
}

/**
 * Overwrite a buffer in place.
 *
 * This bounds how long plaintext key material stays resident. It is not a
 * guarantee: V8 may have copied the bytes during GC. The stronger property
 * ATRA relies on is that plaintext exists only inside a single function scope
 * and is never placed in a string, a log record or a JSON body.
 */
export function wipe(...buffers: Array<Uint8Array | undefined>): void {
  for (const buffer of buffers) {
    if (buffer) buffer.fill(0);
  }
}

/** Constant-time comparison; false for length mismatch. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Derive a key from a password.
 *
 * The password arrives as a string from the HTTP layer, which is unavoidable;
 * it is encoded to bytes immediately and the bytes are wiped afterwards.
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
  keyLength: number = KEY_LENGTH,
): Promise<Uint8Array> {
  const passwordBytes = new TextEncoder().encode(password.normalize('NFKC'));
  try {
    return await argon2idAsync(passwordBytes, salt, {
      m: params.memoryKib,
      t: params.iterations,
      p: params.parallelism,
      dkLen: keyLength,
    });
  } finally {
    wipe(passwordBytes);
  }
}

export interface SealedBox {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Encrypt with XChaCha20-Poly1305.
 *
 * `aad` binds the ciphertext to its context (for example the secret id), so a
 * row copied into another slot fails to decrypt instead of silently
 * authenticating.
 */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): SealedBox {
  assertKeyLength(key);
  const nonce = randomNonce();
  const aadBytes = new TextEncoder().encode(aad);
  const ciphertext = xchacha20poly1305(key, nonce, aadBytes).encrypt(plaintext);
  return { nonce, ciphertext };
}

/** Decrypt and authenticate. Throws VAULT_CORRUPT when the tag does not match. */
export function open(
  key: Uint8Array,
  box: SealedBox,
  aad: string,
  context = 'vault item',
): Uint8Array {
  assertKeyLength(key);
  const aadBytes = new TextEncoder().encode(aad);
  try {
    return xchacha20poly1305(key, box.nonce, aadBytes).decrypt(box.ciphertext);
  } catch (cause) {
    throw new AppError(
      ErrorCode.VAULT_CORRUPT,
      `Could not decrypt ${context}: wrong password or corrupted data`,
      { cause },
    );
  }
}

function assertKeyLength(key: Uint8Array): void {
  if (key.length !== KEY_LENGTH) {
    throw new AppError(ErrorCode.INTERNAL, 'Invalid key length', {
      details: { expected: KEY_LENGTH, actual: key.length },
    });
  }
}
