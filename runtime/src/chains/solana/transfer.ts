import { base58 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { AppError, ErrorCode } from '../../util/errors.js';

/**
 * Hand-built Solana transfer messages.
 *
 * Two instructions are needed for operator withdrawals — a System Program
 * transfer for SOL and an SPL `TransferChecked` (preceded by an idempotent
 * associated-token-account creation) for tokens. Both have a fixed, documented
 * wire format, so they are encoded here directly rather than pulling in a
 * Solana SDK for two byte layouts.
 *
 * Only *legacy* messages are produced. They carry no address-lookup tables and
 * the signer in `../../execution/solana/signer.ts` accepts them as-is.
 */

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** Size of an SPL token account, for the rent-exempt minimum. */
export const TOKEN_ACCOUNT_BYTES = 165;

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

/**
 * Derive the associated token account for (owner, mint) under the given token
 * program. Standard PDA search: the first bump from 255 downward whose hash is
 * not a valid curve point.
 */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  const seeds = [base58.decode(owner), base58.decode(tokenProgram), base58.decode(mint)];
  const program = base58.decode(ASSOCIATED_TOKEN_PROGRAM);

  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = sha256(concat([...seeds, Uint8Array.of(bump), program, PDA_MARKER]));
    if (!isOnCurve(hash)) return base58.encode(hash);
  }
  throw new AppError(ErrorCode.INTERNAL, 'No associated token address could be derived');
}

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

export interface LegacyInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array;
}

/**
 * Compile instructions into a legacy message with one required signer, the
 * fee payer, first. Accounts are ordered as the runtime requires: signers,
 * then writable non-signers, then read-only non-signers.
 */
export function compileLegacyMessage(
  feePayer: string,
  recentBlockhash: string,
  instructions: LegacyInstruction[],
): Uint8Array {
  const meta = new Map<string, { isSigner: boolean; isWritable: boolean }>();
  const upsert = (pubkey: string, isSigner: boolean, isWritable: boolean): void => {
    const current = meta.get(pubkey) ?? { isSigner: false, isWritable: false };
    meta.set(pubkey, {
      isSigner: current.isSigner || isSigner,
      isWritable: current.isWritable || isWritable,
    });
  };

  upsert(feePayer, true, true);
  for (const instruction of instructions) {
    for (const account of instruction.accounts)
      upsert(account.pubkey, account.isSigner, account.isWritable);
    upsert(instruction.programId, false, false);
  }

  const signers = [...meta.entries()].filter(([, m]) => m.isSigner);
  if (signers.length !== 1 || signers[0]![0] !== feePayer) {
    throw new AppError(
      ErrorCode.CONFLICT,
      'A transfer message must have exactly one signer, the fee payer',
    );
  }

  const ordered = [
    feePayer,
    ...[...meta.entries()].filter(([, m]) => !m.isSigner && m.isWritable).map(([key]) => key),
    ...[...meta.entries()].filter(([, m]) => !m.isSigner && !m.isWritable).map(([key]) => key),
  ];
  const readonlyUnsigned = [...meta.values()].filter((m) => !m.isSigner && !m.isWritable).length;
  const index = new Map(ordered.map((key, i) => [key, i]));

  const parts: Uint8Array[] = [
    Uint8Array.of(1, 0, readonlyUnsigned),
    compactU16(ordered.length),
    ...ordered.map((key) => base58.decode(key)),
    base58.decode(recentBlockhash),
    compactU16(instructions.length),
  ];

  for (const instruction of instructions) {
    parts.push(Uint8Array.of(index.get(instruction.programId)!));
    parts.push(compactU16(instruction.accounts.length));
    parts.push(Uint8Array.from(instruction.accounts.map((account) => index.get(account.pubkey)!)));
    parts.push(compactU16(instruction.data.length));
    parts.push(instruction.data);
  }

  return concat(parts);
}

/** An unsigned legacy transaction: one empty signature slot plus the message. */
export function unsignedTransactionBase64(message: Uint8Array): string {
  const bytes = concat([Uint8Array.of(1), new Uint8Array(64), message]);
  return Buffer.from(bytes).toString('base64');
}

export function systemTransfer(from: string, to: string, lamports: bigint): LegacyInstruction {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true); // SystemInstruction::Transfer
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

export function createAssociatedTokenAccountIdempotent(
  payer: string,
  ata: string,
  owner: string,
  mint: string,
  tokenProgram: string,
): LegacyInstruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1), // CreateIdempotent
  };
}

export function transferChecked(
  source: string,
  mint: string,
  destination: string,
  owner: string,
  amount: bigint,
  decimals: number,
  tokenProgram: string,
): LegacyInstruction {
  const data = new Uint8Array(10);
  data[0] = 12; // TokenInstruction::TransferChecked
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return {
    programId: tokenProgram,
    accounts: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

function compactU16(value: number): Uint8Array {
  if (value < 0 || value > 0xffff)
    throw new AppError(ErrorCode.INTERNAL, 'compact-u16 out of range');
  const out: number[] = [];
  let remaining = value;
  for (;;) {
    const byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return Uint8Array.from(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
