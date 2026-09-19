import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base58 } from '@scure/base';
import {
  decryptEvmKeystoreV3,
  evmAddressFromPrivateKey,
  exportEvmKeystoreV3,
  exportEvmPrivateKeyHex,
  fromHex,
  generateEvmPrivateKey,
  toHex,
} from '../src/wallet/evm.js';
import {
  exportSolanaBase58,
  exportSolanaIdJson,
  generateSolanaKeypair,
  isConsistentSecretKey,
  keypairFromSeed,
  parseSolanaIdJson,
  signWithSolanaKey,
  solanaAddressFromSecretKey,
} from '../src/wallet/solana.js';
import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Published test vectors are used wherever one exists, so these tests prove
 * interoperability with the wider ecosystem rather than self-consistency.
 */

// Web3 Secret Storage Definition, scrypt test vector.
const KEYSTORE_VECTOR = {
  version: 3 as const,
  id: '3198bc9c-6672-5ab3-d995-4942343ae5b6',
  address: '008aeeda4d805471df9b2a5b0f38a0c3bcba786b',
  crypto: {
    cipher: 'aes-128-ctr' as const,
    cipherparams: { iv: '83dbcc02d8ccb40e466191a123791e0e' },
    ciphertext: 'd172bf743a674da9cdad04534d56926ef8358534d458fffccd4e6ad2fbde479c',
    kdf: 'scrypt' as const,
    kdfparams: {
      dklen: 32,
      n: 262144,
      p: 8,
      r: 1,
      salt: 'ab0c7876052600dd703518d6fc3fe8984592145b591fc8fb5c6d43190334ba19',
    },
    mac: '2103ac29920d71da29f15d75b4a16dbe95cfd7ff8faea1056c33131d846e3097',
  },
};
const KEYSTORE_PASSWORD = 'testpassword';
const KEYSTORE_SECRET = '7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d';

// Vitalik's well-known key/address pair from the Ethereum test suite: private
// key of all-ones is not used anywhere real, so it is safe as a fixture.
const KNOWN_KEY = fromHex('0000000000000000000000000000000000000000000000000000000000000001');
const KNOWN_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

describe('EVM key generation', () => {
  it('produces a valid secp256k1 scalar', () => {
    const key = generateEvmPrivateKey();
    expect(key).toHaveLength(32);
    expect(secp256k1.utils.isValidSecretKey(key)).toBe(true);
  });

  it('produces a different key every time', () => {
    const seen = new Set(Array.from({ length: 20 }, () => toHex(generateEvmPrivateKey())));
    expect(seen.size).toBe(20);
  });

  it('derives the known address for a known key', () => {
    expect(evmAddressFromPrivateKey(KNOWN_KEY)).toBe(KNOWN_ADDRESS);
  });

  it('returns a checksummed address', () => {
    const address = evmAddressFromPrivateKey(generateEvmPrivateKey());
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(address).not.toBe(address.toLowerCase());
  });

  it('rejects a key of the wrong length', () => {
    expect(() => evmAddressFromPrivateKey(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe('EVM export', () => {
  it('exports the raw key as 0x hex', () => {
    expect(exportEvmPrivateKeyHex(KNOWN_KEY)).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    );
  });

  it('decrypts the published keystore v3 vector', () => {
    const secret = decryptEvmKeystoreV3(KEYSTORE_VECTOR, KEYSTORE_PASSWORD);
    expect(toHex(secret)).toBe(KEYSTORE_SECRET);
  });

  it('rejects the vector under a wrong password', () => {
    expect(() => decryptEvmKeystoreV3(KEYSTORE_VECTOR, 'wrong')).toThrow(/MAC mismatch/);
  });

  it('round-trips a keystore it produced', () => {
    const key = generateEvmPrivateKey();
    // A low scrypt cost keeps the test fast; production uses n=262144.
    const keystore = exportEvmKeystoreV3(key, 'correct horse battery staple', { n: 1024 });
    expect(keystore.version).toBe(3);
    expect(keystore.crypto.kdf).toBe('scrypt');
    expect(keystore.address).toBe(evmAddressFromPrivateKey(key).slice(2).toLowerCase());
    expect(toHex(decryptEvmKeystoreV3(keystore, 'correct horse battery staple'))).toBe(toHex(key));
  });

  it('never embeds the plaintext key in the keystore JSON', () => {
    const key = generateEvmPrivateKey();
    const json = JSON.stringify(exportEvmKeystoreV3(key, 'pw', { n: 1024 }));
    expect(json).not.toContain(toHex(key));
  });
});

describe('Solana keypairs', () => {
  it('derives seed||pubkey and a base58 address', () => {
    const seed = new Uint8Array(32).fill(1);
    const keypair = keypairFromSeed(seed);
    expect(keypair.secretKey).toHaveLength(64);
    expect(keypair.secretKey.subarray(0, 32)).toEqual(seed);
    expect(base58.decode(keypair.address)).toEqual(ed25519.getPublicKey(seed));
  });

  it('matches RFC 8032 test vector 1', () => {
    // RFC 8032 section 7.1, TEST 1.
    const seed = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
    const expectedPublic = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
    const keypair = keypairFromSeed(seed);
    expect(toHex(base58.decode(keypair.address))).toBe(expectedPublic);
  });

  it('generates distinct keypairs', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateSolanaKeypair().address));
    expect(seen.size).toBe(20);
  });

  it('recovers the address from a stored secret key', () => {
    const keypair = generateSolanaKeypair();
    expect(solanaAddressFromSecretKey(keypair.secretKey)).toBe(keypair.address);
  });

  it('detects an inconsistent secret key', () => {
    const keypair = generateSolanaKeypair();
    expect(isConsistentSecretKey(keypair.secretKey)).toBe(true);
    const tampered = Uint8Array.from(keypair.secretKey);
    tampered[63] = tampered[63]! ^ 0xff;
    expect(isConsistentSecretKey(tampered)).toBe(false);
  });

  it('signs verifiably', () => {
    const keypair = generateSolanaKeypair();
    const message = new TextEncoder().encode('atra');
    const signature = signWithSolanaKey(keypair.secretKey, message);
    expect(ed25519.verify(signature, message, base58.decode(keypair.address))).toBe(true);
  });
});

describe('Solana export formats', () => {
  it('writes id.json as 64 comma-separated bytes', () => {
    const keypair = generateSolanaKeypair();
    const json = exportSolanaIdJson(keypair.secretKey);
    expect(parseSolanaIdJson(json)).toEqual(keypair.secretKey);
    expect(JSON.parse(json)).toHaveLength(64);
  });

  it('writes base58 of the 64-byte secret', () => {
    const keypair = generateSolanaKeypair();
    expect(base58.decode(exportSolanaBase58(keypair.secretKey))).toEqual(keypair.secretKey);
  });

  it('rejects malformed id.json', () => {
    expect(() => parseSolanaIdJson('nope')).toThrow(/valid JSON/);
    expect(() => parseSolanaIdJson('[1,2,3]')).toThrow(/64 bytes/);
    expect(() => parseSolanaIdJson(`[${Array(64).fill(999).join(',')}]`)).toThrow(/non-byte/);
  });
});
