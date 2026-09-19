import type { ChainId } from '../chains/registry.js';
import type { SignedTransaction, SigningContext } from '../chains/types.js';
import type { FeeDetail } from '../risk/types.js';
import type { UnsignedTransaction } from '../execution/types.js';

/**
 * The liquidity layer's vocabulary.
 *
 * An LP adapter is a named, closed set of operations against one liquidity
 * protocol on one chain, exactly like an execution adapter: it can read a
 * pool, read a position, quote an add or remove, and build one of three
 * transactions (add, remove, claim) against the protocol router or the pool
 * itself. There is no `call(contract, data)`. A pool the protocol's own
 * factory does not recognise is refused at the adapter, before any policy
 * question is asked.
 *
 * Everything is base-unit integer strings and dated observations, so the
 * risk engine can value it and refuse what it cannot date.
 */

export type LpProtocolKind = 'v2';

export interface LpTokenInfo {
  address: string;
  decimals: number;
  symbol: string | null;
}

/** A pool as the chain reports it. */
export interface LpPoolState {
  chain: ChainId;
  protocol: string;
  /** The pool (pair) contract, lowercase. Also the LP token address on v2. */
  poolId: string;
  kind: LpProtocolKind;
  /** Aerodrome stable-swap flag; always false on Uniswap-v2-style pairs. */
  stable: boolean;
  token0: LpTokenInfo;
  token1: LpTokenInfo;
  reserve0: string;
  reserve1: string;
  totalSupply: string;
  lpTokenDecimals: number;
  /** Swap fee in basis points when the protocol exposes it; null otherwise. */
  feeBps: number | null;
  /** v2 pools have no price range; a concentrated-liquidity adapter would set one. */
  range: { lowerUsd: string; upperUsd: string; inRange: boolean } | null;
  observedAt: number;
  source: string;
}

/** A wallet's position in one pool, as the chain reports it. */
export interface LpPositionState {
  chain: ChainId;
  protocol: string;
  poolId: string;
  owner: string;
  lpTokens: string;
  /** The wallet's share of the reserves, floor-rounded. */
  amount0: string;
  amount1: string;
  /**
   * Fees claimable by the holder, when the protocol tracks them separately
   * (Aerodrome). Null when fees compound into the reserves (Uniswap v2 style)
   * and there is nothing to claim.
   */
  claimable0: string | null;
  claimable1: string | null;
  claimNote: string;
  observedAt: number;
  source: string;
}

export interface LpAddQuoteRequest {
  poolId: string;
  amount0Desired: string;
  amount1Desired: string;
  slippageBps: number;
  /** The wallet that sends the transaction and receives the LP tokens. */
  from: string;
}

export interface LpAddQuote {
  chain: ChainId;
  protocol: string;
  poolId: string;
  /** The router the add is sent to. */
  contract: string;
  /** Amounts the router will actually pull, after ratio adjustment. */
  amount0: string;
  amount1: string;
  /** Floors the router enforces, at the requested slippage. */
  min0: string;
  min1: string;
  expectedLpTokens: string;
  minLpTokens: string;
  slippageBps: number;
  quotedAt: number;
  source: string;
  feeEstimate: { estimatedAt: number; detail: FeeDetail };
  /** Adapter-private data needed to build the transaction. Never logged. */
  routeData?: unknown;
}

export interface LpRemoveQuoteRequest {
  poolId: string;
  lpTokens: string;
  slippageBps: number;
  from: string;
}

export interface LpRemoveQuote {
  chain: ChainId;
  protocol: string;
  poolId: string;
  contract: string;
  lpTokens: string;
  expected0: string;
  expected1: string;
  min0: string;
  min1: string;
  slippageBps: number;
  quotedAt: number;
  source: string;
  feeEstimate: { estimatedAt: number; detail: FeeDetail };
  routeData?: unknown;
}

export interface LpClaimPlan {
  chain: ChainId;
  protocol: string;
  poolId: string;
  /** The pool itself. */
  contract: string;
  claimable0: string;
  claimable1: string;
  quotedAt: number;
  feeEstimate: { estimatedAt: number; detail: FeeDetail };
}

/** A transaction receipt with every ERC-20 movement relative to the wallet. */
export interface LpReceipt {
  chain: ChainId;
  hash: string;
  status: 'pending' | 'confirmed' | 'failed' | 'unknown';
  feeNative: string | null;
  height: number | null;
  error: string | null;
  /** Token address (lowercase) -> amount the wallet received in this tx. */
  received: Record<string, string>;
  /** Token address (lowercase) -> amount the wallet sent in this tx. */
  sent: Record<string, string>;
}

export type { UnsignedTransaction, SignedTransaction, SigningContext };

export interface LpAdapter {
  readonly chain: ChainId;
  readonly protocol: string;
  readonly kind: LpProtocolKind;
  /** Every contract this adapter can ever send a transaction to. */
  readonly contracts: readonly string[];
  /** Whether the protocol exposes fees to claim separately from the reserves. */
  readonly claimsFees: boolean;

  /** Read a pool. Refuses a pool the protocol factory does not recognise. */
  readPool(poolId: string): Promise<LpPoolState>;

  readPosition(owner: string, poolId: string): Promise<LpPositionState>;

  quoteAdd(request: LpAddQuoteRequest): Promise<LpAddQuote>;

  quoteRemove(request: LpRemoveQuoteRequest): Promise<LpRemoveQuote>;

  /** Gas estimate for a claim, for the fee check. */
  claimPlan(owner: string, poolId: string): Promise<LpClaimPlan>;

  /** Build the unsigned transactions. LIVE only; each targets the router or the pool. */
  buildAdd(quote: LpAddQuote): UnsignedTransaction;
  buildRemove(quote: LpRemoveQuote): UnsignedTransaction;
  buildClaim(plan: LpClaimPlan, owner: string): UnsignedTransaction;

  /** ERC-20 allowance of `token` from `owner` to the router. */
  allowance(token: string, owner: string): Promise<bigint>;
  buildApprove(token: string, owner: string, amount: bigint): UnsignedTransaction;
  approveFeeEstimate(): Promise<{ estimatedAt: number; detail: FeeDetail }>;

  prepareSigning(tx: UnsignedTransaction, from: string): Promise<SigningContext>;
  broadcast(signed: SignedTransaction): Promise<void>;
  receipt(hash: string, wallet: string): Promise<LpReceipt>;
}

/** Whether a chain has an LP adapter, and if not, why. */
export interface LpAdapterStatus {
  chain: ChainId;
  available: boolean;
  protocol: string | null;
  reason: string;
}

/** The six structured actions the Liquidity Manager may propose. */
export const LP_AGENT_ACTIONS = [
  'HOLD',
  'ADD_LIQUIDITY',
  'REMOVE_LIQUIDITY',
  'REBALANCE',
  'COLLECT_FEES',
  'EXIT',
] as const;
export type LpAgentAction = (typeof LP_AGENT_ACTIONS)[number];

/** The action vocabulary the dashboard and the lp_actions table use. */
export type LpRecordedAction = 'HOLD' | 'ADD' | 'REMOVE' | 'REBALANCE' | 'COLLECT_FEES' | 'EXIT';

export function toRecordedAction(action: LpAgentAction): LpRecordedAction {
  switch (action) {
    case 'ADD_LIQUIDITY':
      return 'ADD';
    case 'REMOVE_LIQUIDITY':
      return 'REMOVE';
    default:
      return action;
  }
}
