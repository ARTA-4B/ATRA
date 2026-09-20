import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { ChainId } from '../chains/registry.js';
import { isNativeToken, isStablecoin } from '../chains/registry.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import {
  amountToBigint,
  microsToUsd,
  nativeToUsdMicros,
  priceToAtto,
  usdToMicros,
} from '../risk/money.js';
import type { Ledger as RiskLedger, Mode, Position as RiskPosition } from '../risk/types.js';

/**
 * The ledger: positions, fills, balances and P&L.
 *
 * All arithmetic is bigint at fixed scale, the same discipline as the risk
 * engine, because these are the numbers the daily-loss check reads. A ledger
 * that rounds in its own favour would let the engine approve a trade the
 * operator's real drawdown should have blocked.
 *
 * PAPER and LIVE positions are kept in separate rows of the same tables so a
 * paper experiment can never be mistaken for a live holding. Paper balances
 * are seeded by the operator and debited by fills: paper trading is bounded by
 * a stated bankroll, not an imaginary infinite one.
 *
 * Cost basis is average-cost. A reduce realizes P&L proportionally; a fill
 * that opens or adds moves the average. Fees are charged in USD at fill time
 * and appear as negative realized P&L, so "the day's loss" includes what was
 * paid to trade.
 */

export interface Position {
  id: string;
  mode: Mode;
  chain: ChainId;
  token: string;
  decimals: number;
  amount: string;
  costBasisUsd: string;
  openedAt: string;
  updatedAt: string;
}

export interface Fill {
  id: string;
  tradeId: string;
  mode: Mode;
  chain: ChainId;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  priceInUsd: string;
  priceOutUsd: string;
  feeUsd: string;
  realizedPnlUsd: string;
  filledAt: string;
  simulated: boolean;
}

export interface RecordFillInput {
  tradeId: string;
  mode: Mode;
  chain: ChainId;
  tokenIn: { address: string; decimals: number };
  tokenOut: { address: string; decimals: number };
  amountIn: string;
  amountOut: string;
  /** USD prices at fill time, as decimal strings. */
  priceInUsd: string;
  priceOutUsd: string;
  /** Total fee in micro-USD, already computed by the executor. */
  feeUsd: string;
  filledAt: number;
  simulated: boolean;
}

export interface PortfolioMark {
  mode: Mode;
  /** Sum of position marks, micro-USD as a decimal string. Null when a price is missing. */
  positionsValueUsd: string | null;
  deployedUsd: string;
  unrealizedPnlUsd: string | null;
  realizedPnlTodayUsd: string;
  /** Positions whose token had no price and are therefore unmarked. */
  unpriced: Array<{ chain: ChainId; token: string }>;
  positions: Array<Position & { markUsd: string | null; unrealizedUsd: string | null }>;
}

export type PriceLookup = (chain: ChainId, token: string) => string | null;

export class LedgerService {
  readonly #db: Db;
  readonly #log = childLogger('ledger');
  readonly #now: () => number;

  constructor(db: Db, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  // --- paper balances ------------------------------------------------------

  /**
   * Set a paper balance.
   *
   * The operator states the bankroll a paper experiment may use. Nothing is
   * created from nothing: a paper fill that would overdraw is refused just as a
   * live one would be by the chain.
   */
  setPaperBalance(chain: ChainId, token: string, decimals: number, amount: string): void {
    amountToBigint(amount);
    this.#db
      .prepare(
        'INSERT INTO paper_balances (chain, token, decimals, amount, updated_at) VALUES (?, ?, ?, ?, ?)' +
          ' ON CONFLICT(chain, token) DO UPDATE SET amount = excluded.amount,' +
          ' decimals = excluded.decimals, updated_at = excluded.updated_at',
      )
      .run(chain, token, decimals, amount, new Date(this.#now()).toISOString());
  }

  getPaperBalance(chain: ChainId, token: string): { amount: string; decimals: number } | undefined {
    const row = this.#db
      .prepare<[string, string], { amount: string; decimals: number }>(
        'SELECT amount, decimals FROM paper_balances WHERE chain = ? AND token = ?',
      )
      .get(chain, token);
    return row ?? undefined;
  }

  listPaperBalances(): Array<{ chain: ChainId; token: string; decimals: number; amount: string }> {
    return this.#db
      .prepare<[], { chain: ChainId; token: string; decimals: number; amount: string }>(
        'SELECT chain, token, decimals, amount FROM paper_balances ORDER BY chain, token',
      )
      .all();
  }

  #adjustPaperBalance(chain: ChainId, token: string, decimals: number, delta: bigint): void {
    const current = this.getPaperBalance(chain, token);
    const held = current ? amountToBigint(current.amount) : 0n;
    const next = held + delta;

    if (next < 0n) {
      throw new AppError(ErrorCode.CONFLICT, 'Paper balance would go negative', {
        details: { chain, token, held: held.toString(), delta: delta.toString() },
      });
    }

    this.setPaperBalance(chain, token, decimals, next.toString());
  }

  // --- positions -----------------------------------------------------------

  listPositions(mode: Mode): Position[] {
    return this.#db
      .prepare<[Mode], PositionRow>('SELECT * FROM positions WHERE mode = ? ORDER BY opened_at')
      .all(mode)
      .map(toPosition);
  }

  getPosition(mode: Mode, chain: ChainId, token: string): Position | undefined {
    const row = this.#db
      .prepare<[Mode, string, string], PositionRow>(
        'SELECT * FROM positions WHERE mode = ? AND chain = ? AND token = ?',
      )
      .get(mode, chain, token);
    return row ? toPosition(row) : undefined;
  }

  // --- fills ---------------------------------------------------------------

  /**
   * Record a fill and update positions, balances and realized P&L atomically.
   *
   * A swap is modelled as closing (part of) a position in tokenIn and opening
   * (or adding to) one in tokenOut. Stablecoins and native gas tokens are
   * positions too — that keeps the arithmetic uniform, and "deployed capital"
   * is then simply the cost basis of everything that is not the quote asset.
   */
  recordFill(input: RecordFillInput): Fill {
    const amountIn = amountToBigint(input.amountIn);
    const amountOut = amountToBigint(input.amountOut);
    const priceIn = priceToAtto(input.priceInUsd);
    const priceOut = priceToAtto(input.priceOutUsd);
    const feeUsd = usdToMicros(input.feeUsd);

    if (amountIn <= 0n || amountOut <= 0n) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'A fill must move a positive amount');
    }

    const filledAt = new Date(input.filledAt).toISOString();
    const inValueUsd = nativeToUsdMicros(amountIn, input.tokenIn.decimals, priceIn, 'floor');
    const outValueUsd = nativeToUsdMicros(amountOut, input.tokenOut.decimals, priceOut, 'floor');

    const write = this.#db.transaction(() => {
      // Reduce the position in tokenIn, realizing P&L against its cost basis.
      const realizedFromExit = this.#reducePosition(
        input.mode,
        input.chain,
        input.tokenIn.address,
        input.tokenIn.decimals,
        amountIn,
        inValueUsd,
        filledAt,
      );

      // Open or add to the position in tokenOut at what was actually paid.
      this.#addPosition(
        input.mode,
        input.chain,
        input.tokenOut.address,
        input.tokenOut.decimals,
        amountOut,
        inValueUsd,
        filledAt,
      );

      if (input.mode === 'PAPER') {
        this.#adjustPaperBalance(
          input.chain,
          input.tokenIn.address,
          input.tokenIn.decimals,
          -amountIn,
        );
        this.#adjustPaperBalance(
          input.chain,
          input.tokenOut.address,
          input.tokenOut.decimals,
          amountOut,
        );
      }

      // The fee is a realized loss regardless of what the swap itself did.
      const realized = realizedFromExit - feeUsd;

      const fill: Fill = {
        id: randomUUID(),
        tradeId: input.tradeId,
        mode: input.mode,
        chain: input.chain,
        tokenIn: input.tokenIn.address,
        tokenOut: input.tokenOut.address,
        amountIn: input.amountIn,
        amountOut: input.amountOut,
        priceInUsd: input.priceInUsd,
        priceOutUsd: input.priceOutUsd,
        feeUsd: microsToUsd(feeUsd),
        realizedPnlUsd: microsToUsd(realized),
        filledAt,
        simulated: input.simulated,
      };

      this.#db
        .prepare(
          'INSERT INTO fills (id, trade_id, mode, chain, token_in, token_out, amount_in, amount_out,' +
            ' price_in_usd, price_out_usd, fee_usd, realized_pnl_usd, filled_at, simulated)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          fill.id,
          fill.tradeId,
          fill.mode,
          fill.chain,
          fill.tokenIn,
          fill.tokenOut,
          fill.amountIn,
          fill.amountOut,
          fill.priceInUsd,
          fill.priceOutUsd,
          fill.feeUsd,
          fill.realizedPnlUsd,
          fill.filledAt,
          fill.simulated ? 1 : 0,
        );

      // outValueUsd is what the received asset is worth right now; the
      // position was opened at inValueUsd (what was paid). The difference is
      // unrealized from the first instant, which is how slippage shows up.
      this.#log.info(
        {
          tradeId: input.tradeId,
          mode: input.mode,
          paidUsd: microsToUsd(inValueUsd),
          receivedUsd: microsToUsd(outValueUsd),
          realizedUsd: fill.realizedPnlUsd,
        },
        'fill recorded',
      );

      return fill;
    });

    return write();
  }

  /**
   * Reduce a position, returning realized P&L in micro-USD.
   *
   * With no position (the first purchase of a token, or spending the quote
   * asset), nothing is realized and nothing is recorded — the caller is
   * spending a balance, not closing a trade.
   */
  #reducePosition(
    mode: Mode,
    chain: ChainId,
    token: string,
    decimals: number,
    amount: bigint,
    proceedsUsd: bigint,
    at: string,
  ): bigint {
    const existing = this.getPosition(mode, chain, token);
    if (!existing) return 0n;

    const held = amountToBigint(existing.amount);
    const basis = usdToMicros(existing.costBasisUsd);
    const sold = amount > held ? held : amount;

    // Cost of the portion sold, at average cost. Rounded up: a higher cost
    // means lower realized profit, which is the conservative direction.
    const costOfSold = held === 0n ? 0n : (basis * sold + held - 1n) / held;
    // Proceeds belong to the whole amount spent. When the fill spends more
    // than the position held (a stablecoin position of 1 USDC followed by a
    // 25 USDC purchase), only the held share's proceeds are realized against
    // its cost; the rest was never a position and realizes nothing. Rounded
    // down: lower proceeds mean lower realized profit.
    const proceedsOfSold = amount === sold ? proceedsUsd : (proceedsUsd * sold) / amount;
    const realized = proceedsOfSold - costOfSold;

    const remaining = held - sold;
    if (remaining === 0n) {
      this.#db
        .prepare('DELETE FROM positions WHERE mode = ? AND chain = ? AND token = ?')
        .run(mode, chain, token);
    } else {
      this.#db
        .prepare(
          'UPDATE positions SET amount = ?, cost_basis_usd = ?, updated_at = ?' +
            ' WHERE mode = ? AND chain = ? AND token = ?',
        )
        .run(remaining.toString(), microsToUsd(basis - costOfSold), at, mode, chain, token);
    }

    void decimals;
    return realized;
  }

  #addPosition(
    mode: Mode,
    chain: ChainId,
    token: string,
    decimals: number,
    amount: bigint,
    costUsd: bigint,
    at: string,
  ): void {
    const existing = this.getPosition(mode, chain, token);

    if (!existing) {
      this.#db
        .prepare(
          'INSERT INTO positions (id, mode, chain, token, decimals, amount, cost_basis_usd,' +
            ' opened_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          randomUUID(),
          mode,
          chain,
          token,
          decimals,
          amount.toString(),
          microsToUsd(costUsd),
          at,
          at,
        );
      return;
    }

    const held = amountToBigint(existing.amount);
    const basis = usdToMicros(existing.costBasisUsd);
    this.#db
      .prepare(
        'UPDATE positions SET amount = ?, cost_basis_usd = ?, updated_at = ?' +
          ' WHERE mode = ? AND chain = ? AND token = ?',
      )
      .run((held + amount).toString(), microsToUsd(basis + costUsd), at, mode, chain, token);
  }

  // --- P&L -----------------------------------------------------------------

  /** Realized P&L for the UTC day containing `now`, fees included. */
  realizedPnlTodayUsd(mode: Mode, now: number = this.#now()): bigint {
    const dayStart = new Date(Math.floor(now / 86_400_000) * 86_400_000).toISOString();
    const rows = this.#db
      .prepare<[Mode, string], { realized_pnl_usd: string }>(
        'SELECT realized_pnl_usd FROM fills WHERE mode = ? AND filled_at >= ?',
      )
      .all(mode, dayStart);

    return rows.reduce((total, row) => total + usdToMicros(row.realized_pnl_usd), 0n);
  }

  /**
   * Mark every position at current prices.
   *
   * A position whose token has no price is reported as unpriced and excluded
   * from the totals, which are then `null`: a portfolio value that silently
   * omits a holding is a wrong number, not a partial one.
   */
  mark(mode: Mode, price: PriceLookup): PortfolioMark {
    const positions = this.listPositions(mode);
    const unpriced: Array<{ chain: ChainId; token: string }> = [];
    let value = 0n;
    let deployed = 0n;
    let unrealized = 0n;

    const marked = positions.map((position) => {
      const basis = usdToMicros(position.costBasisUsd);
      // The quote asset (native coin or a stable) is not "deployed": it is what
      // capital returns to. Everything else is.
      const isQuote =
        isNativeToken(position.chain, position.token) || isStable(position.chain, position.token);
      if (!isQuote) deployed += basis;

      const quote = price(position.chain, position.token);
      if (quote === null) {
        unpriced.push({ chain: position.chain, token: position.token });
        return { ...position, markUsd: null, unrealizedUsd: null };
      }

      let atto: bigint;
      try {
        atto = priceToAtto(quote);
      } catch {
        unpriced.push({ chain: position.chain, token: position.token });
        return { ...position, markUsd: null, unrealizedUsd: null };
      }
      if (atto <= 0n) {
        unpriced.push({ chain: position.chain, token: position.token });
        return { ...position, markUsd: null, unrealizedUsd: null };
      }

      const markUsd = nativeToUsdMicros(
        amountToBigint(position.amount),
        position.decimals,
        atto,
        'floor',
      );
      const pnl = markUsd - basis;
      value += markUsd;
      unrealized += pnl;

      return { ...position, markUsd: microsToUsd(markUsd), unrealizedUsd: microsToUsd(pnl) };
    });

    const complete = unpriced.length === 0;

    return {
      mode,
      positionsValueUsd: complete ? microsToUsd(value) : null,
      deployedUsd: microsToUsd(deployed),
      unrealizedPnlUsd: complete ? microsToUsd(unrealized) : null,
      realizedPnlTodayUsd: microsToUsd(this.realizedPnlTodayUsd(mode)),
      unpriced,
      positions: marked,
    };
  }

  /**
   * Record the day's opening unrealized P&L once per UTC day.
   *
   * The daily-loss check measures drawdown *since the day started*, so it
   * needs to know where the day started. Idempotent: a second call on the same
   * day keeps the first mark.
   */
  recordDayStart(mode: Mode, unrealizedUsd: string, now: number = this.#now()): void {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    this.#db
      .prepare(
        'INSERT INTO ledger_days (mode, day_start_utc_ms, unrealized_at_start_usd, recorded_at)' +
          ' VALUES (?, ?, ?, ?) ON CONFLICT(mode, day_start_utc_ms) DO NOTHING',
      )
      .run(mode, dayStart, unrealizedUsd, new Date(now).toISOString());
  }

  /**
   * The ledger as the risk engine wants it.
   *
   * When a position cannot be priced, `unrealizedPnlUsd` is reported as the
   * worst case the engine will accept — zero unrealized gain — rather than as
   * a number that pretends the unpriced holding is worthless or unchanged.
   * Combined with the freshness checks, an unpriced holding makes the engine
   * more conservative, never less.
   */
  toRiskLedger(mode: Mode, price: PriceLookup, now: number = this.#now()): RiskLedger {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const marked = this.mark(mode, price);

    // The day's anchor is written the first time the day is evaluated. Until
    // the mark is complete there is nothing trustworthy to anchor, and the
    // engine then sees a zero unrealized move, which lets no gain offset a
    // realized loss. Without an anchor at all, every open gain, including
    // gains from earlier days, would offset today's losses.
    let startRow = this.#db
      .prepare<[Mode, number], { unrealized_at_start_usd: string }>(
        'SELECT unrealized_at_start_usd FROM ledger_days WHERE mode = ? AND day_start_utc_ms = ?',
      )
      .get(mode, dayStart);
    if (startRow === undefined && marked.unrealizedPnlUsd !== null) {
      this.recordDayStart(mode, marked.unrealizedPnlUsd, now);
      startRow = { unrealized_at_start_usd: marked.unrealizedPnlUsd };
    }

    const positions: RiskPosition[] = marked.positions.map((position) => ({
      chain: position.chain,
      token: position.token,
      amount: position.amount,
      costBasisUsd: position.costBasisUsd,
      openedAt: Date.parse(position.openedAt),
    }));

    return {
      dayStartUtcMs: dayStart,
      deployedUsd: marked.deployedUsd,
      realizedPnlTodayUsd: marked.realizedPnlTodayUsd,
      unrealizedPnlUsd: marked.unrealizedPnlUsd ?? '0',
      unrealizedPnlAtDayStartUsd:
        startRow?.unrealized_at_start_usd ?? marked.unrealizedPnlUsd ?? '0',
      positions,
      lpRebalancesToday: {},
    };
  }
}

interface PositionRow {
  id: string;
  mode: Mode;
  chain: ChainId;
  token: string;
  decimals: number;
  amount: string;
  cost_basis_usd: string;
  opened_at: string;
  updated_at: string;
}

function toPosition(row: PositionRow): Position {
  return {
    id: row.id,
    mode: row.mode,
    chain: row.chain,
    token: row.token,
    decimals: row.decimals,
    amount: row.amount,
    costBasisUsd: row.cost_basis_usd,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
  };
}

/** Registry-listed stablecoins count as quote assets for deployment purposes. */
function isStable(chain: ChainId, token: string): boolean {
  return isStablecoin(chain, token);
}
