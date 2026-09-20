import { isAddress } from 'viem';
import { assertPubkey } from '../chains/solana/adapter.js';
import { chainFamily } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
import { AppError, ErrorCode } from '../util/errors.js';

/**
 * Address validation for the treasury.
 *
 * Both the watch-only treasury addresses and provider recipients pass through
 * here before they are stored. The rules are the ones the withdrawal path
 * applies to a destination, kept in a treasury-owned copy so the treasury
 * module does not import the withdrawal module (which reaches the wallet
 * service) for a twenty-line pure function.
 *
 * Returns the canonical form: lowercase for EVM, untouched for Solana.
 */
export function canonicalTreasuryAddress(chain: ChainId, address: string, field: string): string {
  if (chainFamily(chain) === 'evm') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw invalidAddress(field, 'must be a 0x-prefixed 40-hex address');
    }
    if (/^0x0{40}$/.test(address)) {
      throw invalidAddress(field, 'the zero address burns funds');
    }
    const body = address.slice(2);
    const mixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
    if (mixedCase && !isAddress(address, { strict: true })) {
      throw invalidAddress(field, 'EIP-55 checksum does not match');
    }
    return address.toLowerCase();
  }

  try {
    assertPubkey(address);
  } catch {
    throw invalidAddress(field, 'must be a base58 Solana public key');
  }
  return address;
}

function invalidAddress(field: string, message: string): AppError {
  return new AppError(ErrorCode.SCHEMA_INVALID, `Invalid ${field}: ${message}`, {
    errors: [{ path: field, message: 'INVALID_ADDRESS' }],
  });
}
