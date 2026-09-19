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
