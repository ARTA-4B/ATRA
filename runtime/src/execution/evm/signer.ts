import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, serializeTransaction } from 'viem';
import type { Hex, TransactionSerializableEIP1559 } from 'viem';
import { evmAddressFromPrivateKey } from '../../wallet/evm.js';
import { AppError, ErrorCode } from '../../util/errors.js';

/**
 * EVM transaction signing, entirely synchronous.
 *
 * The vault hands out plaintext only inside a synchronous callback and wipes
 * it on return, so signing cannot await anything. Everything here — RLP
 * serialization, keccak, the ECDSA signature — is pure computation on bytes.
 * Nonce, fees and gas are fetched by the caller beforehand.
 *
 * The signed transaction's hash is computed here, before anything is sent.
 * The executor records it first and broadcasts second.
 */

export interface EvmTransactionFields {
  chainId: number;
  nonce: number;
  to: Hex;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface SignedEvmTransaction {
  /** RLP-encoded signed transaction, ready for eth_sendRawTransaction. */
  raw: Hex;
  /** keccak256 of `raw`: the transaction hash the chain will report. */
  hash: Hex;
  from: string;
}

export function signEvmTransaction(
  privateKey: Uint8Array,
  fields: EvmTransactionFields,
  expectedFrom: string,
): SignedEvmTransaction {
  const from = evmAddressFromPrivateKey(privateKey);
  if (from.toLowerCase() !== expectedFrom.toLowerCase()) {
    // The key does not control the address the transaction was built for.
    // Signing anyway would spend from a wallet the operator was never shown.
    throw new AppError(ErrorCode.CONFLICT, 'Signing key does not match the sending address');
  }

  const unsigned: TransactionSerializableEIP1559 = {
    type: 'eip1559',
    chainId: fields.chainId,
    nonce: fields.nonce,
    to: fields.to,
    data: fields.data,
    value: fields.value,
    gas: fields.gas,
    maxFeePerGas: fields.maxFeePerGas,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
  };

  const digest = keccak_256(hexToBytes(serializeTransaction(unsigned)));
  const signature = secp256k1.sign(digest, privateKey, {
    prehash: false,
    lowS: true,
    format: 'recovered',
  });

  const recovery = signature[0];
  if (recovery !== 0 && recovery !== 1) {
    throw new AppError(ErrorCode.INTERNAL, 'Unexpected recovery id from signer');
  }

  const raw = serializeTransaction(unsigned, {
    r: bytesToHex(signature.subarray(1, 33)),
    s: bytesToHex(signature.subarray(33, 65)),
    yParity: recovery,
  });

  return { raw, hash: bytesToHex(keccak_256(hexToBytes(raw))), from };
}
