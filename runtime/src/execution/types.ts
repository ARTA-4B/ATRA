import type { ChainId } from '../chains/registry.js';
import type { FeeDetail, ProposedAction } from '../risk/types.js';
import type { SigningContext, SignedTransaction } from '../chains/types.js';

/**
 * The execution layer.
 *
 * An adapter is a named, closed set of operations against one protocol on one
 * chain. There is deliberately no `call(contract, data)` anywhere in this
 * interface: the only way to reach a chain is through an adapter that knows
 * exactly which contracts it talks to, and those contracts must also appear
 * in the operator's allowlist before the risk engine will let an action
 * through.
 *
 * Every adapter reports the contracts and programs it will touch *before*
 * anything is signed, so the risk engine checks the real transaction, not a
 * description of it.
 */

export interface QuoteRequest {
  chain: ChainId;
  tokenIn: { address: string; decimals: number };
  tokenOut: { address: string; decimals: number };
  amountIn: string;
  slippageBps: number;
  /** The address that will send the transaction. Needed for some quotes. */
  from: string;
}

export interface ExecutionQuote {
  chain: ChainId;
  protocol: string;
  /** The contract (EVM `to`) or program the transaction targets. */
  contract: string;
  /** Solana only: every top-level program the built transaction invokes. */
  programIds?: string[];
  tokenIn: { address: string; decimals: number };
  tokenOut: { address: string; decimals: number };
  amountIn: string;
  expectedAmountOut: string;
  minAmountOut: string;
  slippageBps: number;
  priceImpactBps: number;
  quotedAt: number;
  source: string;
  /** Pool or pair identifier the liquidity check reads. */
  marketId: string;
  feeEstimate: { estimatedAt: number; detail: FeeDetail };
  /** Adapter-private data needed to build the transaction. Never logged. */
  routeData?: unknown;
}

export interface SimulationResult {
  ok: boolean;
  /** What the simulation says would be received. */
  amountOut: string | null;
  /** Gas or compute units the simulation consumed. */
  unitsUsed: number | null;
  error: string | null;
  simulatedAt: number;
}

export interface UnsignedTransaction {
  chain: ChainId;
  /** Opaque, adapter-specific payload handed to the signer. */
  payload: unknown;
  /** Human-readable summary for the audit row. No calldata. */
  summary: string;
}

export interface ExecutionReceipt {
  chain: ChainId;
  hash: string;
  status: 'pending' | 'confirmed' | 'failed' | 'unknown';
  /**
   * What the wallet actually received, read from the chain (ERC-20 Transfer
   * logs, or Solana pre/post token balances). Null when the receipt could not
   * expose it — never an estimate.
   */
  amountOut: string | null;
  feeNative: string | null;
  height: number | null;
  error: string | null;
}

/** What `receipt` needs to read the received amount off the chain. */
export interface ReceiptExpectation {
  tokenOut: string;
  recipient: string;
}

export type { SigningContext, SignedTransaction } from '../chains/types.js';

export interface ExecutionAdapter {
  readonly chain: ChainId;
  readonly protocol: string;
  /** Every contract or program this adapter can ever target. */
  readonly contracts: readonly string[];

  /** Whether the adapter has a route between these tokens at all. */
  supportsRoute(tokenIn: string, tokenOut: string): Promise<boolean>;

  quote(request: QuoteRequest): Promise<ExecutionQuote>;

  /**
   * Run the transaction against the chain without signing.
   *
   * LIVE mode uses this to confirm the route still works and to observe the
   * real output before anything is committed; PAPER mode uses the result as
   * the fill it pretends happened.
   */
  /**
   * Simulate the transaction that is about to be signed.
   *
   * `tx` is the built transaction, not a fresh one: an adapter that built its
   * own would be simulating a different set of bytes, which on a keyless
   * public endpoint is a different answer from a different party.
   */
  simulate(quote: ExecutionQuote, tx: UnsignedTransaction): Promise<SimulationResult>;

  /** Build the unsigned transaction. LIVE only. */
  build(quote: ExecutionQuote): Promise<UnsignedTransaction>;

  /**
   * Fetch what signing needs (nonce, fee caps, blockhash validity) for a built
   * transaction. Performs reads only; nothing is signed or sent.
   */
  prepareSigning(tx: UnsignedTransaction, from: string): Promise<SigningContext>;

  /**
   * Broadcast a signed transaction. The caller has already recorded
   * `signed.hash`; a failure here leaves a row that names its transaction so
   * the next start can ask the chain what happened.
   */
  broadcast(signed: SignedTransaction): Promise<void>;

  /** Look up a broadcast transaction. */
  receipt(hash: string, expect?: ReceiptExpectation): Promise<ExecutionReceipt>;
}

/**
 * EVM routers pull tokens from the wallet, so the wallet must have approved
 * them first. Adapters that need this expose it explicitly; the pipeline
 * checks the allowance and routes an `approve` action through the risk engine
 * like any other transaction.
 */
export interface Erc20ApprovalCapable {
  allowance(token: string, owner: string): Promise<bigint>;
  buildApprove(token: string, owner: string, amount: bigint): UnsignedTransaction;
  /** Gas estimate for an approval, for the fee check. */
  approveFeeEstimate(): Promise<{ estimatedAt: number; detail: FeeDetail }>;
}

export function supportsErc20Approval(
  adapter: ExecutionAdapter,
): adapter is ExecutionAdapter & Erc20ApprovalCapable {
  return (
    typeof (adapter as Partial<Erc20ApprovalCapable>).allowance === 'function' &&
    typeof (adapter as Partial<Erc20ApprovalCapable>).buildApprove === 'function' &&
    typeof (adapter as Partial<Erc20ApprovalCapable>).approveFeeEstimate === 'function'
  );
}

/** Whether an adapter is currently able to serve requests. */
export interface AdapterStatus {
  chain: ChainId;
  protocol: string;
  available: boolean;
  detail: string;
}

/** What the executor hands back after acting on an allowed proposal. */
export interface ExecutionOutcome {
  actionId: string;
  mode: 'PAPER' | 'LIVE';
  status: 'filled' | 'failed';
  amountOut: string | null;
  feeUsd: string;
  txHash: string | null;
  error: string | null;
  filledAt: number;
}

export type { ProposedAction };
