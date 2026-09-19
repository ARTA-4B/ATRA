import { randomUUID } from 'node:crypto';
import { defaultRiskPolicy, policyHash } from '../../src/risk/policy.js';
import type { RiskPolicy } from '../../src/risk/policy.js';
import { deriveIdempotencyKey } from '../../src/risk/engine.js';
import type {
  MarketSnapshot,
  ProposedAction,
  RiskInput,
  RuntimeState,
} from '../../src/risk/types.js';

/**
 * Fixtures for the risk-engine tests.
 *
 * `now` is a fixed instant (2026-09-19T14:30:00Z) rather than Date.now(), so
 * every freshness assertion is deterministic and a test cannot pass or fail
 * depending on when it runs.
 */
export const NOW = 1_789_828_200_000;
export const DAY_START = Math.floor(NOW / 86_400_000) * 86_400_000;

export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BASE_WETH = '0x4200000000000000000000000000000000000006';
export const BASE_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const UNIVERSAL_ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43';
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

export const SOL_NATIVE = 'So11111111111111111111111111111111111111112';
export const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

export function makePolicy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  return { ...defaultRiskPolicy(), ...overrides };
}

/** A swap of 10 USDC into WETH on Base that passes every check by default. */
export function makeAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  const base: ProposedAction = {
    schemaVersion: 1,
    actionId: randomUUID(),
    decisionCycleId: '0192f3a0-6b1e-7c2d-9a4b-1c2d3e4f5a6b',
    idempotencyKey: '0'.repeat(64),
    proposedAt: NOW - 1_000,
    mode: 'PAPER',
    source: 'test',
    chain: 'base',
    kind: 'swap',
    protocol: 'uniswap-v4',
    contract: UNIVERSAL_ROUTER,
    reduceOnly: false,
    tokenIn: { address: BASE_USDC, decimals: 6 },
    tokenOut: { address: BASE_WETH, decimals: 18 },
    amountIn: '10000000',
    quote: {
      expectedAmountOut: '3999800000000000',
      minAmountOut: '3987800600000000',
      slippageBps: 30,
      priceImpactBps: 5,
      quotedAt: NOW - 2_000,
      source: 'uniswap-v4-quoter',
      marketId: '0xpool',
    },
    feeEstimate: {
      estimatedAt: NOW - 1_500,
      detail: { family: 'evm', gasLimit: '250000', maxFeePerGas: '10000000' },
    },
    ...overrides,
  };

  // Keep the key consistent unless a test is deliberately corrupting it.
  return overrides.idempotencyKey ? base : { ...base, idempotencyKey: deriveIdempotencyKey(base) };
}

export function makeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    mode: 'PAPER',
    emergencyStop: { active: false, since: null, reason: null, source: null },
    globalPause: false,
    activation: { state: 'PAPER', liveSession: null },
    cooldowns: {},
    lastAnyActionAt: null,
    ledger: {
      dayStartUtcMs: DAY_START,
      deployedUsd: '0',
      realizedPnlTodayUsd: '0',
      unrealizedPnlUsd: '0',
      unrealizedPnlAtDayStartUsd: '0',
      positions: [],
      lpRebalancesToday: {},
    },
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const fresh = NOW - 5_000;
  return {
    prices: {
      [`base:${BASE_USDC}`]: { value: '1.000027', at: fresh, source: 'dexscreener' },
      [`base:${BASE_WETH}`]: { value: '2500.123456', at: fresh, source: 'dexscreener' },
      [`base:${BASE_NATIVE}`]: { value: '2500.123456', at: fresh, source: 'dexscreener' },
      [`solana:${SOL_USDC}`]: { value: '1.000027', at: fresh, source: 'dexscreener' },
      [`solana:${SOL_NATIVE}`]: { value: '111.790298', at: fresh, source: 'dexscreener' },
    },
    liquidity: {
      'base:0xpool': { value: '5000000', at: fresh, source: 'dexscreener' },
      'solana:pool': { value: '5000000', at: fresh, source: 'dexscreener' },
    },
    balances: {
      [`base:${BASE_USDC}`]: { value: '100000000', at: fresh, source: 'rpc' },
      [`base:${BASE_WETH}`]: { value: '0', at: fresh, source: 'rpc' },
      [`base:${BASE_NATIVE}`]: { value: '50000000000000000', at: fresh, source: 'rpc' },
      [`solana:${SOL_USDC}`]: { value: '100000000', at: fresh, source: 'rpc' },
      [`solana:${SOL_NATIVE}`]: { value: '1000000000', at: fresh, source: 'rpc' },
    },
    ...overrides,
  };
}

export function makeInput(overrides: Partial<RiskInput> = {}): RiskInput {
  const policy = overrides.policy ?? makePolicy();
  return {
    now: NOW,
    policy,
    policyHash: policyHash(policy),
    action: makeAction(),
    state: makeState(),
    snapshot: makeSnapshot(),
    ...overrides,
  };
}

/** A Solana swap that passes every check by default. */
export function makeSolanaAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return makeAction({
    chain: 'solana',
    protocol: 'jupiter-v6',
    contract: JUPITER_V6,
    programIds: [JUPITER_V6, '11111111111111111111111111111111'],
    tokenIn: { address: SOL_USDC, decimals: 6 },
    tokenOut: { address: SOL_NATIVE, decimals: 9 },
    amountIn: '10000000',
    quote: {
      expectedAmountOut: '89000000',
      minAmountOut: '88555000',
      slippageBps: 50,
      priceImpactBps: 5,
      quotedAt: NOW - 2_000,
      source: 'jupiter-lite-v1',
      marketId: 'pool',
    },
    feeEstimate: {
      estimatedAt: NOW - 1_500,
      detail: {
        family: 'solana',
        signatures: 1,
        computeUnitLimit: 200_000,
        computeUnitPriceMicroLamports: '500',
        rentLamports: '0',
      },
    },
    ...overrides,
  });
}
