import type { ExecutionOutcome, ExecutionQuote } from './types.js';
import type { ProposedAction } from '../risk/types.js';
import type { LedgerService } from '../trading/ledger.js';
import type { TradeStore } from '../trading/trades.js';
import type { RiskGate } from '../risk/gate.js';
import type { AuditLog } from '../audit/audit.js';
import {
  amountToBigint,
  bpsOf,
  microsToUsd,
  nativeToUsdMicros,
  priceToAtto,
} from '../risk/money.js';
import { feeInNativeUnits } from '../risk/engine.js';
import { CHAINS } from '../chains/registry.js';
import { childLogger } from '../logging/logger.js';
import { errorMessage } from '../util/errors.js';

/**
 * The paper executor.
 *
 * Simulates a fill without touching a chain, using assumptions deliberately
 * worse than a perfect fill so paper results err on the pessimistic side:
 *
 *  - the received amount is the quote's expected output minus **half the
 *    requested slippage tolerance** plus a fixed 5 bps, never the full
 *    expected amount — a real fill lands somewhere inside the tolerance and
 *    the midpoint is a fair, slightly conservative model;
 *  - the fee is the full estimated fee at the current native price, charged
 *    as realized loss the moment the fill lands;
 *  - the received asset is booked at what was *paid*, so any difference
 *    between paid and received shows up as unrealized P&L from the first
 *    instant, which is how slippage looks in a real ledger.
 *
 * Everything is recorded as simulated. Nothing this class produces can be
 * mistaken for a live result: the trade row carries mode PAPER, the fill row
 * carries simulated=1, and there is no transaction hash.
 */

const PAPER_EXTRA_SLIPPAGE_BPS = 5;

export interface PaperFillPrices {
  tokenInUsd: string;
  tokenOutUsd: string;
  nativeUsd: string;
}

export interface PaperExecutorDeps {
  ledger: LedgerService;
  trades: TradeStore;
  gate: RiskGate;
  audit: AuditLog;
  now?: () => number;
}

export class PaperExecutor {
  readonly #ledger: LedgerService;
  readonly #trades: TradeStore;
  readonly #gate: RiskGate;
  readonly #audit: AuditLog;
  readonly #now: () => number;
  readonly #log = childLogger('paper-executor');

  constructor(deps: PaperExecutorDeps) {
    this.#ledger = deps.ledger;
    this.#trades = deps.trades;
    this.#gate = deps.gate;
    this.#audit = deps.audit;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Execute an allowed action on paper.
   *
   * Preconditions the caller guarantees: the trade row is in `allowed`, the
   * decision was `OK`, and the action carries a quote.
   */
  execute(
    tradeId: string,
    action: ProposedAction,
    quote: ExecutionQuote,
    prices: PaperFillPrices,
  ): ExecutionOutcome {
    const filledAt = this.#now();

    if (!action.quote) {
      return this.#fail(tradeId, action, 'paper execution requires a quote', filledAt);
    }

    // Dispatch is the moment cooldowns start, for paper exactly as for live.
    this.#trades.markDispatched(tradeId);
    this.#gate.markDispatched(action);

    try {
      const expected = amountToBigint(quote.expectedAmountOut);
      const haircutBps = Math.floor(action.quote.slippageBps / 2) + PAPER_EXTRA_SLIPPAGE_BPS;
      const received = expected - bpsOf(expected, haircutBps);
      const minOut = amountToBigint(quote.minAmountOut);

      // A paper fill must respect the same floor the on-chain transaction
      // would enforce; if the model pushes below minOut the trade reverts.
      if (received < minOut) {
        return this.#fail(
          tradeId,
          action,
          `paper fill ${received.toString()} would be below minAmountOut ${minOut.toString()}`,
          filledAt,
        );
      }

      const feeNative = feeInNativeUnits(action.feeEstimate.detail);
      const feeUsd = nativeToUsdMicros(
        feeNative,
        CHAINS[action.chain].nativeDecimals,
        priceToAtto(prices.nativeUsd),
        'ceil',
      );

      this.#ledger.recordFill({
        tradeId,
        mode: 'PAPER',
        chain: action.chain,
        tokenIn: action.tokenIn,
        tokenOut: action.tokenOut,
        amountIn: action.amountIn,
        amountOut: received.toString(),
        priceInUsd: prices.tokenInUsd,
        priceOutUsd: prices.tokenOutUsd,
        feeUsd: microsToUsd(feeUsd),
        filledAt,
        simulated: true,
      });

      this.#trades.markFilled(tradeId, {
        filledOut: received.toString(),
        feeNative: feeNative.toString(),
        feeUsd: microsToUsd(feeUsd),
      });

      this.#audit.append({
        category: 'trade',
        action: 'trade.filled',
        status: 'ok',
        summary: `PAPER fill: ${action.amountIn} ${symbolOf(action.chain, action.tokenIn.address)} -> ${received.toString()} ${symbolOf(action.chain, action.tokenOut.address)}`,
        chain: action.chain,
        actor: `agent:${action.source}`,
        mode: 'PAPER',
        correlationId: action.decisionCycleId,
        detail: {
          tradeId,
          actionId: action.actionId,
          simulated: true,
          expectedOut: quote.expectedAmountOut,
          filledOut: received.toString(),
          haircutBps,
          feeUsd: microsToUsd(feeUsd),
        },
      });

      return {
        actionId: action.actionId,
        mode: 'PAPER',
        status: 'filled',
        amountOut: received.toString(),
        feeUsd: microsToUsd(feeUsd),
        txHash: null,
        error: null,
        filledAt,
      };
    } catch (error) {
      return this.#fail(tradeId, action, errorMessage(error), filledAt);
    }
  }

  #fail(tradeId: string, action: ProposedAction, reason: string, at: number): ExecutionOutcome {
    this.#log.warn({ tradeId, reason }, 'paper execution failed');
    try {
      this.#trades.markFailed(tradeId, reason);
    } catch {
      // The row may already be terminal; the audit row below still records it.
    }

    this.#audit.append({
      category: 'trade',
      action: 'trade.failed',
      status: 'failed',
      summary: `PAPER execution failed: ${reason}`,
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
      amountOut: null,
      feeUsd: '0.000000',
      txHash: null,
      error: reason,
      filledAt: at,
    };
  }
}

function symbolOf(chain: ProposedAction['chain'], address: string): string {
  return (
    CHAINS[chain].tokens.find((token) => token.address === address)?.symbol ?? address.slice(0, 10)
  );
}
