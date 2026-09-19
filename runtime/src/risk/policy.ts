import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CHAIN_IDS, CHAINS, DEFAULT_PROTOCOLS } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
import { AppError, ErrorCode } from '../util/errors.js';
import type { FieldIssue } from '../util/errors.js';

/**
 * The risk policy: the operator's hard limits.
 *
 * This is the contract between the human and the agent. The reasoning model can
 * read it and can be asked to respect it, but it is enforced entirely by
 * {@link ../risk/engine.ts}, which never calls a model. A policy that fails
 * validation is never loaded: the runtime refuses to leave PAPER mode rather
 * than fall back to something permissive.
 */

const usdString = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/, 'must be a non-negative amount with up to 6 decimals');

const evmAddress = z.string().regex(/^0x[0-9a-f]{40}$/, 'must be a lowercase 0x address');
const solanaPubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58 pubkey');
const tokenAddress = z.union([evmAddress, solanaPubkey]);
const protocolKey = z.string().regex(/^[a-z0-9-]{2,32}$/, 'must be a lowercase protocol key');

export const tokenAllowEntrySchema = z.object({
  address: tokenAddress,
  symbol: z.string().regex(/^[A-Za-z0-9.$_-]{1,16}$/),
  decimals: z.number().int().min(0).max(18),
});

export const protocolAllowEntrySchema = z.object({
  contracts: z.array(tokenAddress).min(1),
  /** EVM only. An empty list means approvals to this protocol are forbidden. */
  approveSpenders: z.array(tokenAddress).default([]),
});

export const freshnessSchema = z.object({
  priceMaxAgeMs: z.number().int().min(1_000).max(3_600_000),
  quoteMaxAgeMs: z.number().int().min(1_000).max(600_000),
  balanceMaxAgeMs: z.number().int().min(1_000).max(3_600_000),
  liquidityMaxAgeMs: z.number().int().min(1_000).max(86_400_000),
  feeEstimateMaxAgeMs: z.number().int().min(1_000).max(600_000),
  actionMaxAgeMs: z.number().int().min(1_000).max(600_000),
  maxClockSkewMs: z.number().int().min(0).max(60_000),
});

export const lpPolicySchema = z.object({
  maxCapitalPerLpUsd: usdString,
  allowedPools: z.array(
    z.object({ chain: z.enum(CHAIN_IDS), protocol: protocolKey, poolId: z.string().min(1) }),
  ),
  allowedProtocols: z.partialRecord(z.enum(CHAIN_IDS), z.array(protocolKey)),
  minPoolLiquidityUsd: usdString,
  maxRebalancePerDay: z.number().int().min(0).max(48),
  maxRebalanceSlippageBps: z.number().int().min(1).max(500),
  maxLpGasUsd: usdString,
  minFeeThresholdUsd: usdString,
});

export const riskPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    enabledChains: z.array(z.enum(CHAIN_IDS)).min(1),

    maxAmountPerTradeUsd: usdString,
    maxDailyLossUsd: usdString,
    maxTotalDeployedUsd: usdString,
    maxTransactionFeeUsd: usdString,
    minLiquidityUsd: usdString,

    maxSlippageBps: z.number().int().min(1).max(1_000),
    maxPriceImpactBps: z.number().int().min(1).max(2_000),

    cooldownSeconds: z.number().int().min(0).max(86_400),
    globalMinIntervalSeconds: z.number().int().min(0).max(3_600),

    freshness: freshnessSchema,
    dailyLoss: z.object({ includeUnrealized: z.boolean() }),

    tokenAllowlist: z.partialRecord(z.enum(CHAIN_IDS), z.array(tokenAllowEntrySchema)),
    protocolAllowlist: z.partialRecord(
      z.enum(CHAIN_IDS),
      z.record(protocolKey, protocolAllowEntrySchema),
    ),

    globalPause: z.boolean(),
    emergencyStop: z.boolean(),

    lp: lpPolicySchema,
  })
  .superRefine((policy, ctx) => {
    // A positive per-trade cap that exceeds the total deployment cap can never
    // be satisfied and usually means the operator mixed up two fields.
    if (bigUsd(policy.maxAmountPerTradeUsd) > bigUsd(policy.maxTotalDeployedUsd)) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxAmountPerTradeUsd'],
        message: 'must not exceed maxTotalDeployedUsd',
      });
    }
    if (bigUsd(policy.maxAmountPerTradeUsd) === 0n) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxAmountPerTradeUsd'],
        message: 'must be greater than zero',
      });
    }
    if (bigUsd(policy.maxDailyLossUsd) === 0n) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxDailyLossUsd'],
        message: 'must be greater than zero',
      });
    }
    if (bigUsd(policy.maxTransactionFeeUsd) === 0n) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxTransactionFeeUsd'],
        message: 'must be greater than zero',
      });
    }

    // An allowlist entry for a chain that is not enabled is dead weight that
    // becomes live the moment the chain is switched on, so it is rejected.
    for (const chain of Object.keys(policy.tokenAllowlist) as ChainId[]) {
      if (!policy.enabledChains.includes(chain)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tokenAllowlist', chain],
          message: `chain ${chain} is not in enabledChains`,
        });
      }
    }
    for (const chain of Object.keys(policy.protocolAllowlist) as ChainId[]) {
      if (!policy.enabledChains.includes(chain)) {
        ctx.addIssue({
          code: 'custom',
          path: ['protocolAllowlist', chain],
          message: `chain ${chain} is not in enabledChains`,
        });
      }
    }

    // Addresses must belong to the family of the chain they are listed under,
    // and decimals must be plausible for that family.
    for (const [chain, entries] of Object.entries(policy.tokenAllowlist)) {
      const info = CHAINS[chain as ChainId];
      for (const [index, entry] of (entries ?? []).entries()) {
        const looksEvm = entry.address.startsWith('0x');
        if (info.family === 'evm' && !looksEvm) {
          ctx.addIssue({
            code: 'custom',
            path: ['tokenAllowlist', chain, index, 'address'],
            message: 'expected a 0x address on an EVM chain',
          });
        }
        if (info.family === 'solana' && looksEvm) {
          ctx.addIssue({
            code: 'custom',
            path: ['tokenAllowlist', chain, index, 'address'],
            message: 'expected a base58 mint on Solana',
          });
        }
        if (info.family === 'solana' && entry.decimals > 9) {
          ctx.addIssue({
            code: 'custom',
            path: ['tokenAllowlist', chain, index, 'decimals'],
            message: 'Solana mints have at most 9 decimals',
          });
        }
      }
    }

    // approveSpenders must be a subset of contracts: an approval to an address
    // the router itself never uses is an exfiltration path.
    for (const [chain, protocols] of Object.entries(policy.protocolAllowlist)) {
      for (const [key, entry] of Object.entries(protocols ?? {})) {
        for (const spender of entry.approveSpenders) {
          if (!entry.contracts.includes(spender)) {
            ctx.addIssue({
              code: 'custom',
              path: ['protocolAllowlist', chain, key, 'approveSpenders'],
              message: `${spender} is not in contracts`,
            });
          }
        }
      }
    }
  });

export type RiskPolicy = z.infer<typeof riskPolicySchema>;
export type TokenAllowEntry = z.infer<typeof tokenAllowEntrySchema>;
export type ProtocolAllowEntry = z.infer<typeof protocolAllowEntrySchema>;

function bigUsd(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
}

/**
 * Validate a candidate policy.
 *
 * Throws with every issue at once so the dashboard can highlight all offending
 * fields in a single pass rather than making the operator fix them one by one.
 */
export function parseRiskPolicy(input: unknown): RiskPolicy {
  const result = riskPolicySchema.safeParse(input);
  if (!result.success) {
    const errors: FieldIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Risk policy is not valid', { errors });
  }
  return result.data;
}

/**
 * A stable hash of the policy, recorded on every risk decision.
 *
 * Makes an audit trail answer "which limits were in force when this was
 * allowed?" without copying the whole policy into every row.
 */
export function policyHash(policy: RiskPolicy): string {
  return createHash('sha256').update(canonicalJson(policy)).digest('hex');
}

/** Deterministic JSON: keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortKeys(item)]));
  }
  return value;
}

/**
 * The policy a fresh install starts with.
 *
 * Deliberately small numbers. A first-time operator should discover ATRA's
 * limits by hitting them in PAPER mode, not by losing money in LIVE mode. The
 * same figures apply in both modes so paper results stay representative.
 */
export function defaultRiskPolicy(enabledChains: ChainId[] = [...CHAIN_IDS]): RiskPolicy {
  const tokenAllowlist: Partial<Record<ChainId, TokenAllowEntry[]>> = {};
  const protocolAllowlist: Partial<Record<ChainId, Record<string, ProtocolAllowEntry>>> = {};

  for (const chain of enabledChains) {
    tokenAllowlist[chain] = CHAINS[chain].tokens.map((token) => ({
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
    }));
    protocolAllowlist[chain] = Object.fromEntries(
      Object.entries(DEFAULT_PROTOCOLS[chain]).map(([key, entry]) => [
        key,
        { contracts: [...entry.contracts], approveSpenders: [...entry.approveSpenders] },
      ]),
    );
  }

  return riskPolicySchema.parse({
    schemaVersion: 1,
    enabledChains,

    maxAmountPerTradeUsd: '25',
    maxDailyLossUsd: '50',
    maxTotalDeployedUsd: '250',
    maxTransactionFeeUsd: '2',
    minLiquidityUsd: '250000',

    maxSlippageBps: 50,
    maxPriceImpactBps: 100,

    cooldownSeconds: 900,
    globalMinIntervalSeconds: 60,

    freshness: {
      priceMaxAgeMs: 60_000,
      quoteMaxAgeMs: 30_000,
      balanceMaxAgeMs: 120_000,
      liquidityMaxAgeMs: 900_000,
      feeEstimateMaxAgeMs: 60_000,
      actionMaxAgeMs: 120_000,
      maxClockSkewMs: 5_000,
    },
    dailyLoss: { includeUnrealized: true },

    tokenAllowlist,
    protocolAllowlist,

    globalPause: false,
    emergencyStop: false,

    lp: {
      // LP automation is off until the operator opts in: "0" and an empty pool
      // list both disable it, and Phase 4 requires both to be set.
      maxCapitalPerLpUsd: '0',
      allowedPools: [],
      allowedProtocols: {},
      minPoolLiquidityUsd: '500000',
      maxRebalancePerDay: 4,
      maxRebalanceSlippageBps: 50,
      maxLpGasUsd: '2',
      minFeeThresholdUsd: '5',
    },
  });
}
