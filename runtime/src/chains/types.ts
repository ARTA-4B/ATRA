import type { ChainId } from './registry.js';

/**
 * The normalized interface every chain adapter implements.
 *
 * Both EVM and Solana are expressed in the same terms so the layers above
 * never branch on chain family. Two rules hold everywhere:
 *
 *  - amounts are base-unit integer strings (wei, lamports, token base units);
 *    no adapter ever returns a float;
 *  - every reading carries the time it was observed and the endpoint it came
 *    from, because the risk engine refuses data it cannot date.
 */

export interface Observation<T> {
  value: T;
  /** When the runtime received this reading. */
  observedAt: number;
  /** The endpoint that produced it, for attribution in the dashboard. */
  source: string;
}

export interface NativeBalance {
  chain: ChainId;
  address: string;
  /** Base units: wei on EVM, lamports on Solana. */
  amount: string;
  symbol: string;
  decimals: number;
}

export interface TokenBalance {
  chain: ChainId;
  owner: string;
  token: string;
  amount: string;
  symbol: string | null;
  decimals: number;
}

export interface TokenMetadata {
  chain: ChainId;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

export interface FeeEstimate {
  chain: ChainId;
  /** Total fee for a simple transfer, in native base units. */
  nativeAmount: string;
  /** EVM: gas price in wei. Solana: lamports per signature. */
  unitPrice: string;
  /** EVM: gas limit assumed. Solana: number of signatures assumed. */
  units: number;
}

export type TransactionState = 'unknown' | 'pending' | 'confirmed' | 'failed';

export interface TransactionStatus {
  chain: ChainId;
  hash: string;
  state: TransactionState;
  /** Block number on EVM, slot on Solana. */
  height: number | null;
  confirmations: number | null;
  error: string | null;
}

export interface ChainHealth {
  chain: ChainId;
  healthy: boolean;
  /** Latest block on EVM, latest slot on Solana. */
  height: number | null;
  latencyMs: number | null;
  endpoint: string;
  error: string | null;
  /**
   * Proof the endpoint really serves the chain we asked for: the EVM chain id
   * or the Solana genesis hash. A mismatch is a hard failure, never a warning.
   */
  identity: string | null;
  identityMatches: boolean;
}

export interface ChainAdapter {
  readonly chain: ChainId;

  /** Confirm the endpoint serves this exact chain, and report its height. */
  health(): Promise<ChainHealth>;

  getNativeBalance(address: string): Promise<Observation<NativeBalance>>;

  getTokenBalance(owner: string, token: string): Promise<Observation<TokenBalance>>;

  getTokenMetadata(token: string): Promise<Observation<TokenMetadata>>;

  estimateTransferFee(): Promise<Observation<FeeEstimate>>;

  getTransactionStatus(hash: string): Promise<Observation<TransactionStatus>>;
}

// ---------------------------------------------------------------------------
// Transfers (Phase 3). Used by operator withdrawals only; agent trades go
// through the execution adapters, which know their contracts.
// ---------------------------------------------------------------------------

export interface TransferRequest {
  from: string;
  to: string;
  /** Null for the native coin. */
  token: string | null;
  amount: bigint;
  decimals: number;
}

export interface PreparedTransfer {
  chain: ChainId;
  /** Family-specific unsigned payload. Never contains key material. */
  payload: unknown;
  /**
   * Total fee in native base units, or null when it could not be estimated.
   * A null fee means the transfer must not be submitted.
   */
  feeNative: string | null;
  feeSource: string;
  summary: string;
  warnings: string[];
}

/**
 * Everything the synchronous signer needs, fetched by the adapter before the
 * key is touched. Family-specific because the transaction formats are.
 */
export type SigningContext =
  | {
      family: 'evm';
      chainId: number;
      from: string;
      to: string;
      data: string;
      value: string;
      gas: string;
      nonce: number;
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
    }
  | {
      family: 'solana';
      feePayer: string;
      transactionBase64: string;
      lastValidBlockHeight: number | null;
    };

export interface SignedTransaction {
  /** Serialized signed transaction (hex for EVM, base64 for Solana). */
  raw: string;
  /** Transaction hash or signature, known before broadcast. */
  hash: string;
}

export interface TransferCapable {
  prepareTransfer(request: TransferRequest): Promise<PreparedTransfer>;
  transferSigningContext(prepared: PreparedTransfer): Promise<SigningContext>;
  broadcastSigned(signed: SignedTransaction): Promise<void>;
}

export function supportsTransfers(
  adapter: ChainAdapter,
): adapter is ChainAdapter & TransferCapable {
  const candidate = adapter as Partial<TransferCapable>;
  return (
    typeof candidate.prepareTransfer === 'function' &&
    typeof candidate.transferSigningContext === 'function' &&
    typeof candidate.broadcastSigned === 'function'
  );
}
