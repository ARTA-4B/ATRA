import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database.js';
import { closeDatabase, openDatabase } from '../src/db/database.js';
import { Vault } from '../src/wallet/vault.js';
import { generateEvmPrivateKey, toHex } from '../src/wallet/evm.js';
import { generateSolanaKeypair } from '../src/wallet/solana.js';
import type { KdfParams } from '../src/wallet/crypto.js';

/**
 * The vault tests use deliberately weak KDF parameters so the suite stays fast.
 * A separate test asserts the production parameters are within a sane unlock
 * budget, which is the property that actually matters for the defaults.
 */
const FAST_KDF: KdfParams = { memoryKib: 1024, iterations: 1, parallelism: 1 };

const PASSWORD = 'correct horse battery staple';

describe('Vault', () => {
  let db: Db;
  let vault: Vault;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    vault = new Vault(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('starts uninitialized and locked', () => {
    expect(vault.isInitialized).toBe(false);
    expect(vault.isUnlocked).toBe(false);
  });

  it('initializes and is left unlocked for setup', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    expect(vault.isInitialized).toBe(true);
    expect(vault.isUnlocked).toBe(true);
  });

  it('refuses to initialize twice', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    await expect(vault.initialize(PASSWORD, FAST_KDF)).rejects.toThrow(/already been created/);
  });

  it('unlocks with the right password after a restart', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    const id = vault.putSecret('evm_private_key', 'agent', new Uint8Array([1, 2, 3]));

    const reopened = new Vault(db);
    expect(reopened.isUnlocked).toBe(false);
    await reopened.unlock(PASSWORD);
    expect(reopened.useSecret(id, (bytes) => Array.from(bytes))).toEqual([1, 2, 3]);
  });

  it('rejects the wrong password', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    const reopened = new Vault(db);
    await expect(reopened.unlock('wrong password')).rejects.toThrow(/wrong password|corrupted/i);
    expect(reopened.isUnlocked).toBe(false);
  });

  it('cannot read secrets while locked', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    const id = vault.putSecret('evm_private_key', 'agent', new Uint8Array([9]));
    vault.lock();
    expect(() => vault.useSecret(id, (b) => b)).toThrow(/locked/i);
  });

  it('cannot write secrets while locked', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    vault.lock();
    expect(() => vault.putSecret('evm_private_key', 'x', new Uint8Array([1]))).toThrow(/locked/i);
  });

  it('wipes the plaintext buffer after the callback returns', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    const id = vault.putSecret('evm_private_key', 'agent', new Uint8Array([7, 7, 7]));
    let captured: Uint8Array | undefined;
    vault.useSecret(id, (bytes) => {
      captured = bytes;
      return null;
    });
    expect(captured).toBeDefined();
    expect(Array.from(captured!)).toEqual([0, 0, 0]);
  });

  it('round-trips a real EVM key', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    const key = generateEvmPrivateKey();
    const expected = toHex(key);
    const id = vault.putSecret('evm_private_key', 'evm-agent', key);

    const reopened = new Vault(db);
    await reopened.unlock(PASSWORD);
    expect(reopened.exportSecret(id, toHex)).toBe(expected);
  });

  it('round-trips a real Solana keypair', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    const keypair = generateSolanaKeypair();
    const expected = Array.from(keypair.secretKey);
    const id = vault.putSecret('solana_keypair', 'solana-agent', keypair.secretKey);
    expect(vault.useSecret(id, (b) => Array.from(b))).toEqual(expected);
  });

  it('fails to decrypt when the ciphertext is tampered with', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    const id = vault.putSecret('evm_private_key', 'agent', new Uint8Array([1, 2, 3, 4]));

    const row = db
      .prepare<[string], { ciphertext: Buffer }>(
        'SELECT ciphertext FROM vault_secrets WHERE id = ?',
      )
      .get(id)!;
    const tampered = Buffer.from(row.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    db.prepare('UPDATE vault_secrets SET ciphertext = ? WHERE id = ?').run(tampered, id);

    expect(() => vault.useSecret(id, (b) => b)).toThrow(/decrypt/i);
  });

  it('fails to decrypt when a secret is moved to another row (AAD binding)', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    const a = vault.putSecret('evm_private_key', 'a', new Uint8Array([1]));
    const b = vault.putSecret('evm_private_key', 'b', new Uint8Array([2]));

    const rowA = db
      .prepare<[string], { nonce: Buffer; ciphertext: Buffer }>(
        'SELECT nonce, ciphertext FROM vault_secrets WHERE id = ?',
      )
      .get(a)!;
    db.prepare('UPDATE vault_secrets SET nonce = ?, ciphertext = ? WHERE id = ?').run(
      rowA.nonce,
      rowA.ciphertext,
      b,
    );

    expect(() => vault.useSecret(b, (bytes) => bytes)).toThrow(/decrypt/i);
  });

  it('changes the password and keeps existing secrets readable', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    const id = vault.putSecret('evm_private_key', 'agent', new Uint8Array([4, 2]));

    await vault.changePassword(PASSWORD, 'a brand new password', FAST_KDF);
    expect(vault.useSecret(id, (b) => Array.from(b))).toEqual([4, 2]);

    const reopened = new Vault(db);
    await reopened.unlock('a brand new password');
    expect(reopened.useSecret(id, (b) => Array.from(b))).toEqual([4, 2]);
    await expect(new Vault(db).unlock(PASSWORD)).rejects.toThrow();
  });

  it('refuses a password change without the current password', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    await expect(vault.changePassword('nope', 'other', FAST_KDF)).rejects.toThrow();
  });

  it('verifies a password without unlocking', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    expect(await vault.verifyPassword(PASSWORD)).toBe(true);
    expect(await vault.verifyPassword('nope')).toBe(false);
  });

  it('lists secrets without exposing ciphertext', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    vault.putSecret('evm_private_key', 'evm', new Uint8Array([1]));
    vault.putSecret('solana_keypair', 'sol', new Uint8Array([2]));

    const listed = vault.listSecrets();
    expect(listed).toHaveLength(2);
    expect(Object.keys(listed[0]!).sort()).toEqual(['createdAt', 'id', 'kind', 'label']);
  });

  it('auto-locks after the idle window', async () => {
    const shortLived = new Vault(db, { autolockMs: 1 });
    await shortLived.initialize(PASSWORD, FAST_KDF);
    const id = shortLived.putSecret('evm_private_key', 'agent', new Uint8Array([1]));

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(shortLived.isUnlocked).toBe(false);
    expect(() => shortLived.useSecret(id, (b) => b)).toThrow(/locked/i);
  });

  it('stores no plaintext anywhere in the database file', async () => {
    await vault.initialize(PASSWORD, FAST_KDF);
    const key = generateEvmPrivateKey();
    vault.putSecret('evm_private_key', 'agent', key);

    const rows = db
      .prepare<[], Record<string, unknown>>('SELECT * FROM vault_secrets')
      .all()
      .map((row) =>
        Object.values(row)
          .map((value) => (Buffer.isBuffer(value) ? value.toString('hex') : String(value)))
          .join('|'),
      )
      .join('\n');

    expect(rows).not.toContain(toHex(key));
  });
});

describe('default KDF parameters', () => {
  it('derive a key within an acceptable unlock budget', async () => {
    const db = openDatabase({ file: ':memory:' });
    const vault = new Vault(db);
    const started = Date.now();
    await vault.initialize(PASSWORD);
    const elapsed = Date.now() - started;
    closeDatabase(db);

    // Generous ceiling: CI runners are slower than a developer laptop. The point
    // is to catch a parameter bump that would make unlocking take 30 seconds.
    expect(elapsed).toBeLessThan(15_000);
  });
});
