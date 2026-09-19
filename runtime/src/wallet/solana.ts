import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { randomBytes, wipe } from './crypto.js';
import { AppError, ErrorCode } from '../util/errors.js';

/**
 * Solana key handling.
 *
 * Solana wallets are ed25519 keypairs. The ecosystem's "secret key" is the
 * 64-byte concatenation of the 32-byte seed and the 32-byte public key — that
 * is what `solana-keygen` writes to id.json and what Phantom imports as
 * base58. ATRA stores those 64 bytes in the vault so an export is a direct
 * re-encoding rather than a re-derivation.
 */

export const SOLANA_SEED_BYTES = 32;
export const SOLANA_KEYPAIR_BYTES = 64;

export interface SolanaKeypair {
  /** 64 bytes: seed || publicKey. */
  secretKey: Uint8Array;
  /** Base58 public key, i.e. the wallet address. */
  address: string;
}

/** Generate a new keypair from operating-system entropy. */
export function generateSolanaKeypair(): SolanaKeypair {
  const seed = randomBytes(SOLANA_SEED_BYTES);
  try {
    return keypairFromSeed(seed);
  } finally {
    wipe(seed);
  }
}

export function keypairFromSeed(seed: Uint8Array): SolanaKeypair {
  if (seed.length !== SOLANA_SEED_BYTES) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'A Solana seed must be 32 bytes', {
      details: { actual: seed.length },
    });
  }

  const publicKey = ed25519.getPublicKey(seed);
  const secretKey = new Uint8Array(SOLANA_KEYPAIR_BYTES);
  secretKey.set(seed, 0);
  secretKey.set(publicKey, SOLANA_SEED_BYTES);

  return { secretKey, address: base58.encode(publicKey) };
}

/** Recover the address from a stored 64-byte secret key. */
export function solanaAddressFromSecretKey(secretKey: Uint8Array): string {
  assertSecretKey(secretKey);
  return base58.encode(secretKey.subarray(SOLANA_SEED_BYTES));
}

/**
 * Verify that the trailing public key really matches the leading seed.
 *
 * Guards against a corrupted or hand-edited vault row whose halves disagree,
 * which would otherwise surface as funds sent to an address ATRA cannot sign
 * for.
 */
export function isConsistentSecretKey(secretKey: Uint8Array): boolean {
  if (secretKey.length !== SOLANA_KEYPAIR_BYTES) return false;
  const derived = ed25519.getPublicKey(secretKey.subarray(0, SOLANA_SEED_BYTES));
  const stored = secretKey.subarray(SOLANA_SEED_BYTES);
  return derived.every((byte, index) => byte === stored[index]);
}

/**
 * The `solana-keygen` id.json format: a JSON array of the 64 secret bytes.
 * Anyone holding this file controls the wallet.
 */
export function exportSolanaIdJson(secretKey: Uint8Array): string {
  assertSecretKey(secretKey);
  return `[${Array.from(secretKey).join(',')}]`;
}

/** Base58 of the 64-byte secret key: the format wallets such as Phantom import. */
export function exportSolanaBase58(secretKey: Uint8Array): string {
  assertSecretKey(secretKey);
  return base58.encode(secretKey);
}

/** Parse an id.json payload back into bytes (used by tests and recovery docs). */
export function parseSolanaIdJson(text: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'id.json is not valid JSON', { cause });
  }

  if (!Array.isArray(parsed) || parsed.length !== SOLANA_KEYPAIR_BYTES) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'id.json must contain exactly 64 bytes');
  }

  // Array.isArray on an unknown narrows to any[], which would let a non-number
  // through the assignment below unnoticed; re-type it as unknown[] so each
  // element is checked explicitly.
  const values = parsed as unknown[];
  const bytes = new Uint8Array(SOLANA_KEYPAIR_BYTES);
  for (let i = 0; i < SOLANA_KEYPAIR_BYTES; i += 1) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'id.json contains a non-byte value');
    }
    bytes[i] = value;
  }
  return bytes;
}

/** Sign a message with a stored secret key. Used by the Phase 3 signer. */
export function signWithSolanaKey(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  assertSecretKey(secretKey);
  return ed25519.sign(message, secretKey.subarray(0, SOLANA_SEED_BYTES));
}

function assertSecretKey(secretKey: Uint8Array): void {
  if (secretKey.length !== SOLANA_KEYPAIR_BYTES) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'A Solana secret key must be 64 bytes', {
      details: { actual: secretKey.length },
    });
  }
}
