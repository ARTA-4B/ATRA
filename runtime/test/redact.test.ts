import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  containsSecret,
  isSecretKey,
  redact,
  redactString,
} from '../src/logging/redact.js';

/**
 * Redaction is a security control, so the tests are written as a list of things
 * that must never appear in a log line, not as a list of things the function
 * happens to do today.
 */

const EVM_KEY = '0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d';
const SOLANA_B58 =
  '4wBqpZM9xaSheZzJSMawUHDgZ7miWfSsxmfVF5jJpYP2d8QyYqPGyhCjL9BJ4Gv2EZJ8vdEuVyHqcrHBTXDzRsTL';
const ID_JSON = `[${Array.from({ length: 64 }, (_, i) => i).join(',')}]`;
const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('redactString', () => {
  it('removes an EVM private key', () => {
    const out = redactString(`key is ${EVM_KEY} ok`);
    expect(out).not.toContain(EVM_KEY);
    expect(out).toContain(REDACTED);
  });

  it('removes a bare 32-byte hex string', () => {
    const bare = EVM_KEY.slice(2);
    expect(redactString(`secret=${bare}`)).not.toContain(bare);
  });

  it('removes a base58 Solana secret key', () => {
    expect(redactString(`imported ${SOLANA_B58}`)).not.toContain(SOLANA_B58);
  });

  it('removes a solana id.json byte array', () => {
    expect(redactString(`file ${ID_JSON}`)).not.toContain('63]');
  });

  it('removes a 12-word mnemonic', () => {
    expect(redactString(`phrase: ${MNEMONIC}`)).not.toContain('sausage');
  });

  it('removes a Telegram bot token', () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    expect(redactString(`token ${token}`)).not.toContain(token);
  });

  it('leaves ordinary operational text intact', () => {
    const line = 'wallet 0x1234 balance 1.25 ETH on base at 2026-09-19T00:00:00Z';
    expect(redactString(line)).toBe(line);
  });

  it('leaves a public address intact', () => {
    const line = 'to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
    expect(redactString(line)).toBe(line);
  });
});

describe('containsSecret', () => {
  it('detects key material', () => {
    expect(containsSecret(EVM_KEY)).toBe(true);
    expect(containsSecret(SOLANA_B58)).toBe(true);
  });

  it('does not flag ordinary text', () => {
    expect(containsSecret('base chain, 100 USDC, pool 0xabc')).toBe(false);
  });
});

describe('isSecretKey', () => {
  it.each([
    'password',
    'passphrase',
    'secret',
    'secretKey',
    'privateKey',
    'private_key',
    'mnemonic',
    'seed',
    'apiKey',
    'api_key',
    'token',
    'authorization',
    'cookie',
    'pepper',
  ])('flags %s', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(['address', 'chain', 'amount', 'tokenSymbol', 'poolId'])('allows %s', (key) => {
    expect(isSecretKey(key)).toBe(false);
  });
});

describe('redact', () => {
  it('replaces values under secret keys without inspecting them', () => {
    const out = redact({ password: 'hunter2', address: '0xabc' }) as Record<string, unknown>;
    expect(out['password']).toBe(REDACTED);
    expect(out['address']).toBe('0xabc');
  });

  it('never renders raw bytes', () => {
    const out = redact({ dek: new Uint8Array(32) }) as Record<string, unknown>;
    expect(out['dek']).toBe(REDACTED);
    const nested = redact({ buffer: new Uint8Array([1, 2, 3]) }) as Record<string, unknown>;
    expect(nested['buffer']).toBe('[bytes:3]');
  });

  it('scrubs secrets nested inside arrays and objects', () => {
    const out = JSON.stringify(redact({ items: [{ note: `k=${EVM_KEY}` }] }));
    expect(out).not.toContain(EVM_KEY);
  });

  it('survives circular references', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;
    expect(() => redact(node)).not.toThrow();
    expect(JSON.stringify(redact(node))).toContain('[Circular]');
  });

  it('stops at a depth limit instead of recursing forever', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[MaxDepth]');
  });

  it('renders errors without leaking secrets in the message', () => {
    const out = redact(new Error(`boom ${EVM_KEY}`)) as { message: string };
    expect(out.message).not.toContain(EVM_KEY);
  });

  it('stringifies bigint safely', () => {
    expect(redact({ wei: 10n })).toEqual({ wei: '10n' });
  });
});
