import { base58, base64 } from '@scure/base';
import { signWithSolanaKey, solanaAddressFromSecretKey } from '../../wallet/solana.js';
import { AppError, ErrorCode } from '../../util/errors.js';

/**
 * Solana transaction signing without a Solana SDK.
 *
 * A serialized transaction is `compact-u16 count || signatures[count] ||
 * message`. Signing means computing ed25519 over the message bytes and
 * writing the result into the fee payer's slot. The transaction id is the
 * first signature, base58 — known before broadcast, which is what the
 * executor needs to record it first.
 *
 * Only single-signer transactions are accepted: a router swap needs exactly
 * the wallet's signature, and a message asking for more would mean the
 * builder produced something other than a swap.
 */

const SIGNATURE_BYTES = 64;
const PUBKEY_BYTES = 32;

export interface SolanaMessageSummary {
  version: 'legacy' | 0;
  numRequiredSignatures: number;
  feePayer: string;
  /** Static account keys, in message order. */
  staticAccountKeys: string[];
  /**
   * Every program the message invokes at the top level, unique and sorted.
   *
   * A compiled instruction names its program by an index into the static
   * keys; the runtime rejects a program id that resolves through an address
   * lookup table, so this is the complete set regardless of message version.
   */
  programIds: string[];
}

export interface SignedSolanaTransaction {
  /** Base64 serialized signed transaction for `sendTransaction`. */
  raw: string;
  /** Base58 first signature: the transaction id. */
  signature: string;
  feePayer: string;
}

/** Read the parts of a message the executor must check before signing. */
export function summarizeSolanaTransaction(transactionBase64: string): SolanaMessageSummary {
  const bytes = decodeTransaction(transactionBase64);
  const { message } = splitTransaction(bytes);
  return summarizeMessage(message);
}

export function signSolanaTransaction(
  secretKey: Uint8Array,
  transactionBase64: string,
  expectedFeePayer: string,
): SignedSolanaTransaction {
  const bytes = decodeTransaction(transactionBase64);
  const { count, message } = splitTransaction(bytes);
  const summary = summarizeMessage(message);

  if (summary.numRequiredSignatures !== 1 || count !== 1) {
    throw new AppError(
      ErrorCode.CONFLICT,
      `Transaction expects ${String(summary.numRequiredSignatures)} signatures; only the wallet's is available`,
    );
  }

  const address = solanaAddressFromSecretKey(secretKey);
  if (address !== expectedFeePayer || summary.feePayer !== address) {
    throw new AppError(ErrorCode.CONFLICT, 'Signing key does not match the transaction fee payer');
  }

  const signature = signWithSolanaKey(secretKey, message);
  const signed = new Uint8Array(1 + SIGNATURE_BYTES + message.length);
  signed[0] = 1;
  signed.set(signature, 1);
  signed.set(message, 1 + SIGNATURE_BYTES);

  return {
    raw: base64.encode(signed),
    signature: base58.encode(signature),
    feePayer: address,
  };
}

function decodeTransaction(transactionBase64: string): Uint8Array {
  try {
    const bytes = base64.decode(transactionBase64);
    if (bytes.length < 1 + SIGNATURE_BYTES + 3) {
      throw new Error('too short');
    }
    return bytes;
  } catch (error) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed serialized transaction', {
      cause: error,
    });
  }
}

/** Split off the signature array; returns the message bytes that get signed. */
function splitTransaction(bytes: Uint8Array): { count: number; message: Uint8Array } {
  const [count, offset] = readCompactU16(bytes, 0);
  const messageStart = offset + count * SIGNATURE_BYTES;
  if (count < 1 || count > 8 || messageStart >= bytes.length) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Transaction signature array is malformed');
  }
  return { count, message: bytes.subarray(messageStart) };
}

function summarizeMessage(message: Uint8Array): SolanaMessageSummary {
  let offset = 0;
  let version: 'legacy' | 0 = 'legacy';

  // A versioned message sets the high bit of its first byte.
  const prefix = message[0];
  if (prefix === undefined) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Empty message');
  }
  if ((prefix & 0x80) !== 0) {
    const versionNumber = prefix & 0x7f;
    if (versionNumber !== 0) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        `Unsupported message version ${String(versionNumber)}`,
      );
    }
    version = 0;
    offset = 1;
  }

  const numRequiredSignatures = message[offset];
  if (numRequiredSignatures === undefined || message.length < offset + 3) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Message header is truncated');
  }
  offset += 3;

  const [keyCount, afterCount] = readCompactU16(message, offset);
  offset = afterCount;
  if (keyCount < 1 || message.length < offset + keyCount * PUBKEY_BYTES) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Message account keys are truncated');
  }

  const staticAccountKeys: string[] = [];
  for (let index = 0; index < keyCount; index += 1) {
    const start = offset + index * PUBKEY_BYTES;
    staticAccountKeys.push(base58.encode(message.subarray(start, start + PUBKEY_BYTES)));
  }
  offset += keyCount * PUBKEY_BYTES;

  // Recent blockhash, then the instruction list.
  if (message.length < offset + PUBKEY_BYTES) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Message blockhash is truncated');
  }
  offset += PUBKEY_BYTES;

  const [instructionCount, afterInstructionCount] = readCompactU16(message, offset);
  offset = afterInstructionCount;

  const programIds = new Set<string>();
  for (let index = 0; index < instructionCount; index += 1) {
    const programIdIndex = message[offset];
    if (programIdIndex === undefined) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Instruction program index is truncated');
    }
    offset += 1;

    const programId = staticAccountKeys[programIdIndex];
    if (programId === undefined) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        `Instruction names account ${String(programIdIndex)}, which the message does not carry`,
      );
    }
    programIds.add(programId);

    const [accountCount, afterAccounts] = readCompactU16(message, offset);
    offset = afterAccounts + accountCount;
    const [dataLength, afterDataLength] = readCompactU16(message, offset);
    offset = afterDataLength + dataLength;
    if (message.length < offset) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Instruction data is truncated');
    }
  }

  return {
    version,
    numRequiredSignatures,
    feePayer: staticAccountKeys[0]!,
    staticAccountKeys,
    programIds: [...programIds].sort(),
  };
}

function readCompactU16(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (let index = 0; index < 3; index += 1) {
    const byte = bytes[cursor];
    if (byte === undefined) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Truncated compact-u16');
    }
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [value, cursor];
    }
    shift += 7;
  }
  throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed compact-u16');
}
