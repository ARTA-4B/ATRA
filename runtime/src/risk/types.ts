import { z } from 'zod';
import { CHAIN_IDS } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
import type { RiskPolicy } from './policy.js';

/**
 * Inputs and outputs of the deterministic risk engine.
 *
 * Everything the engine reads is in these structures. In particular it never
 * reads a clock, a database or the network: `now` is injected and the market
 * snapshot is assembled by the adapter layer beforehand. That is what makes a
 * decision reproducible from an audit row.
 */

export type Mode = 'PAPER' | 'LIVE';
export type ActionKind = 'swap' | 'approve' | 'lp_add' | 'lp_remove' | 'lp_rebalance' | 'lp_claim';
export type ActionSource = 'llm' | 'scheduler' | 'operator' | 'test';
export type ActivationState = 'PAPER' | 'PENDING' | 'LIVE';

export const REJECTION_CODES = [
  'SCHEMA_INVALID',
  'EMERGENCY_STOP',
  'GLOBAL_PAUSE',
  'LIVE_NOT_ACTIVATED',
  'MODE_MISMATCH',
  'CHAIN_UNSUPPORTED',
  'DATA_STALE',
  'TOKEN_NOT_ALLOWLISTED',
  'PROTOCOL_NOT_ALLOWLISTED',
  'CONTRACT_UNKNOWN',
  'REDUCE_ONLY_MISMATCH',
  'SIZE_EXCEEDS_MAX_TRADE',
  'DAILY_LOSS_BREACHED',
  'TOTAL_DEPLOYED_BREACHED',
  'SLIPPAGE_EXCEEDS_MAX',
  'FEE_EXCEEDS_MAX',
  'LIQUIDITY_BELOW_MIN',
  'COOLDOWN_ACTIVE',
  'BALANCE_INSUFFICIENT',
  'DUPLICATE_ACTION',
  'POOL_NOT_ALLOWLISTED',
  'LP_CAPITAL_EXCEEDS_MAX',
  'POOL_LIQUIDITY_BELOW_MIN',
  'REBALANCE_LIMIT_REACHED',
  'FEE_BELOW_CLAIM_THRESHOLD',
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

const amountString = z.string().regex(/^(0|[1-9]\d*)$/, 'must be a base-unit integer');
const usdString = z.string().regex(/^-?(0|[1-9]\d*)(\.\d{1,6})?$/, 'must be a USD amount');
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest');
const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Addresses must already be canonical when they reach the engine.
 *
 * The proposal builder is deterministic code; a mixed-case EVM address means
 * something upstream skipped normalization, and silently lowercasing it here
 * would hide that bug behind a passing allowlist check.
 */
const canonicalAddress = z.union([
  z.string().regex(/^0x[0-9a-f]{40}$/),
  z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
]);

export const tokenRefSchema = z.object({
  address: canonicalAddress,
  decimals: z.number().int().min(0).max(18),
});

export const evmFeeDetailSchema = z.object({
  family: z.literal('evm'),
  gasLimit: amountString,
  maxFeePerGas: amountString,
});

export const solanaFeeDetailSchema = z.object({
  family: z.literal('solana'),
  signatures: z.number().int().min(1).max(64),
  computeUnitLimit: z.number().int().min(0).max(1_400_000),
  computeUnitPriceMicroLamports: amountString,
  rentLamports: amountString,
});

export const feeDetailSchema = z.discriminatedUnion('family', [
  evmFeeDetailSchema,
  solanaFeeDetailSchema,
]);

export const quoteSchema = z.object({
  expectedAmountOut: amountString,
  minAmountOut: amountString,
  slippageBps: z.number().int().min(0).max(10_000),
  priceImpactBps: z.number().int().min(0).max(10_000),
  quotedAt: epochMs,
  source: z.string().min(1).max(64),
  marketId: z.string().min(1).max(128),
});

export const proposedActionSchema = z
  .object({
    schemaVersion: z.literal(1),
    actionId: z.uuid(),
    decisionCycleId: z.uuid(),
    idempotencyKey: sha256Hex,
    proposedAt: epochMs,
    mode: z.enum(['PAPER', 'LIVE']),
    source: z.enum(['llm', 'scheduler', 'operator', 'test']),
    chain: z.enum(CHAIN_IDS),
    kind: z.enum(['swap', 'approve', 'lp_add', 'lp_remove', 'lp_rebalance', 'lp_claim']),
    protocol: z.string().regex(/^[a-z0-9-]{2,32}$/),
    contract: canonicalAddress,
    programIds: z.array(canonicalAddress).optional(),
    reduceOnly: z.boolean(),
    tokenIn: tokenRefSchema,
    tokenOut: tokenRefSchema,
    amountIn: amountString,
    quote: quoteSchema.nullable(),
    feeEstimate: z.object({ estimatedAt: epochMs, detail: feeDetailSchema }),
    lp: z
      .object({
        poolId: z.string().min(1).max(128),
        capitalUsd: usdString,
        rebalanceIndexToday: z.number().int().min(0),
        claimableFeesUsd: usdString,
      })
      .optional(),
    rationale: z.string().max(2_000).optional(),
  })
  .superRefine((action, ctx) => {
    if (action.amountIn === '0') {
      ctx.addIssue({ code: 'custom', path: ['amountIn'], message: 'must be greater than zero' });
    }

    if (action.kind === 'approve') {
      if (action.quote !== null) {
        ctx.addIssue({ code: 'custom', path: ['quote'], message: 'approve must not carry a quote' });
      }
      if (action.tokenIn.address !== action.tokenOut.address) {
        ctx.addIssue({
          code: 'custom',
          path: ['tokenOut'],
          message: 'approve must reference a single token',
        });
      }
    } else {
      if (action.quote === null) {
        ctx.addIssue({ code: 'custom', path: ['quote'], message: 'a quote is required' });
      }
      if (action.tokenIn.address === action.tokenOut.address) {
        ctx.addIssue({
          code: 'custom',
          path: ['tokenOut'],
          message: 'tokenIn and tokenOut must differ',
        });
      }
    }

    if (action.quote) {
      const expected = BigInt(action.quote.expectedAmountOut);
      const minimum = BigInt(action.quote.minAmountOut);
      if (expected === 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['quote', 'expectedAmountOut'],
          message: 'must be greater than zero',
        });
      }
      if (minimum > expected) {
        ctx.addIssue({
          code: 'custom',
          path: ['quote', 'minAmountOut'],
          message: 'must not exceed expectedAmountOut',
        });
      }
    }

    const isSolana = action.chain === 'solana';
    if (isSolana && action.programIds === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['programIds'],
        message: 'Solana actions must list every top-level program id',
      });
    }
    if (!isSolana && action.programIds !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['programIds'],
        message: 'programIds is Solana-only',
      });
    }

    const feeFamily = action.feeEstimate.detail.family;
    if (isSolana !== (feeFamily === 'solana')) {
      ctx.addIssue({
        code: 'custom',
        path: ['feeEstimate', 'detail', 'family'],
        message: `fee detail family ${feeFamily} does not match chain ${action.chain}`,
      });
    }
  });

export type ProposedAction = z.infer<typeof proposedActionSchema>;
export type FeeDetail = z.infer<typeof feeDetailSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type TokenRef = z.infer<typeof tokenRefSchema>;

export interface Position {
  chain: ChainId;
  token: string;
  amount: string;
  costBasisUsd: string;
  openedAt: number;
}

export interface Ledger {
  dayStartUtcMs: number;
  deployedUsd: string;
  realizedPnlTodayUsd: string;
  unrealizedPnlUsd: string;
  unrealizedPnlAtDayStartUsd: string;
  positions: Position[];
  lpRebalancesToday: Record<string, number>;
}

export interface RuntimeState {
  mode: Mode;
  emergencyStop: {
    active: boolean;
    since: number | null;
    reason: string | null;
    source: 'api' | 'file' | 'telegram' | 'cli' | 'policy' | null;
  };
  globalPause: boolean;
  activation: {
    state: ActivationState;
    liveSession: { startedAt: number; expiresAt: number } | null;
  };
  cooldowns: Record<string, number>;
  lastAnyActionAt: number | null;
  ledger: Ledger;
}

export interface Stamped<T> {
  value: T;
  at: number;
  source: string;
}

export interface MarketSnapshot {
  prices: Record<string, Stamped<string>>;
  liquidity: Record<string, Stamped<string>>;
  balances: Record<string, Stamped<string>>;
  poolLiquidity?: Record<string, Stamped<string>>;
}

export interface RiskInput {
  now: number;
  policy: RiskPolicy;
  policyHash: string;
  action: ProposedAction;
  state: RuntimeState;
  snapshot: MarketSnapshot;
}

export interface RiskCheck {
  name: string;
  code: RejectionCode;
  passed: boolean;
  /** Always a string so an audit row never has to guess at a type. */
  observed: string;
  limit: string;
  skipped?: 'not-applicable' | 'short-circuit';
  detail?: string;
}

export interface RiskDerived {
  amountInUsd: string;
  feeUsd: string;
  impliedSlippageBps: number;
  dailyLossUsd: string;
  projectedDeployedUsd: string;
}

export interface RiskDecision {
  schemaVersion: 1;
  engineVersion: string;
  actionId: string;
  idempotencyKey: string;
  mode: Mode;
  evaluatedAt: number;
  policyHash: string;
  allowed: boolean;
  code: 'OK' | RejectionCode;
  reason: string;
  checks: RiskCheck[];
  derived: RiskDerived | null;
  replayOf?: string;
}

/** Key used for per-market cooldowns; order-independent so A/B equals B/A. */
export function marketKey(chain: ChainId, a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a];
  return `${chain}:${first}:${second}`;
}

export function priceKey(chain: ChainId, token: string): string {
  return `${chain}:${token}`;
}

export function balanceKey(chain: ChainId, token: string): string {
  return `${chain}:${token}`;
}

export function liquidityKey(chain: ChainId, market: string): string {
  return `${chain}:${market}`;
}

export type { ChainId };
