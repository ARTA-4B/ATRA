import { secp256k1 } from '@noble/curves/secp256k1.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ctr } from '@noble/ciphers/aes.js';
import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import type { Address } from 'viem';
import { randomBytes, wipe } from './crypto.js';
import { AppError, ErrorCode } from '../util/errors.js';

/**
 * EVM key handling.
 *
 * One key covers all three EVM chains ATRA supports (Base, BNB Smart Chain and
 * Robinhood Chain): they share the secp256k1 curve and the same address
 * derivation, so the operator funds a single address per chain rather than
 * managing three keys.
 *
 * Keys are generated locally from the operating system CSPRNG. ATRA never
 * imports a seed phrase in V1 — it creates fresh agent wallets, which keeps a
 * compromised agent from touching an operator's main funds.
 */

export const EVM_PRIVATE_KEY_BYTES = 32;

/** Generate a private key that is a valid secp256k1 scalar. */
export function generateEvmPrivateKey(): Uint8Array {
  // Rejection sampling: a uniformly random 32-byte string is out of range with
  // probability ~2^-128, but "astronomically unlikely" is not a reason to skip
  // the check on key material.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = randomBytes(EVM_PRIVATE_KEY_BYTES);
    if (secp256k1.utils.isValidSecretKey(candidate)) return candidate;
    wipe(candidate);
  }
  throw new AppError(ErrorCode.INTERNAL, 'Could not generate a valid EVM key');
}

/** Derive the checksummed 0x address for a private key. */
export function evmAddressFromPrivateKey(privateKey: Uint8Array): Address {
  assertPrivateKey(privateKey);
  const uncompressed = secp256k1.getPublicKey(privateKey, false);
  // Drop the 0x04 prefix; the address is the last 20 bytes of keccak256(pubkey).
  const hash = keccak_256(uncompressed.subarray(1));
  return getAddress(`0x${toHex(hash.subarray(12))}`);
}

/** Lowercase hex without the 0x prefix. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The raw private key as `0x`-prefixed hex.
 *
 * Anyone holding this string controls the wallet on every EVM chain. It is
 * produced only by the re-authenticated export endpoint.
 */
export function exportEvmPrivateKeyHex(privateKey: Uint8Array): string {
  assertPrivateKey(privateKey);
  return `0x${toHex(privateKey)}`;
}

export interface KeystoreV3 {
  version: 3;
  id: string;
  address: string;
  crypto: {
    ciphertext: string;
    cipherparams: { iv: string };
    cipher: 'aes-128-ctr';
    kdf: 'scrypt';
    kdfparams: { dklen: number; salt: string; n: number; r: number; p: number };
    mac: string;
  };
}

export interface KeystoreOptions {
  /** scrypt cost. 262144 is what geth and ethers use for "standard" strength. */
  n?: number;
  r?: number;
  p?: number;
  /** Test-only injection points; production callers leave these undefined. */
  salt?: Uint8Array;
  iv?: Uint8Array;
  uuid?: string;
}

/**
 * Encrypt a private key as a Web3 Secret Storage v3 keystore.
 *
 * This is the interchange format understood by geth, ethers and MetaMask, so an
 * operator can move an ATRA agent wallet into a tool they already trust without
 * ever handling the raw key.
 */
export function exportEvmKeystoreV3(
  privateKey: Uint8Array,
  password: string,
  options: KeystoreOptions = {},
): KeystoreV3 {
  assertPrivateKey(privateKey);

  const n = options.n ?? 262_144;
  const r = options.r ?? 8;
  const p = options.p ?? 1;
  const salt = options.salt ?? randomBytes(32);
  const iv = options.iv ?? randomBytes(16);
  const passwordBytes = new TextEncoder().encode(password.normalize('NFKC'));

  let derived: Uint8Array | undefined;
  try {
    derived = scrypt(passwordBytes, salt, { N: n, r, p, dkLen: 32 });
    const encryptionKey = derived.subarray(0, 16);
    const macPrefix = derived.subarray(16, 32);

    const ciphertext = ctr(encryptionKey, iv).encrypt(privateKey);
    const mac = keccak_256(concat(macPrefix, ciphertext));

    return {
      version: 3,
      id: options.uuid ?? randomUUID(),
      address: evmAddressFromPrivateKey(privateKey).slice(2).toLowerCase(),
      crypto: {
        ciphertext: toHex(ciphertext),
        cipherparams: { iv: toHex(iv) },
        cipher: 'aes-128-ctr',
        kdf: 'scrypt',
        kdfparams: { dklen: 32, salt: toHex(salt), n, r, p },
        mac: toHex(mac),
      },
    };
  } finally {
    wipe(passwordBytes, derived);
  }
}

/**
 * Decrypt a v3 keystore.
 *
 * Present so the export path can be round-trip tested against published
 * vectors; ATRA itself never imports external keystores in V1.
 */
export function decryptEvmKeystoreV3(keystore: KeystoreV3, password: string): Uint8Array {
  const { kdfparams, ciphertext, cipherparams, mac } = keystore.crypto;
  const passwordBytes = new TextEncoder().encode(password.normalize('NFKC'));

  let derived: Uint8Array | undefined;
  try {
    derived = scrypt(passwordBytes, fromHex(kdfparams.salt), {
      N: kdfparams.n,
      r: kdfparams.r,
      p: kdfparams.p,
      dkLen: kdfparams.dklen,
    });

    const cipherBytes = fromHex(ciphertext);
    const expectedMac = keccak_256(concat(derived.subarray(16, 32), cipherBytes));
    if (toHex(expectedMac) !== mac.toLowerCase()) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Keystore MAC mismatch: wrong password');
    }

    return ctr(derived.subarray(0, 16), fromHex(cipherparams.iv)).decrypt(cipherBytes);
  } finally {
    wipe(passwordBytes, derived);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function assertPrivateKey(privateKey: Uint8Array): void {
  if (privateKey.length !== EVM_PRIVATE_KEY_BYTES) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'An EVM private key must be 32 bytes', {
      details: { actual: privateKey.length },
    });
  }
}
