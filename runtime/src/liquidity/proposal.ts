import { randomUUID } from 'node:crypto';
import type { ChainId } from '../chains/registry.js';
import { CHAINS, isNativeToken } from '../chains/registry.js';
import type { LedgerService, PriceLookup } from '../trading/ledger.js';
import type { TradeSide } from '../trading/trades.js';
import type { WalletService } from '../wallet/service.js';
import type { RiskPolicy } from '../risk/policy.js';
import type {
  ActionSource,
  LpSnapshot,
  MarketSnapshot,
  Mode,
  ProposedAction,
  Stamped,
} from '../risk/types.js';
import {
  balanceKey,
  liquidityKey,
  lpPoolKey,
  priceKey,
  proposedActionSchema,
} from '../risk/types.js';
import { deriveIdempotencyKey } from '../risk/engine.js';
import {
  PRICE_SCALE,
  USD_SCALE,
  amountToBigint,
  microsToUsd,
  nativeToUsdMicros,
  priceToAtto,
  usdToMicros,
} from '../risk/money.js';
import { usdToTokenUnits } from '../trading/proposal.js';
import type { LpDecision } from '../agents/liquidity-manager/agent.js';
import { childLogger } from '../logging/logger.js';
import { errorMessage } from '../util/errors.js';
import type { LiquidityStore } from './store.js';
import type {
  LpAdapter,
  LpAddQuote,
  LpClaimPlan,
  LpPoolState,
  LpPositionState,
  LpRecordedAction,
  LpRemoveQuote,
} from './types.js';

/**
 * The LP proposal builder.
 *
 * Takes the Liquidity Manager's decision — an action and, for an add, a USD
 * size — and turns it into the fully specified action the risk engine
 * evaluates: exact base-unit amounts for both pool assets, a quote from the
 * adapter with the floors the router will enforce, the fee estimate, and a
 * snapshot whose every entry is dated and attributed, including the pool's
 * TVL and the LP ledger slice.
 *
 * Everything here is deterministic code. The model chose *what*; this decides
 * *how much of which asset through which contract*, and the engine decides
 * *whether*. Neither the model nor this file can skip the engine.
 *
 * Two deliberate refusals:
 *  - an add into a volatile pool whose own price disagrees with the
 *    cross-checked market price by more than the LP slippage limit: either a
 *    price feed is stale or the pool is mid-arbitrage, and either way adding
 *    liquidity at that moment is a loss the operator did not ask for;
 *  - a `REBALANCE` on a v2 pool, which has no range to move.
 */

export type LpPlan =
  | { kind: 'add'; quote: LpAddQuote }
  | { kind: 'remove'; quote: LpRemoveQuote; closes: boolean }
  | { kind: 'claim'; plan: LpClaimPlan };

export interface LpProposalRequest {
  chain: ChainId;
  mode: Mode;
  decisionCycleId: string;
  source: ActionSource;
  walletAddress: string;
  decision: LpDecision;
  policy: RiskPolicy;
  adapter: LpAdapter;
  pool: LpPoolState;
  /** The chain's (LIVE) or the ledger's (PAPER) view of the position. */
  position: LpPositionState | null;
  prices: PriceMap;
}

/** Cross-checked USD prices keyed by token address. */
export type PriceMap = Map<string, Stamped<string>>;

export interface BuiltLpProposal {
  action: ProposedAction;
  plan: LpPlan;
  snapshot: MarketSnapshot;
  priceLookup: PriceLookup;
  prices: { token0Usd: string; token1Usd: string; nativeUsd: string };
  side: TradeSide;
  recorded: LpRecordedAction;
  notes: string[];
}

export type LpBuildResult =
  { ok: true; proposal: BuiltLpProposal } | { ok: false; reason: string; notes: string[] };

export interface LpProposalBuilderDeps {
  ledger: LedgerService;
  wallets: WalletService;
  store: LiquidityStore;
  now?: () => number;
}

export class LpProposalBuilder {
  readonly #ledger: LedgerService;
  readonly #wallets: WalletService;
  readonly #store: LiquidityStore;
  readonly #now: () => number;
  readonly #log = childLogger('lp-proposal');

  constructor(deps: LpProposalBuilderDeps) {
    this.#ledger = deps.ledger;
    this.#wallets = deps.wallets;
    this.#store = deps.store;
    this.#now = deps.now ?? (() => Date.now());
  }

  async build(request: LpProposalRequest): Promise<LpBuildResult> {
    const notes: string[] = [];
    const { chain, decision, policy, pool, adapter } = request;

    if (decision.action === 'HOLD') {
      return { ok: false, reason: 'nothing to build for HOLD', notes };
    }

    const native = CHAINS[chain].tokens.find((token) => isNativeToken(chain, token.address))!;
    const price0 = request.prices.get(pool.token0.address);
    const price1 = request.prices.get(pool.token1.address);
    const priceNative = request.prices.get(native.address);
    for (const [label, entry] of [
      ['token0', price0],
      ['token1', price1],
      ['native', priceNative],
    ] as const) {
      if (!entry) return { ok: false, reason: `no reliable USD price for ${label}`, notes };
      notes.push(`${label} price ${entry.value} USD via ${entry.source}`);
    }
    const atto0 = priceToAtto(price0!.value);
    const atto1 = priceToAtto(price1!.value);
    if (atto0 <= 0n || atto1 <= 0n) {
      return { ok: false, reason: 'a pool asset has a zero price', notes };
    }

    const tvl = poolTvlMicros(pool, atto0, atto1);
    notes.push(`pool TVL ${microsToUsd(tvl)} USD from reserves at cross-checked prices`);

    let plan: LpPlan;
    let candidate: ProposedAction;
    let side: TradeSide;
    let recorded: LpRecordedAction;
    const token0 = { address: pool.token0.address, decimals: pool.token0.decimals };
    const token1 = { address: pool.token1.address, decimals: pool.token1.decimals };
    const rebalancesToday = this.#store.rebalancesToday(request.mode, chain, pool.poolId);
    const base = {
      schemaVersion: 1 as const,
      actionId: randomUUID(),
      decisionCycleId: request.decisionCycleId,
      idempotencyKey: '0'.repeat(64),
      proposedAt: this.#now(),
      mode: request.mode,
      source: request.source,
      chain,
      protocol: adapter.protocol,
      reduceOnly: false,
      tokenIn: token0,
      tokenOut: token1,
      rationale: decision.reason.slice(0, 2_000),
    };

    switch (decision.action) {
      case 'ADD_LIQUIDITY': {
        if (pool.kind === 'v2' && !pool.stable) {
          const deviation = reserveValueDeviationBps(pool, atto0, atto1);
          notes.push(`pool price deviates from market by ${deviation.toString()} bps`);
          if (deviation > BigInt(policy.lp.maxRebalanceSlippageBps)) {
            return {
              ok: false,
              reason: `pool price deviates from the cross-checked market price by ${deviation.toString()} bps (limit ${String(policy.lp.maxRebalanceSlippageBps)}); not adding into a mispriced pool`,
              notes,
            };
          }
        } else if (pool.stable) {
          notes.push('stable pool: reserve-value deviation check not applicable');
        }

        const capital = usdToMicros(decision.capitalUsd);
        const half = capital / 2n;
        const desired0 = usdToTokenUnits(half, pool.token0.decimals, atto0);
        const desired1 = usdToTokenUnits(capital - half, pool.token1.decimals, atto1);
        if (desired0 <= 0n || desired1 <= 0n) {
          return { ok: false, reason: 'requested capital rounds to zero base units', notes };
        }

        let quote: LpAddQuote;
        try {
          quote = await adapter.quoteAdd({
            poolId: pool.poolId,
            amount0Desired: desired0.toString(),
            amount1Desired: desired1.toString(),
            slippageBps: policy.lp.maxRebalanceSlippageBps,
            from: request.walletAddress,
          });
        } catch (error) {
          return { ok: false, reason: `add quote failed: ${errorMessage(error)}`, notes };
        }
        const committed =
          nativeToUsdMicros(amountToBigint(quote.amount0), token0.decimals, atto0, 'ceil') +
          nativeToUsdMicros(amountToBigint(quote.amount1), token1.decimals, atto1, 'ceil');
        notes.push(
          `add quote ${quote.source}: ${quote.amount0}/${quote.amount1} -> ${quote.expectedLpTokens} LP (min ${quote.minLpTokens}), capital ${microsToUsd(committed)} USD`,
        );

        plan = { kind: 'add', quote };
        side = 'open';
        recorded = 'ADD';
        candidate = {
          ...base,
          kind: 'lp_add',
          contract: quote.contract,
          amountIn: quote.amount0,
          quote: {
            expectedAmountOut: quote.expectedLpTokens,
            minAmountOut: quote.minLpTokens,
            slippageBps: quote.slippageBps,
            priceImpactBps: 0,
            quotedAt: quote.quotedAt,
            source: quote.source,
            marketId: pool.poolId,
          },
          feeEstimate: quote.feeEstimate,
          lp: {
            poolId: pool.poolId,
            capitalUsd: microsToUsd(committed),
            rebalanceIndexToday: rebalancesToday,
            claimableFeesUsd: '0',
            amountB: quote.amount1,
            minAmountA: quote.min0,
            minAmountB: quote.min1,
          },
        };
        break;
      }

      case 'REMOVE_LIQUIDITY':
      case 'EXIT': {
        const held = request.position ? amountToBigint(request.position.lpTokens) : 0n;
        if (held <= 0n) {
          return { ok: false, reason: `${decision.action} without an open position`, notes };
        }
        const closes = decision.action === 'EXIT' || held / 2n === 0n;
        const lpTokens = closes ? held : held / 2n;

        let quote: LpRemoveQuote;
        try {
          quote = await adapter.quoteRemove({
            poolId: pool.poolId,
            lpTokens: lpTokens.toString(),
            slippageBps: policy.lp.maxRebalanceSlippageBps,
            from: request.walletAddress,
          });
        } catch (error) {
          return { ok: false, reason: `remove quote failed: ${errorMessage(error)}`, notes };
        }
        if (amountToBigint(quote.expected0) <= 0n || amountToBigint(quote.expected1) <= 0n) {
          return {
            ok: false,
            reason: 'the position is dust: removal returns zero of an asset',
            notes,
          };
        }
        notes.push(
          `remove quote ${quote.source}: ${quote.lpTokens} LP -> ${quote.expected0}/${quote.expected1} (min ${quote.min0}/${quote.min1})`,
        );

        const stored = this.#store.getPosition(request.mode, chain, adapter.protocol, pool.poolId);
        plan = { kind: 'remove', quote, closes };
        side = closes ? 'close' : 'reduce';
        recorded = closes ? 'EXIT' : 'REMOVE';
        candidate = {
          ...base,
          kind: 'lp_remove',
          contract: quote.contract,
          amountIn: quote.expected0,
          quote: {
            expectedAmountOut: quote.expected1,
            minAmountOut: quote.min1,
            slippageBps: quote.slippageBps,
            priceImpactBps: 0,
            quotedAt: quote.quotedAt,
            source: quote.source,
            marketId: pool.poolId,
          },
          feeEstimate: quote.feeEstimate,
          lp: {
            poolId: pool.poolId,
            capitalUsd: stored?.capitalUsd ?? '0',
            rebalanceIndexToday: rebalancesToday,
            claimableFeesUsd: '0',
            lpTokens: quote.lpTokens,
            minAmountA: quote.min0,
            minAmountB: quote.min1,
          },
        };
        break;
      }

      case 'COLLECT_FEES': {
        if (request.mode === 'PAPER') {
          return {
            ok: false,
            reason: 'fee accrual is not simulated in PAPER; there is nothing to claim',
            notes,
          };
        }
        if (!adapter.claimsFees) {
          return {
            ok: false,
            reason: `${adapter.protocol} fees compound into the reserves; there is nothing to claim`,
            notes,
          };
        }
        let claim: LpClaimPlan;
        try {
          claim = await adapter.claimPlan(request.walletAddress, pool.poolId);
        } catch (error) {
          return { ok: false, reason: `claim plan failed: ${errorMessage(error)}`, notes };
        }
        const claimableUsd =
          nativeToUsdMicros(amountToBigint(claim.claimable0), token0.decimals, atto0, 'floor') +
          nativeToUsdMicros(amountToBigint(claim.claimable1), token1.decimals, atto1, 'floor');
        notes.push(
          `claimable ${claim.claimable0}/${claim.claimable1} worth ${microsToUsd(claimableUsd)} USD`,
        );
        const stored = this.#store.getPosition(request.mode, chain, adapter.protocol, pool.poolId);
        plan = { kind: 'claim', plan: claim };
        side = 'reduce';
        recorded = 'COLLECT_FEES';
        candidate = {
          ...base,
          kind: 'lp_claim',
          contract: claim.contract,
          amountIn: '0',
          quote: null,
          feeEstimate: claim.feeEstimate,
          lp: {
            poolId: pool.poolId,
            capitalUsd: stored?.capitalUsd ?? '0',
            rebalanceIndexToday: rebalancesToday,
            claimableFeesUsd: microsToUsd(claimableUsd),
            claimable: { amountA: claim.claimable0, amountB: claim.claimable1 },
          },
        };
        break;
      }

      case 'REBALANCE':
        return {
          ok: false,
          reason: `REBALANCE is not applicable to a ${pool.kind} pool: it has no price range`,
          notes,
        };

      default:
        return { ok: false, reason: `unsupported action ${String(decision.action)}`, notes };
    }

    candidate.idempotencyKey = deriveIdempotencyKey(candidate);
    const parsed = proposedActionSchema.safeParse(candidate);
    if (!parsed.success) {
      // The builder produced something the engine's schema refuses. That is a
      // bug here, not a market condition, and it is reported as such.
      const issue = parsed.error.issues[0];
      this.#log.error({ issue }, 'built an invalid LP proposal');
      return {
        ok: false,
        reason: `internal: proposal failed schema (${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'})`,
        notes,
      };
    }

    // --- snapshot --------------------------------------------------------------
    const balances = await this.#balances(request, [
      token0.address,
      token1.address,
      native.address,
    ]);
    // The pool's LP token: priced from its share of the reserves, held per the
    // position reading. Needed by the LP-token approval ahead of a removal.
    const lpPriceAtto = lpTokenPriceAtto(pool, tvl);
    const lpTokenPrice: Stamped<string> = {
      value: attoToPrice(lpPriceAtto),
      at: pool.observedAt,
      source: 'derived:reserves+prices',
    };
    const lpBalance: Stamped<string> = {
      value: request.position?.lpTokens ?? '0',
      at: request.position?.observedAt ?? this.#now(),
      source: request.position?.source ?? 'none',
    };

    const lpState = this.#lpSnapshot(request, adapter.protocol);
    const snapshot: MarketSnapshot = {
      prices: {
        [priceKey(chain, token0.address)]: price0!,
        [priceKey(chain, token1.address)]: price1!,
        [priceKey(chain, native.address)]: priceNative!,
        [priceKey(chain, pool.poolId)]: lpTokenPrice,
      },
      liquidity: {},
      balances: { ...balances, [balanceKey(chain, pool.poolId)]: lpBalance },
      poolLiquidity: {
        [liquidityKey(chain, pool.poolId)]: {
          value: microsToUsd(tvl),
          at: pool.observedAt,
          source: 'derived:reserves+prices',
        },
      },
      lp: lpState,
    };

    const priced = new Map(request.prices);
    priced.set(pool.poolId, lpTokenPrice);
    const priceLookup: PriceLookup = (lookupChain, token) =>
      lookupChain === chain ? (priced.get(token)?.value ?? null) : null;

    return {
      ok: true,
      proposal: {
        action: parsed.data,
        plan,
        snapshot,
        priceLookup,
        prices: {
          token0Usd: price0!.value,
          token1Usd: price1!.value,
          nativeUsd: priceNative!.value,
        },
        side,
        recorded,
        notes,
      },
    };
  }

  /**
   * The LP ledger slice. In LIVE the LP-token balance the chain reports
   * overrides the booked one: the chain is the truth about what the wallet
   * holds, the ledger is the truth about what was paid for it.
   */
  #lpSnapshot(request: LpProposalRequest, protocol: string): LpSnapshot {
    const state = this.#store.toRiskSnapshot(request.mode, this.#now());
    if (request.mode === 'LIVE' && request.position) {
      const key = lpPoolKey(request.chain, request.pool.poolId);
      const stored = this.#store.getPosition(
        request.mode,
        request.chain,
        protocol,
        request.pool.poolId,
      );
      if (amountToBigint(request.position.lpTokens) > 0n) {
        state.positions[key] = {
          lpTokens: request.position.lpTokens,
          capitalUsd: stored?.capitalUsd ?? '0',
        };
      } else {
        delete state.positions[key];
      }
    }
    return state;
  }

  /** Balances for the mode: the paper ledger in PAPER, the chain in LIVE. */
  async #balances(
    request: LpProposalRequest,
    tokens: string[],
  ): Promise<Record<string, Stamped<string>>> {
    const { chain } = request;
    const out: Record<string, Stamped<string>> = {};

    if (request.mode === 'PAPER') {
      const now = this.#now();
      for (const token of tokens) {
        const paper = this.#ledger.getPaperBalance(chain, token);
        out[balanceKey(chain, token)] = {
          value: paper?.amount ?? '0',
          at: now,
          source: 'paper-ledger',
        };
      }
      return out;
    }

    try {
      const reading = await this.#wallets.readBalances(
        chain,
        tokens.filter((token) => !isNativeToken(chain, token)),
      );
      if (reading.error || reading.observedAt === null) return out;
      const at = Date.parse(reading.observedAt);
      const source = reading.source ?? 'rpc';
      if (reading.native) {
        out[balanceKey(chain, CHAINS[chain].nativeSentinel)] = {
          value: reading.native.amount,
          at,
          source,
        };
      }
      for (const token of reading.tokens) {
        out[balanceKey(chain, token.address)] = { value: token.amount, at, source };
      }
    } catch (error) {
      this.#log.warn({ chain, err: error }, 'live balance read failed');
    }
    return out;
  }
}

/** Pool TVL in micro-USD, floor-rounded, from reserves at the given prices. */
export function poolTvlMicros(pool: LpPoolState, atto0: bigint, atto1: bigint): bigint {
  return (
    nativeToUsdMicros(amountToBigint(pool.reserve0), pool.token0.decimals, atto0, 'floor') +
    nativeToUsdMicros(amountToBigint(pool.reserve1), pool.token1.decimals, atto1, 'floor')
  );
}

/**
 * How far the pool's own price is from the market price, in basis points.
 *
 * In a constant-product pool the two reserves are worth the same at the
 * pool's price, so the ratio of their market values is the ratio of the pool
 * price to the market price. Rounded up.
 */
export function reserveValueDeviationBps(pool: LpPoolState, atto0: bigint, atto1: bigint): bigint {
  const v0 = nativeToUsdMicros(amountToBigint(pool.reserve0), pool.token0.decimals, atto0, 'floor');
  const v1 = nativeToUsdMicros(amountToBigint(pool.reserve1), pool.token1.decimals, atto1, 'floor');
  const low = v0 < v1 ? v0 : v1;
  const high = v0 < v1 ? v1 : v0;
  if (low <= 0n) return 10_000n;
  return ((high - low) * 10_000n + low - 1n) / low;
}

/** Value of a position's share of the reserves, floor-rounded, micro-USD. */
export function positionValueMicros(
  pool: LpPoolState,
  lpTokens: bigint,
  atto0: bigint,
  atto1: bigint,
): bigint {
  const totalSupply = amountToBigint(pool.totalSupply);
  if (totalSupply <= 0n || lpTokens <= 0n) return 0n;
  const amount0 = (lpTokens * amountToBigint(pool.reserve0)) / totalSupply;
  const amount1 = (lpTokens * amountToBigint(pool.reserve1)) / totalSupply;
  return (
    nativeToUsdMicros(amount0, pool.token0.decimals, atto0, 'floor') +
    nativeToUsdMicros(amount1, pool.token1.decimals, atto1, 'floor')
  );
}

/** USD per whole LP token in atto-USD: TVL / totalSupply, at 18 LP decimals. */
export function lpTokenPriceAtto(pool: LpPoolState, tvlMicros: bigint): bigint {
  const totalSupply = amountToBigint(pool.totalSupply);
  if (totalSupply <= 0n) return 0n;
  const tvlAtto = tvlMicros * (PRICE_SCALE / USD_SCALE);
  return (tvlAtto * 10n ** BigInt(pool.lpTokenDecimals)) / totalSupply;
}

/** Render atto-USD as the decimal string the price parser accepts. */
export function attoToPrice(atto: bigint): string {
  const integer = atto / PRICE_SCALE;
  const fraction = (atto % PRICE_SCALE).toString().padStart(18, '0');
  return `${integer.toString()}.${fraction}`;
}
