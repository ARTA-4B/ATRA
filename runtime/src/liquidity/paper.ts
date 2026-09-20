import type { ProposedAction } from '../risk/types.js';
import type { LedgerService } from '../trading/ledger.js';
import type { TradeStore } from '../trading/trades.js';
import type { RiskGate } from '../risk/gate.js';
import type { AuditLog } from '../audit/audit.js';
import {
  amountToBigint,
  microsToUsd,
  nativeToUsdMicros,
  priceToAtto,
  usdToMicros,
} from '../risk/money.js';
import { feeInNativeUnits } from '../risk/engine.js';
import { CHAINS } from '../chains/registry.js';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import type { LiquidityStore } from './store.js';
import type { LpPlan } from './proposal.js';
import type { LpPoolState } from './types.js';

/**
 * The paper LP executor.
 *
 * Simulates an add or a removal against the pool's live reserves without
 * touching a chain:
 *
 *  - an add spends both assets from the paper balances at the amounts the
 *    quote adjusted to the pool ratio, and mints
 *    `min(amount0 × totalSupply / reserve0, amount1 × totalSupply / reserve1)`
 *    LP tokens — the pair contract's own formula, from the reserves as read;
 *  - a removal returns the position's share of the reserves as read now, so
 *    a price move since the add shows up as impermanent loss against the
 *    cost basis;
 *  - the fee is the full estimated gas at the current native price, charged
 *    as a realized loss; every fill records what it realized through
 *    `LiquidityStore.recordPnl`, which is where the daily-loss check reads
 *    the LP side of the day from;
 *  - **fee accrual is not simulated.** A paper position reports zero fees
 *    with a note saying so; a claim on paper is refused before it gets here.
 *
 * Everything is recorded as simulated: mode PAPER, no transaction hash.
 */

export interface LpFillPrices {
  token0Usd: string;
  token1Usd: string;
  nativeUsd: string;
}

export interface LpExecutionOutcome {
  actionId: string;
  mode: 'PAPER' | 'LIVE';
  status: 'filled' | 'failed';
  lpTokens: string | null;
  amount0: string | null;
  amount1: string | null;
  feeUsd: string;
  txHash: string | null;
  error: string | null;
  filledAt: number;
}

export interface PaperLpExecutorDeps {
  ledger: LedgerService;
  trades: TradeStore;
  gate: RiskGate;
  audit: AuditLog;
  store: LiquidityStore;
  now?: () => number;
}

export class PaperLpExecutor {
  readonly #ledger: LedgerService;
  readonly #trades: TradeStore;
  readonly #gate: RiskGate;
  readonly #audit: AuditLog;
  readonly #store: LiquidityStore;
  readonly #now: () => number;
  readonly #log = childLogger('lp-paper');

  constructor(deps: PaperLpExecutorDeps) {
    this.#ledger = deps.ledger;
    this.#trades = deps.trades;
    this.#gate = deps.gate;
    this.#audit = deps.audit;
    this.#store = deps.store;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Execute an allowed LP action on paper.
   *
   * Preconditions the caller guarantees: the trade row is `allowed`, the
   * decision was `OK`, and `plan` is what the action was built from.
   */
  execute(
    tradeId: string,
    action: ProposedAction,
    plan: LpPlan,
    pool: LpPoolState,
    prices: LpFillPrices,
  ): LpExecutionOutcome {
    const filledAt = this.#now();
    if (action.mode !== 'PAPER') {
      return this.#fail(tradeId, action, `action mode ${action.mode} is not PAPER`, filledAt);
    }
    if (!action.lp) {
      return this.#fail(tradeId, action, 'paper LP execution requires the lp leg', filledAt);
    }

    this.#trades.markDispatched(tradeId);
    this.#gate.markDispatched(action);

    try {
      const feeNative = feeInNativeUnits(action.feeEstimate.detail);
      const feeUsd = nativeToUsdMicros(
        feeNative,
        CHAINS[action.chain].nativeDecimals,
        priceToAtto(prices.nativeUsd),
        'ceil',
      );

      switch (plan.kind) {
        case 'add':
          return this.#add(tradeId, action, plan.quote, pool, prices, feeNative, feeUsd, filledAt);
        case 'remove':
          return this.#remove(
            tradeId,
            action,
            plan.quote,
            pool,
            prices,
            feeNative,
            feeUsd,
            filledAt,
          );
        case 'claim':
          return this.#fail(
            tradeId,
            action,
            'fee accrual is not simulated in PAPER; there is nothing to claim',
            filledAt,
          );
        default:
          return this.#fail(tradeId, action, 'unknown plan', filledAt);
      }
    } catch (error) {
      return this.#fail(tradeId, action, errorMessage(error), filledAt);
    }
  }

  #add(
    tradeId: string,
    action: ProposedAction,
    quote: Extract<LpPlan, { kind: 'add' }>['quote'],
    pool: LpPoolState,
    prices: LpFillPrices,
    feeNative: bigint,
    feeUsd: bigint,
    filledAt: number,
  ): LpExecutionOutcome {
    const amount0 = amountToBigint(quote.amount0);
    const amount1 = amountToBigint(quote.amount1);
    const reserve0 = amountToBigint(pool.reserve0);
    const reserve1 = amountToBigint(pool.reserve1);
    const totalSupply = amountToBigint(pool.totalSupply);
    if (reserve0 <= 0n || reserve1 <= 0n || totalSupply <= 0n) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, 'The pool has no reserves');
    }

    // The pair's mint formula, from the reserves as read.
    const by0 = (amount0 * totalSupply) / reserve0;
    const by1 = (amount1 * totalSupply) / reserve1;
    const minted = by0 < by1 ? by0 : by1;
    const minLp = amountToBigint(quote.minLpTokens);
    if (minted < minLp) {
      return this.#fail(
        tradeId,
        action,
        `paper mint ${minted.toString()} would be below the minimum ${minLp.toString()}`,
        filledAt,
      );
    }

    const capital =
      nativeToUsdMicros(amount0, pool.token0.decimals, priceToAtto(prices.token0Usd), 'ceil') +
      nativeToUsdMicros(amount1, pool.token1.decimals, priceToAtto(prices.token1Usd), 'ceil');

    // Spend both assets, book the position and charge the gas in one
    // transaction: a throw between the two debits would otherwise leave the
    // first asset spent with no position to show for it.
    this.#store.transaction(() => {
      this.#adjustPaper(action.chain, pool.token0.address, pool.token0.decimals, -amount0);
      this.#adjustPaper(action.chain, pool.token1.address, pool.token1.decimals, -amount1);
      this.#store.bookAdd({
        mode: 'PAPER',
        chain: action.chain,
        protocol: action.protocol,
        poolId: pool.poolId,
        token0: { address: pool.token0.address, decimals: pool.token0.decimals },
        token1: { address: pool.token1.address, decimals: pool.token1.decimals },
        lpTokens: minted.toString(),
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        capitalUsd: microsToUsd(capital),
        at: filledAt,
        rebalance: action.kind === 'lp_rebalance',
      });
      // An add realizes nothing but the gas, which the day has still lost.
      this.#store.recordPnl({
        tradeId,
        mode: 'PAPER',
        chain: action.chain,
        protocol: action.protocol,
        poolId: pool.poolId,
        action: action.kind === 'lp_rebalance' ? 'REBALANCE' : 'ADD',
        proceedsUsd: 0n,
        costReleasedUsd: 0n,
        feeUsd,
        at: filledAt,
        simulated: true,
      });
    });

    this.#trades.markFilled(tradeId, {
      filledOut: minted.toString(),
      feeNative: feeNative.toString(),
      feeUsd: microsToUsd(feeUsd),
    });

    this.#audit.append({
      category: 'liquidity',
      action: 'liquidity.filled',
      status: 'ok',
      summary: `PAPER LP add: ${amount0.toString()} ${symbol(pool, 0)} + ${amount1.toString()} ${symbol(pool, 1)} -> ${minted.toString()} LP of ${pool.poolId.slice(0, 10)}…`,
      chain: action.chain,
      actor: `agent:${action.source}`,
      mode: 'PAPER',
      correlationId: action.decisionCycleId,
      detail: {
        tradeId,
        actionId: action.actionId,
        simulated: true,
        poolId: pool.poolId,
        lpTokens: minted.toString(),
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        capitalUsd: microsToUsd(capital),
        feeUsd: microsToUsd(feeUsd),
        note: 'fee accrual is not simulated in PAPER',
      },
    });

    return {
      actionId: action.actionId,
      mode: 'PAPER',
      status: 'filled',
      lpTokens: minted.toString(),
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      feeUsd: microsToUsd(feeUsd),
      txHash: null,
      error: null,
      filledAt,
    };
  }

  #remove(
    tradeId: string,
    action: ProposedAction,
    quote: Extract<LpPlan, { kind: 'remove' }>['quote'],
    pool: LpPoolState,
    prices: LpFillPrices,
    feeNative: bigint,
    feeUsd: bigint,
    filledAt: number,
  ): LpExecutionOutcome {
    const lpTokens = amountToBigint(quote.lpTokens);
    const totalSupply = amountToBigint(pool.totalSupply);
    if (totalSupply <= 0n) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, 'The pool has no supply');
    }
    // The burn returns the share of the reserves as read now.
    const out0 = (lpTokens * amountToBigint(pool.reserve0)) / totalSupply;
    const out1 = (lpTokens * amountToBigint(pool.reserve1)) / totalSupply;
    if (out0 < amountToBigint(quote.min0) || out1 < amountToBigint(quote.min1)) {
      return this.#fail(
        tradeId,
        action,
        `paper burn ${out0.toString()}/${out1.toString()} would be below the minimum ${quote.min0}/${quote.min1}`,
        filledAt,
      );
    }

    const proceeds =
      nativeToUsdMicros(out0, pool.token0.decimals, priceToAtto(prices.token0Usd), 'floor') +
      nativeToUsdMicros(out1, pool.token1.decimals, priceToAtto(prices.token1Usd), 'floor');

    // Burn, credit both assets and realize the result in one transaction, for
    // the same reason the add is one: a half-written exit is a wrong ledger.
    const { booked, realized } = this.#store.transaction(() => {
      const removed = this.#store.bookRemove({
        mode: 'PAPER',
        chain: action.chain,
        protocol: action.protocol,
        poolId: pool.poolId,
        lpTokens: lpTokens.toString(),
        at: filledAt,
      });
      this.#adjustPaper(action.chain, pool.token0.address, pool.token0.decimals, out0);
      this.#adjustPaper(action.chain, pool.token1.address, pool.token1.decimals, out1);
      return {
        booked: removed,
        realized: this.#store.recordPnl({
          tradeId,
          mode: 'PAPER',
          chain: action.chain,
          protocol: action.protocol,
          poolId: pool.poolId,
          action: removed.closed ? 'EXIT' : 'REMOVE',
          proceedsUsd: proceeds,
          costReleasedUsd: removed.costReleasedUsd,
          feeUsd,
          at: filledAt,
          simulated: true,
        }),
      };
    });

    this.#trades.markFilled(tradeId, {
      filledOut: out1.toString(),
      feeNative: feeNative.toString(),
      feeUsd: microsToUsd(feeUsd),
    });

    this.#audit.append({
      category: 'liquidity',
      action: 'liquidity.filled',
      status: 'ok',
      summary: `PAPER LP ${booked.closed ? 'exit' : 'remove'}: ${lpTokens.toString()} LP -> ${out0.toString()} ${symbol(pool, 0)} + ${out1.toString()} ${symbol(pool, 1)} (realized ${microsToUsd(realized)} USD)`,
      chain: action.chain,
      actor: `agent:${action.source}`,
      mode: 'PAPER',
      correlationId: action.decisionCycleId,
      detail: {
        tradeId,
        actionId: action.actionId,
        simulated: true,
        poolId: pool.poolId,
        lpTokens: lpTokens.toString(),
        amount0: out0.toString(),
        amount1: out1.toString(),
        proceedsUsd: microsToUsd(proceeds),
        costReleasedUsd: microsToUsd(booked.costReleasedUsd),
        realizedUsd: microsToUsd(realized),
        feeUsd: microsToUsd(feeUsd),
        closed: booked.closed,
      },
    });

    return {
      actionId: action.actionId,
      mode: 'PAPER',
      status: 'filled',
      lpTokens: lpTokens.toString(),
      amount0: out0.toString(),
      amount1: out1.toString(),
      feeUsd: microsToUsd(feeUsd),
      txHash: null,
      error: null,
      filledAt,
    };
  }

  /** Paper balances move through the trading ledger's own table. */
  #adjustPaper(
    chain: ProposedAction['chain'],
    token: string,
    decimals: number,
    delta: bigint,
  ): void {
    const current = this.#ledger.getPaperBalance(chain, token);
    const held = current ? amountToBigint(current.amount) : 0n;
    const next = held + delta;
    if (next < 0n) {
      throw new AppError(ErrorCode.CONFLICT, 'Paper balance would go negative', {
        details: { chain, token, held: held.toString(), delta: delta.toString() },
      });
    }
    this.#ledger.setPaperBalance(chain, token, decimals, next.toString());
  }

  #fail(tradeId: string, action: ProposedAction, reason: string, at: number): LpExecutionOutcome {
    this.#log.warn({ tradeId, reason }, 'paper LP execution failed');
    try {
      this.#trades.markFailed(tradeId, reason);
    } catch {
      // The row may already be terminal; the audit row below still records it.
    }
    this.#audit.append({
      category: 'liquidity',
      action: 'liquidity.failed',
      status: 'failed',
      summary: `PAPER LP execution failed: ${reason}`,
      chain: action.chain,
      actor: `agent:${action.source}`,
      mode: 'PAPER',
      correlationId: action.decisionCycleId,
      detail: { tradeId, actionId: action.actionId, simulated: true },
    });
    return {
      actionId: action.actionId,
      mode: 'PAPER',
      status: 'failed',
      lpTokens: null,
      amount0: null,
      amount1: null,
      feeUsd: microsToUsd(usdToMicros('0')),
      txHash: null,
      error: reason,
      filledAt: at,
    };
  }
}

function symbol(pool: LpPoolState, index: 0 | 1): string {
  const token = index === 0 ? pool.token0 : pool.token1;
  return token.symbol ?? token.address.slice(0, 10);
}
