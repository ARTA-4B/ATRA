import { randomUUID } from 'node:crypto';
import type { Db, SqlValue } from '../db/database.js';
import type { ChainId } from '../chains/registry.js';
import type { LpSnapshot, Mode } from '../risk/types.js';
import { lpPoolKey } from '../risk/types.js';
import { amountToBigint, microsToUsd, usdToMicros } from '../risk/money.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import type { LpRecordedAction } from './types.js';
// The pool's own tick bounds, not a copy of them: a range this store accepts
// is a range the chain would accept.
import { MAX_TICK, MIN_TICK } from './evm/tick-math.js';

/**
 * The LP ledger: positions, the append-only action log, rebalance counts and
 * the automation switch.
 *
 * PAPER and LIVE positions never share a row. Amounts are base-unit strings;
 * `capitalUsd` is the cost basis in USD, so the difference between a mark and
 * the cost basis is the position's unrealized result, impermanent loss
 * included. Nothing here estimates: a position that has never been observed
 * by a cycle has a null mark, not a stale or invented one.
 */

export interface LpPositionRecord {
  id: string;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  poolId: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  lpTokens: string;
  amount0: string;
  amount1: string;
  capitalUsd: string;
  openedAt: string;
  lastAction: LpRecordedAction;
  lastActionAt: string;
  lastRebalanceAt: string | null;
  mark: {
    valueUsd: string | null;
    feesUsd: string | null;
    note: string | null;
    markedAt: string | null;
  };
}

export interface LpActionRecord {
  id: string;
  cycleId: string;
  tradeId: string | null;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  poolId: string;
  action: LpRecordedAction;
  status: 'hold' | 'rejected' | 'filled' | 'failed';
  txHash: string | null;
  lpTokens: string | null;
  amount0: string | null;
  amount1: string | null;
  feeUsd: string | null;
  capitalUsd: string | null;
  note: string;
  at: string;
}

export interface RecordActionInput {
  cycleId: string;
  tradeId?: string | null;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  poolId: string;
  action: LpRecordedAction;
  status: LpActionRecord['status'];
  txHash?: string | null;
  lpTokens?: string | null;
  amount0?: string | null;
  amount1?: string | null;
  feeUsd?: string | null;
  capitalUsd?: string | null;
  note: string;
}

export interface BookAddInput {
  mode: Mode;
  chain: ChainId;
  protocol: string;
  poolId: string;
  token0: { address: string; decimals: number };
  token1: { address: string; decimals: number };
  lpTokens: string;
  amount0: string;
  amount1: string;
  /** USD paid in, decimal string. */
  capitalUsd: string;
  at: number;
  rebalance?: boolean;
}

export interface BookRemoveInput {
  mode: Mode;
  chain: ChainId;
  protocol: string;
  poolId: string;
  lpTokens: string;
  at: number;
}

/**
 * The three things that move a range position's liquidity. Narrowed from the
 * dashboard's vocabulary rather than invented beside it, so a range row and an
 * `lp_actions` row still speak the same language; a HOLD or a fee claim never
 * changes what a position holds and so is never one of these.
 */
export type LpRangeAction = Extract<LpRecordedAction, 'ADD' | 'REMOVE' | 'EXIT'>;

/**
 * One concentrated-liquidity position NFT.
 *
 * The sibling of `LpPositionRecord`, with the three differences that make a v3
 * position a different animal: it is keyed by `tokenId` rather than by pool,
 * it carries a tick range, and it holds no amounts — what a range position is
 * made of depends on where the price is, so the amounts live in `mark` with
 * the time they were observed. `liquidity` of '0' is a closed position, and
 * the row stays to say so.
 */
export interface LpRangePositionRecord {
  id: string;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  poolId: string;
  tokenId: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  /** The raw uint24 fee, in hundredths of a basis point (500 = 0.05%). */
  feePips: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  /** Cost basis in micro-USD. */
  capitalUsd: bigint;
  openedAt: string;
  lastAction: LpRangeAction;
  lastActionAt: string;
  closedAt: string | null;
  mark: {
    valueUsd: bigint | null;
    feesUsd: bigint | null;
    amount0: string | null;
    amount1: string | null;
    inRange: boolean | null;
    poolTick: number | null;
    note: string | null;
    markedAt: string | null;
  };
}

/** One recorded change to a position's liquidity, from `lp_range_events`. */
export interface LpRangeEventRecord {
  id: string;
  positionId: string;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  poolId: string;
  tokenId: string;
  action: LpRangeAction;
  /** Signed, in liquidity units: negative burns. */
  liquidityDelta: string;
  liquidityAfter: string;
  /** Signed micro-USD: positive was paid in, negative was released. */
  capitalDeltaUsd: bigint;
  capitalAfterUsd: bigint;
  at: string;
}

/**
 * The half of a range fill this store cannot work out for itself.
 *
 * Cost basis is this layer's own arithmetic and it releases the right amount
 * unaided, but what the chain actually handed back and what the gas cost are
 * facts only the executor that sent the transaction holds. They are demanded
 * rather than defaulted to zero because a defaulted zero is the bug this type
 * exists to prevent: an exit whose impermanent loss and gas are booked as
 * nothing still passes `loss.daily`, and the next entry sails through the cap
 * — which is precisely what migration 007 was written to stop for v2.
 */
export interface RangeRealizedInput {
  tradeId?: string | null;
  /**
   * Micro-USD the burn returned, at the prices the fill used. Zero for a mint
   * or an increase, which hand nothing back.
   */
  proceedsUsd: bigint;
  /** Micro-USD of gas. Always a cost, never a credit. */
  feeUsd: bigint;
  /** Whether this was a simulated fill, as `lp_pnl.simulated` records it. */
  simulated: boolean;
}

export interface OpenRangePositionInput {
  mode: Mode;
  chain: ChainId;
  protocol: string;
  poolId: string;
  tokenId: string;
  token0: { address: string; decimals: number };
  token1: { address: string; decimals: number };
  feePips: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  /** Micro-USD paid in. */
  capitalUsd: bigint;
  /**
   * The token id this mint replaces, when it is the second half of a
   * rebalance. Present makes the mint count against `maxRebalancePerDay` and
   * books it as a REBALANCE; absent is an ordinary entry.
   */
  rebalancedFrom?: string;
  realized: RangeRealizedInput;
  at: number;
}

export interface AdjustRangePositionInput {
  mode: Mode;
  chain: ChainId;
  protocol: string;
  tokenId: string;
  /** Positive mints liquidity, negative burns it. Never zero. */
  liquidityDelta: bigint;
  /** Micro-USD paid in. Only an increase pays anything in. */
  capitalUsd?: bigint;
  realized: RangeRealizedInput;
  at: number;
}

export interface CloseRangePositionInput {
  mode: Mode;
  chain: ChainId;
  protocol: string;
  tokenId: string;
  realized: RangeRealizedInput;
  at: number;
}

export interface RangeAdjustResult {
  /**
   * Always present, unlike `bookRemove`'s: a range position that has been
   * fully burned is a row with zero liquidity and a `closedAt`, not an absence.
   */
  position: LpRangePositionRecord;
  /** Micro-USD of cost basis the burn released; zero for an increase. */
  costReleasedUsd: bigint;
  closed: boolean;
  /** Micro-USD realized, as written to `lp_pnl`: proceeds less basis less gas. */
  realizedPnlUsd: bigint;
}

/** What a cycle observed about a range position. Every field is dated by `at`. */
export interface RangeMarkInput {
  valueUsd: bigint | null;
  feesUsd: bigint | null;
  amount0: string | null;
  amount1: string | null;
  /** Whether the pool's tick was inside the range when it was read. */
  inRange: boolean | null;
  poolTick: number | null;
  note: string | null;
  at: number;
}

export interface RecordPnlInput {
  tradeId?: string | null;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  poolId: string;
  action: LpRecordedAction;
  /** Micro-USD returned by the burn, at fill-time prices. Zero for an add. */
  proceedsUsd: bigint;
  /** Micro-USD of cost basis the burn released, from `bookRemove`. Zero for an add. */
  costReleasedUsd: bigint;
  /** Micro-USD of gas, always a cost. */
  feeUsd: bigint;
  at: number;
  simulated: boolean;
}

export interface LpSchedulerRow {
  enabled: boolean;
  intervalSeconds: number;
  lastCycleId: string | null;
  lastCycleAt: string | null;
  lastCycleStatus: string | null;
}

export class LiquidityStore {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #log = childLogger('lp-store');

  constructor(db: Db, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
    this.#ensureSchedulerRow();
  }

  /**
   * Run `fn` as one write.
   *
   * An LP fill is several rows — a balance, a position, the realized figure —
   * and an executor that writes them one at a time can be interrupted between
   * them, leaving assets spent with nothing booked. Nested calls reuse the
   * outer transaction, so the methods below still work unchanged inside one.
   */
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  // --- positions -----------------------------------------------------------

  listPositions(mode: Mode): LpPositionRecord[] {
    return this.#db
      .prepare<[Mode], PositionRow>('SELECT * FROM lp_positions WHERE mode = ? ORDER BY opened_at')
      .all(mode)
      .map(toPosition);
  }

  getPosition(
    mode: Mode,
    chain: ChainId,
    protocol: string,
    poolId: string,
  ): LpPositionRecord | undefined {
    const row = this.#db
      .prepare<[Mode, string, string, string], PositionRow>(
        'SELECT * FROM lp_positions WHERE mode = ? AND chain = ? AND protocol = ? AND pool_id = ?',
      )
      .get(mode, chain, protocol, poolId);
    return row ? toPosition(row) : undefined;
  }

  /** Open or add to a position at what was paid. Average cost basis. */
  bookAdd(input: BookAddInput): LpPositionRecord {
    const at = new Date(input.at).toISOString();
    const added = amountToBigint(input.lpTokens);
    if (added <= 0n) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'An LP add must mint a positive amount');
    }
    const action: LpRecordedAction = input.rebalance ? 'REBALANCE' : 'ADD';

    const write = this.#db.transaction(() => {
      const existing = this.getPosition(input.mode, input.chain, input.protocol, input.poolId);
      if (!existing) {
        this.#db
          .prepare(
            'INSERT INTO lp_positions (id, mode, chain, protocol, pool_id, token0, token1,' +
              ' decimals0, decimals1, lp_tokens, amount0, amount1, capital_usd, opened_at,' +
              ' last_action, last_action_at, last_rebalance_at)' +
              ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            input.mode,
            input.chain,
            input.protocol,
            input.poolId,
            input.token0.address,
            input.token1.address,
            input.token0.decimals,
            input.token1.decimals,
            input.lpTokens,
            input.amount0,
            input.amount1,
            microsToUsd(usdToMicros(input.capitalUsd)),
            at,
            action,
            at,
            input.rebalance ? at : null,
          );
      } else {
        this.#db
          .prepare(
            'UPDATE lp_positions SET lp_tokens = ?, amount0 = ?, amount1 = ?, capital_usd = ?,' +
              ' last_action = ?, last_action_at = ?, last_rebalance_at = COALESCE(?, last_rebalance_at)' +
              ' WHERE id = ?',
          )
          .run(
            (amountToBigint(existing.lpTokens) + added).toString(),
            (amountToBigint(existing.amount0) + amountToBigint(input.amount0)).toString(),
            (amountToBigint(existing.amount1) + amountToBigint(input.amount1)).toString(),
            microsToUsd(usdToMicros(existing.capitalUsd) + usdToMicros(input.capitalUsd)),
            action,
            at,
            input.rebalance ? at : null,
            existing.id,
          );
      }
      if (input.rebalance) this.#countRebalance(input.mode, input.chain, input.poolId, input.at);
      return this.getPosition(input.mode, input.chain, input.protocol, input.poolId)!;
    });
    return write();
  }

  /**
   * Burn LP tokens from a position. Returns the cost basis released, in
   * micro-USD (rounded up, the conservative direction for realized profit),
   * and the amounts the position was carrying for that share.
   */
  bookRemove(input: BookRemoveInput): {
    position: LpPositionRecord | undefined;
    costReleasedUsd: bigint;
    closed: boolean;
  } {
    const at = new Date(input.at).toISOString();
    const burned = amountToBigint(input.lpTokens);
    const write = this.#db.transaction(() => {
      const existing = this.getPosition(input.mode, input.chain, input.protocol, input.poolId);
      if (!existing) {
        throw new AppError(ErrorCode.CONFLICT, 'No LP position to remove from', {
          details: { chain: input.chain, poolId: input.poolId },
        });
      }
      const held = amountToBigint(existing.lpTokens);
      if (burned <= 0n || burned > held) {
        throw new AppError(ErrorCode.CONFLICT, 'Removal exceeds the LP position', {
          details: { held: held.toString(), burned: burned.toString() },
        });
      }
      const basis = usdToMicros(existing.capitalUsd);
      const costReleased = (basis * burned + held - 1n) / held;
      const remaining = held - burned;

      if (remaining === 0n) {
        this.#db.prepare('DELETE FROM lp_positions WHERE id = ?').run(existing.id);
        return { position: undefined, costReleasedUsd: costReleased, closed: true };
      }

      const amount0 = amountToBigint(existing.amount0);
      const amount1 = amountToBigint(existing.amount1);
      this.#db
        .prepare(
          'UPDATE lp_positions SET lp_tokens = ?, amount0 = ?, amount1 = ?, capital_usd = ?,' +
            " last_action = 'REMOVE', last_action_at = ? WHERE id = ?",
        )
        .run(
          remaining.toString(),
          ((amount0 * remaining) / held).toString(),
          ((amount1 * remaining) / held).toString(),
          microsToUsd(basis - costReleased),
          at,
          existing.id,
        );
      return {
        position: this.getPosition(input.mode, input.chain, input.protocol, input.poolId),
        costReleasedUsd: costReleased,
        closed: false,
      };
    });
    return write();
  }

  /** Record a fee claim on the position row (no amounts change). */
  touchClaim(mode: Mode, chain: ChainId, protocol: string, poolId: string, at: number): void {
    this.#db
      .prepare(
        "UPDATE lp_positions SET last_action = 'COLLECT_FEES', last_action_at = ?" +
          ' WHERE mode = ? AND chain = ? AND protocol = ? AND pool_id = ?',
      )
      .run(new Date(at).toISOString(), mode, chain, protocol, poolId);
  }

  /** Store what a cycle observed, so the dashboard shows a dated value. */
  mark(
    mode: Mode,
    chain: ChainId,
    protocol: string,
    poolId: string,
    mark: { valueUsd: string | null; feesUsd: string | null; note: string | null; at: number },
  ): void {
    this.#db
      .prepare(
        'UPDATE lp_positions SET mark_value_usd = ?, mark_fees_usd = ?, mark_note = ?, marked_at = ?' +
          ' WHERE mode = ? AND chain = ? AND protocol = ? AND pool_id = ?',
      )
      .run(
        mark.valueUsd,
        mark.feesUsd,
        mark.note,
        new Date(mark.at).toISOString(),
        mode,
        chain,
        protocol,
        poolId,
      );
  }

  // --- range positions -----------------------------------------------------

  /**
   * The v3 family: one row per position NFT, in `lp_range_positions`.
   *
   * These methods are siblings of `bookAdd`/`bookRemove`/`getPosition`/
   * `listPositions` and never touch their tables. The cost-basis arithmetic is
   * deliberately the same — average cost in, pro-rata out, rounded up so a
   * burn can only under-report profit — because the difference between a v2
   * and a v3 position is what it is made of, not how it is paid for.
   *
   * Every path that moves liquidity also writes the `lp_pnl` row for it, in
   * the same transaction, from the `realized` block its caller must supply.
   * That is not convenience: the daily-loss cap reads `lp_pnl` and nothing
   * else, so a v3 exit booked without one is a loss the engine cannot see.
   *
   * Nothing here builds, signs or values anything: an executor writes what it
   * already did, and a cycle writes what it already read.
   */

  /** Open positions for a mode, oldest first. Closed ones on request. */
  listRangePositions(
    mode: Mode,
    options: { includeClosed?: boolean } = {},
  ): LpRangePositionRecord[] {
    const sql = options.includeClosed
      ? 'SELECT * FROM lp_range_positions WHERE mode = ? ORDER BY opened_at, rowid'
      : 'SELECT * FROM lp_range_positions WHERE mode = ? AND closed_at IS NULL' +
        ' ORDER BY opened_at, rowid';
    return this.#db.prepare<[Mode], RangePositionRow>(sql).all(mode).map(toRangePosition);
  }

  /**
   * One position by its token id.
   *
   * Keyed by tokenId rather than by pool because the pool does not identify a
   * v3 position: several live in the same pool at once, which is the whole
   * reason `getPosition`'s key could not be reused.
   */
  getRangePosition(
    mode: Mode,
    chain: ChainId,
    protocol: string,
    tokenId: string,
  ): LpRangePositionRecord | undefined {
    const row = this.#db
      .prepare<[Mode, string, string, string], RangePositionRow>(
        'SELECT * FROM lp_range_positions WHERE mode = ? AND chain = ? AND protocol = ?' +
          ' AND token_id = ?',
      )
      .get(mode, chain, protocol, canonicalTokenId(tokenId));
    return row ? toRangePosition(row) : undefined;
  }

  /** Every open position in one pool. The v3 answer to `getPosition`. */
  listPoolRangePositions(
    mode: Mode,
    chain: ChainId,
    protocol: string,
    poolId: string,
    options: { includeClosed?: boolean } = {},
  ): LpRangePositionRecord[] {
    const base =
      'SELECT * FROM lp_range_positions WHERE mode = ? AND chain = ? AND protocol = ?' +
      ' AND pool_id = ?';
    const sql = options.includeClosed
      ? `${base} ORDER BY opened_at, rowid`
      : `${base} AND closed_at IS NULL ORDER BY opened_at, rowid`;
    return this.#db
      .prepare<[Mode, string, string, string], RangePositionRow>(sql)
      .all(mode, chain, protocol, poolId)
      .map(toRangePosition);
  }

  /**
   * Book a newly minted position NFT at what was paid for it.
   *
   * Unlike `bookAdd` this refuses a token id it has already booked instead of
   * adding to it: an ERC-721 is minted once, so a second open for the same id
   * is two rows' worth of capital claiming one position. Adding to a position
   * that exists is `adjustRangePosition`.
   *
   * `rebalancedFrom` names the position this one replaces, and is the only
   * thing that makes a v3 rebalance countable; see `#countRangeRebalance`.
   */
  openRangePosition(input: OpenRangePositionInput): LpRangePositionRecord {
    const at = new Date(input.at).toISOString();
    const tokenId = canonicalTokenId(input.tokenId);
    const liquidity = amountToBigint(input.liquidity);
    assertRealized(input.realized, false);
    if (liquidity <= 0n) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        'A range position must open with positive liquidity',
      );
    }
    if (input.capitalUsd < 0n) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        'A range position cost basis cannot be negative',
      );
    }
    assertFeePips(input.feePips);
    assertTickRange(input.tickLower, input.tickUpper);

    const write = this.#db.transaction(() => {
      const existing = this.getRangePosition(input.mode, input.chain, input.protocol, tokenId);
      if (existing) {
        throw new AppError(ErrorCode.CONFLICT, 'That range position is already booked', {
          details: { chain: input.chain, protocol: input.protocol, tokenId },
        });
      }
      const replaced = this.#resolveRebalancedFrom(input, tokenId);
      this.#db
        .prepare(
          'INSERT INTO lp_range_positions (id, mode, chain, protocol, pool_id, token_id, token0,' +
            ' token1, decimals0, decimals1, fee_pips, tick_lower, tick_upper, liquidity,' +
            ' capital_usd, opened_at, last_action, last_action_at, closed_at)' +
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ADD', ?, NULL)",
        )
        .run(
          randomUUID(),
          input.mode,
          input.chain,
          input.protocol,
          input.poolId,
          tokenId,
          input.token0.address,
          input.token1.address,
          input.token0.decimals,
          input.token1.decimals,
          input.feePips,
          input.tickLower,
          input.tickUpper,
          liquidity.toString(),
          microsToUsd(input.capitalUsd),
          at,
          at,
        );
      const position = this.getRangePosition(input.mode, input.chain, input.protocol, tokenId)!;
      this.#recordRangeEvent(position, 'ADD', liquidity, input.capitalUsd, at);
      if (replaced) this.#countRangeRebalance(position, replaced, input.at, at);
      // An entry realizes nothing but its gas, exactly as an opening swap
      // realizes only its fee. A rebalance's gas belongs to the rebalance.
      this.#recordRangePnl(position, replaced ? 'REBALANCE' : 'ADD', 0n, input.realized, input.at);
      return position;
    });
    return write();
  }

  /**
   * The position a mint says it replaces, or nothing when it replaces none.
   *
   * Refuses a token id this ledger has never booked rather than recording a
   * link that dangles: a burn the store did not book is a burn it cannot have
   * released cost basis for, so an executor claiming one is an executor whose
   * books are already wrong. It does not require the old position to be closed
   * first — minting the new range before withdrawing the old one is a
   * perfectly ordinary way round, and refusing it would push the executor into
   * the ordering that leaves it out of the market for longer.
   */
  #resolveRebalancedFrom(
    input: OpenRangePositionInput,
    tokenId: string,
  ): LpRangePositionRecord | undefined {
    if (input.rebalancedFrom === undefined) return undefined;
    const from = canonicalTokenId(input.rebalancedFrom);
    if (from === tokenId) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        'A rebalance replaces one position with another, not with itself',
        { details: { tokenId } },
      );
    }
    const replaced = this.getRangePosition(input.mode, input.chain, input.protocol, from);
    if (!replaced) {
      throw new AppError(ErrorCode.CONFLICT, 'No range position to rebalance out of', {
        details: { chain: input.chain, protocol: input.protocol, tokenId: from },
      });
    }
    return replaced;
  }

  /**
   * Mint more liquidity into a booked position, or burn some of it.
   *
   * A positive delta adds `capitalUsd` to the basis; a negative one releases
   * the basis pro rata, rounded up, exactly as `bookRemove` does. A decrease
   * pays nothing in, so passing capital with one is refused rather than
   * quietly ignored — that combination is a caller confusing proceeds (which
   * this layer does not record) with cost.
   *
   * A position burned to zero stays as a row: `closed` says what happened and
   * the row's `closedAt` dates it. The chain allows increasing such a position
   * again as long as its NFT was never burned, so an increase after a close
   * re-opens the same row rather than refusing what the chain would permit.
   */
  adjustRangePosition(input: AdjustRangePositionInput): RangeAdjustResult {
    const at = new Date(input.at).toISOString();
    const tokenId = canonicalTokenId(input.tokenId);
    const delta = input.liquidityDelta;
    const capital = input.capitalUsd ?? 0n;
    if (delta === 0n) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'A range adjustment must move liquidity');
    }
    if (capital < 0n) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        'A range position cost basis cannot be negative',
      );
    }
    if (delta < 0n && capital !== 0n) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        'A decrease pays no capital in; it releases cost basis instead',
      );
    }
    assertRealized(input.realized, delta < 0n);

    const write = this.#db.transaction(() => {
      const existing = this.getRangePosition(input.mode, input.chain, input.protocol, tokenId);
      if (!existing) {
        throw new AppError(ErrorCode.CONFLICT, 'No range position to adjust', {
          details: { chain: input.chain, protocol: input.protocol, tokenId },
        });
      }
      const held = amountToBigint(existing.liquidity);
      if (delta < 0n && -delta > held) {
        throw new AppError(ErrorCode.CONFLICT, 'Decrease exceeds the range position', {
          details: { held: held.toString(), burned: (-delta).toString() },
        });
      }
      const remaining = held + delta;
      const basis = existing.capitalUsd;
      const costReleased = delta < 0n ? (basis * -delta + held - 1n) / held : 0n;
      const nextBasis = delta > 0n ? basis + capital : basis - costReleased;
      const action: LpRangeAction = delta > 0n ? 'ADD' : remaining === 0n ? 'EXIT' : 'REMOVE';

      this.#db
        .prepare(
          'UPDATE lp_range_positions SET liquidity = ?, capital_usd = ?, last_action = ?,' +
            ' last_action_at = ?, closed_at = ? WHERE id = ?',
        )
        .run(
          remaining.toString(),
          microsToUsd(nextBasis),
          action,
          at,
          remaining === 0n ? at : null,
          existing.id,
        );

      const position = this.getRangePosition(input.mode, input.chain, input.protocol, tokenId)!;
      this.#recordRangeEvent(position, action, delta, delta > 0n ? capital : -costReleased, at);
      const realizedPnlUsd = this.#recordRangePnl(
        position,
        action,
        costReleased,
        input.realized,
        input.at,
      );
      return { position, costReleasedUsd: costReleased, closed: remaining === 0n, realizedPnlUsd };
    });
    return write();
  }

  /** Burn everything the position still holds, releasing the whole basis. */
  closeRangePosition(input: CloseRangePositionInput): RangeAdjustResult {
    const tokenId = canonicalTokenId(input.tokenId);
    const write = this.#db.transaction(() => {
      const existing = this.getRangePosition(input.mode, input.chain, input.protocol, tokenId);
      if (!existing) {
        throw new AppError(ErrorCode.CONFLICT, 'No range position to close', {
          details: { chain: input.chain, protocol: input.protocol, tokenId },
        });
      }
      const held = amountToBigint(existing.liquidity);
      if (held === 0n) {
        throw new AppError(ErrorCode.CONFLICT, 'That range position is already closed', {
          details: { chain: input.chain, protocol: input.protocol, tokenId },
        });
      }
      return this.adjustRangePosition({
        mode: input.mode,
        chain: input.chain,
        protocol: input.protocol,
        tokenId,
        liquidityDelta: -held,
        realized: input.realized,
        at: input.at,
      });
    });
    return write();
  }

  /**
   * Store what a cycle observed about a range position.
   *
   * The v3 sibling of `mark`, and it carries more because a range position is
   * worth explaining: the amounts it currently consists of and whether the
   * pool's tick was inside the range — an out-of-range position is one-sided
   * and earning nothing, which a USD value alone never shows. Nothing is
   * estimated here either: an unobserved position keeps its null mark.
   */
  markRangePosition(
    mode: Mode,
    chain: ChainId,
    protocol: string,
    tokenId: string,
    mark: RangeMarkInput,
  ): void {
    this.#db
      .prepare(
        'UPDATE lp_range_positions SET mark_value_usd = ?, mark_fees_usd = ?, mark_amount0 = ?,' +
          ' mark_amount1 = ?, mark_in_range = ?, mark_pool_tick = ?, mark_note = ?, marked_at = ?' +
          ' WHERE mode = ? AND chain = ? AND protocol = ? AND token_id = ?',
      )
      .run(
        mark.valueUsd === null ? null : microsToUsd(mark.valueUsd),
        mark.feesUsd === null ? null : microsToUsd(mark.feesUsd),
        mark.amount0,
        mark.amount1,
        mark.inRange === null ? null : mark.inRange ? 1 : 0,
        mark.poolTick,
        mark.note,
        new Date(mark.at).toISOString(),
        mode,
        chain,
        protocol,
        canonicalTokenId(tokenId),
      );
  }

  /** The append-only trail behind the rows above, newest first. */
  listRangeEvents(
    options: { mode?: Mode; tokenId?: string; limit?: number } = {},
  ): LpRangeEventRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (options.mode) {
      clauses.push('mode = ?');
      params.push(options.mode);
    }
    if (options.tokenId !== undefined) {
      clauses.push('token_id = ?');
      params.push(canonicalTokenId(options.tokenId));
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.#db
      .prepare<SqlValue[], RangeEventRow>(
        `SELECT * FROM lp_range_events${where} ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map(toRangeEvent);
  }

  /**
   * Write the audit row for a change that has already been applied.
   *
   * Takes the position as it now stands rather than recomputing anything, so
   * the `*_after` columns are the row itself and a later disagreement between
   * the log and the position is real evidence, not a second opinion.
   */
  #recordRangeEvent(
    position: LpRangePositionRecord,
    action: LpRangeAction,
    liquidityDelta: bigint,
    capitalDeltaUsd: bigint,
    at: string,
  ): void {
    this.#db
      .prepare(
        'INSERT INTO lp_range_events (id, position_id, mode, chain, protocol, pool_id, token_id,' +
          ' action, liquidity_delta, liquidity_after, capital_delta_usd, capital_after_usd, at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        position.id,
        position.mode,
        position.chain,
        position.protocol,
        position.poolId,
        position.tokenId,
        action,
        liquidityDelta.toString(),
        position.liquidity,
        microsToUsd(capitalDeltaUsd),
        microsToUsd(position.capitalUsd),
        at,
      );
    this.#log.debug(
      { tokenId: position.tokenId, action, liquidityDelta: liquidityDelta.toString() },
      'range position change recorded',
    );
  }

  /**
   * The `lp_pnl` row belonging to a range change this store has just applied.
   *
   * Private, and reached from every path that moves a range position's
   * liquidity, so there is no arrangement of calls that books a v3 fill
   * without one. The store fills in everything it knows from the row it has in
   * hand — mode, chain, protocol, pool, which of ADD/REMOVE/EXIT this was, and
   * the cost basis it just released — and the caller supplies only the two
   * figures the chain told it. `recordPnl` is reached unchanged, which is what
   * puts the figure in front of `loss.daily`.
   */
  #recordRangePnl(
    position: LpRangePositionRecord,
    action: LpRecordedAction,
    costReleasedUsd: bigint,
    realized: RangeRealizedInput,
    at: number,
  ): bigint {
    return this.recordPnl({
      tradeId: realized.tradeId ?? null,
      mode: position.mode,
      chain: position.chain,
      protocol: position.protocol,
      poolId: position.poolId,
      action,
      proceedsUsd: realized.proceedsUsd,
      costReleasedUsd,
      feeUsd: realized.feeUsd,
      at,
      simulated: realized.simulated,
    });
  }

  // --- realized P&L --------------------------------------------------------

  /**
   * Record what an LP fill realized, and return the figure in micro-USD.
   *
   * This is the LP half of "how much have I lost today":
   * `LedgerService.realizedPnlTodayUsd` sums `lp_pnl` alongside `fills`, so an
   * LP exit's impermanent loss and every LP action's gas reach the daily-loss
   * cap. Without a row here an LP loss is invisible to the engine, whatever
   * the audit trail says about it.
   *
   * Realized is proceeds minus the cost basis released minus the fee, in
   * micro-USD throughout. An add releases no basis and returns no proceeds, so
   * it realizes its gas as a loss — the same treatment `recordFill` gives a
   * swap fee on an opening trade.
   */
  recordPnl(input: RecordPnlInput): bigint {
    const realized = input.proceedsUsd - input.costReleasedUsd - input.feeUsd;
    const at = new Date(input.at).toISOString();

    this.#db
      .prepare(
        'INSERT INTO lp_pnl (id, trade_id, mode, chain, protocol, pool_id, action, proceeds_usd,' +
          ' cost_released_usd, fee_usd, realized_pnl_usd, at, simulated)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        input.tradeId ?? null,
        input.mode,
        input.chain,
        input.protocol,
        input.poolId,
        input.action,
        microsToUsd(input.proceedsUsd),
        microsToUsd(input.costReleasedUsd),
        microsToUsd(input.feeUsd),
        microsToUsd(realized),
        at,
        input.simulated ? 1 : 0,
      );

    this.#log.debug(
      { mode: input.mode, action: input.action, realizedUsd: microsToUsd(realized) },
      'lp realized p&l recorded',
    );
    return realized;
  }

  // --- rebalances ----------------------------------------------------------

  rebalancesToday(mode: Mode, chain: ChainId, poolId: string, now: number = this.#now()): number {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const row = this.#db
      .prepare<[Mode, string, string, number], { count: number }>(
        'SELECT count FROM lp_rebalances WHERE mode = ? AND chain = ? AND pool_id = ? AND day_start_utc_ms = ?',
      )
      .get(mode, chain, poolId, dayStart);
    return row?.count ?? 0;
  }

  #countRebalance(mode: Mode, chain: ChainId, poolId: string, now: number): void {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    this.#db
      .prepare(
        'INSERT INTO lp_rebalances (mode, chain, pool_id, day_start_utc_ms, count, updated_at)' +
          ' VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(mode, chain, pool_id, day_start_utc_ms)' +
          ' DO UPDATE SET count = count + 1, updated_at = excluded.updated_at',
      )
      .run(mode, chain, poolId, dayStart, new Date(now).toISOString());
  }

  /**
   * v3 rebalances counted against one pool today. The sibling of
   * `rebalancesToday`, and deliberately a second figure rather than an
   * addition to the first: `lp_rebalances` goes on meaning exactly what it has
   * always meant, and the two are added in `toRiskSnapshot`, which is the one
   * place the engine reads.
   */
  rangeRebalancesToday(
    mode: Mode,
    chain: ChainId,
    poolId: string,
    now: number = this.#now(),
  ): number {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const row = this.#db
      .prepare<[Mode, string, string, number], { count: number }>(
        'SELECT COUNT(*) AS count FROM lp_range_rebalances WHERE mode = ? AND chain = ?' +
          ' AND pool_id = ? AND day_start_utc_ms = ?',
      )
      .get(mode, chain, poolId, dayStart);
    return row?.count ?? 0;
  }

  /**
   * Record the mint half of a v3 rebalance, which is the whole of it.
   *
   * A v3 position cannot be moved: its tick range is fixed at mint, so a
   * rebalance burns one tokenId and mints another — one operator decision
   * expressed as two transactions against two positions. Counting both halves
   * would halve `maxRebalancePerDay` without ever telling the operator their
   * limit had changed. Counting the burn would charge a rebalance to a run
   * that burned and then failed to mint, leaving the operator out of the
   * market *and* out of a rebalance they never got. So the pair counts once,
   * at the mint, where the new exposure appears — which is also where v2
   * counts it, `bookAdd({ rebalance: true })`, so a pool's daily figure means
   * the same thing whichever family of position it holds.
   *
   * It lands on the *new* position's pool, so a rebalance into another fee
   * tier counts against the pool the operator now stands in.
   */
  #countRangeRebalance(
    opened: LpRangePositionRecord,
    replaced: LpRangePositionRecord,
    now: number,
    at: string,
  ): void {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    this.#db
      .prepare(
        'INSERT INTO lp_range_rebalances (id, mode, chain, protocol, pool_id, closed_token_id,' +
          ' opened_token_id, closed_position_id, opened_position_id, day_start_utc_ms, at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        opened.mode,
        opened.chain,
        opened.protocol,
        opened.poolId,
        replaced.tokenId,
        opened.tokenId,
        replaced.id,
        opened.id,
        dayStart,
        at,
      );
    this.#log.debug(
      { tokenId: opened.tokenId, replaced: replaced.tokenId, poolId: opened.poolId },
      'range rebalance counted',
    );
  }

  /**
   * Today's v3 rebalances per pool, read from the rows rather than from the
   * positions: a range that was rebalanced and then exited on the same day is
   * still a rebalance that happened, and counting off the open positions would
   * let a pool's figure fall back to zero the moment it holds nothing.
   */
  #rangeRebalanceCountsToday(mode: Mode, now: number): RangeRebalanceCountRow[] {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    return this.#db
      .prepare<[Mode, number], RangeRebalanceCountRow>(
        'SELECT chain, pool_id, COUNT(*) AS count FROM lp_range_rebalances' +
          ' WHERE mode = ? AND day_start_utc_ms = ? GROUP BY chain, pool_id',
      )
      .all(mode, dayStart);
  }

  /**
   * The LP slice of the risk snapshot for one mode.
   *
   * Both families' capital, because `deployed.total` is a cap on the
   * operator's money and money in a range position is money at risk. A
   * snapshot that reported `lp_positions` alone would let a v3 book breach
   * `maxTotalDeployedUsd` by the whole of its own size without anything
   * noticing.
   *
   * `positions` stays v2-only on purpose, and that is not an oversight. The
   * engine reads `lpTokens` out of it to judge a burn against what is held,
   * and a range position has no LP tokens — its size is liquidity, in units no
   * v2 burn is denominated in — while several of them share one pool key, so
   * there is no single entry that could honestly stand for them. A row written
   * there would make `lp.position` compare a v2 exit against v3 liquidity. The
   * consequence is that the per-pool cap, `lp.maxCapitalPerLpUsd`, still sees
   * only v2; closing that needs a v3-shaped field on `LpSnapshot`, which is
   * the risk engine's vocabulary to extend, not this store's.
   */
  toRiskSnapshot(mode: Mode, now: number = this.#now()): LpSnapshot {
    const positions: LpSnapshot['positions'] = {};
    const rebalancesToday: Record<string, number> = {};
    let deployed = 0n;
    for (const position of this.listPositions(mode)) {
      const key = lpPoolKey(position.chain, position.poolId);
      positions[key] = { lpTokens: position.lpTokens, capitalUsd: position.capitalUsd };
      deployed += usdToMicros(position.capitalUsd);
      const count = this.rebalancesToday(mode, position.chain, position.poolId, now);
      if (count > 0) rebalancesToday[key] = count;
    }
    // Open positions only: a closed one released its whole basis on the way
    // out and is carrying nothing to deploy.
    for (const range of this.listRangePositions(mode)) {
      deployed += range.capitalUsd;
    }
    // Added to the v2 figure rather than maxed with it: a v2 rebalance and a
    // v3 rebalance in one pool on one day are two rebalances, and a limit that
    // took the larger of the two would let a mixed book have both.
    for (const row of this.#rangeRebalanceCountsToday(mode, now)) {
      const key = lpPoolKey(row.chain, row.pool_id);
      rebalancesToday[key] = (rebalancesToday[key] ?? 0) + row.count;
    }
    return { deployedUsd: microsToUsd(deployed), rebalancesToday, positions };
  }

  // --- actions -------------------------------------------------------------

  recordAction(input: RecordActionInput): LpActionRecord {
    const id = randomUUID();
    const at = new Date(this.#now()).toISOString();
    this.#db
      .prepare(
        'INSERT INTO lp_actions (id, cycle_id, trade_id, mode, chain, protocol, pool_id, action,' +
          ' status, tx_hash, lp_tokens, amount0, amount1, fee_usd, capital_usd, note, at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.cycleId,
        input.tradeId ?? null,
        input.mode,
        input.chain,
        input.protocol,
        input.poolId,
        input.action,
        input.status,
        input.txHash ?? null,
        input.lpTokens ?? null,
        input.amount0 ?? null,
        input.amount1 ?? null,
        input.feeUsd ?? null,
        input.capitalUsd ?? null,
        input.note.slice(0, 500),
        at,
      );
    this.#log.debug({ id, action: input.action, status: input.status }, 'lp action recorded');
    return this.getAction(id)!;
  }

  getAction(id: string): LpActionRecord | undefined {
    const row = this.#db
      .prepare<[string], ActionRow>('SELECT * FROM lp_actions WHERE id = ?')
      .get(id);
    return row ? toAction(row) : undefined;
  }

  listActions(options: { mode?: Mode; limit?: number } = {}): LpActionRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    if (options.mode) {
      return this.#db
        .prepare<[Mode, number], ActionRow>(
          'SELECT * FROM lp_actions WHERE mode = ? ORDER BY at DESC, rowid DESC LIMIT ?',
        )
        .all(options.mode, limit)
        .map(toAction);
    }
    return this.#db
      .prepare<[number], ActionRow>('SELECT * FROM lp_actions ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(limit)
      .map(toAction);
  }

  // --- scheduler -----------------------------------------------------------

  scheduler(): LpSchedulerRow {
    const row = this.#db
      .prepare<[], SchedulerRow>('SELECT * FROM lp_scheduler_state WHERE id = 1')
      .get()!;
    return {
      enabled: row.enabled === 1,
      intervalSeconds: row.interval_seconds,
      lastCycleId: row.last_cycle_id,
      lastCycleAt: row.last_cycle_at,
      lastCycleStatus: row.last_cycle_status,
    };
  }

  setScheduler(enabled: boolean, intervalSeconds: number): void {
    this.#db
      .prepare(
        'UPDATE lp_scheduler_state SET enabled = ?, interval_seconds = ?, updated_at = ? WHERE id = 1',
      )
      .run(enabled ? 1 : 0, intervalSeconds, new Date(this.#now()).toISOString());
  }

  disableScheduler(): void {
    this.#db
      .prepare('UPDATE lp_scheduler_state SET enabled = 0, updated_at = ? WHERE id = 1')
      .run(new Date(this.#now()).toISOString());
  }

  recordCycle(cycleId: string, finishedAt: string, status: string): void {
    this.#db
      .prepare(
        'UPDATE lp_scheduler_state SET last_cycle_id = ?, last_cycle_at = ?, last_cycle_status = ?, updated_at = ? WHERE id = 1',
      )
      .run(cycleId, finishedAt, status, new Date(this.#now()).toISOString());
  }

  #ensureSchedulerRow(): void {
    this.#db
      .prepare(
        'INSERT INTO lp_scheduler_state (id, enabled, interval_seconds, updated_at) VALUES (1, 0, 1800, ?)' +
          ' ON CONFLICT(id) DO NOTHING',
      )
      .run(new Date(this.#now()).toISOString());
  }
}

interface PositionRow {
  id: string;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  pool_id: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  lp_tokens: string;
  amount0: string;
  amount1: string;
  capital_usd: string;
  opened_at: string;
  last_action: LpRecordedAction;
  last_action_at: string;
  last_rebalance_at: string | null;
  mark_value_usd: string | null;
  mark_fees_usd: string | null;
  mark_note: string | null;
  marked_at: string | null;
}

interface RangePositionRow {
  id: string;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  pool_id: string;
  token_id: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  fee_pips: number;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  capital_usd: string;
  opened_at: string;
  last_action: LpRangeAction;
  last_action_at: string;
  closed_at: string | null;
  mark_value_usd: string | null;
  mark_fees_usd: string | null;
  mark_amount0: string | null;
  mark_amount1: string | null;
  mark_in_range: number | null;
  mark_pool_tick: number | null;
  mark_note: string | null;
  marked_at: string | null;
}

interface RangeEventRow {
  id: string;
  position_id: string;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  pool_id: string;
  token_id: string;
  action: LpRangeAction;
  liquidity_delta: string;
  liquidity_after: string;
  capital_delta_usd: string;
  capital_after_usd: string;
  at: string;
}

interface RangeRebalanceCountRow {
  chain: ChainId;
  pool_id: string;
  count: number;
}

interface ActionRow {
  id: string;
  cycle_id: string;
  trade_id: string | null;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  pool_id: string;
  action: LpRecordedAction;
  status: LpActionRecord['status'];
  tx_hash: string | null;
  lp_tokens: string | null;
  amount0: string | null;
  amount1: string | null;
  fee_usd: string | null;
  capital_usd: string | null;
  note: string;
  at: string;
}

interface SchedulerRow {
  id: number;
  enabled: number;
  interval_seconds: number;
  last_cycle_id: string | null;
  last_cycle_at: string | null;
  last_cycle_status: string | null;
  updated_at: string;
}

function toPosition(row: PositionRow): LpPositionRecord {
  return {
    id: row.id,
    mode: row.mode,
    chain: row.chain,
    protocol: row.protocol,
    poolId: row.pool_id,
    token0: row.token0,
    token1: row.token1,
    decimals0: row.decimals0,
    decimals1: row.decimals1,
    lpTokens: row.lp_tokens,
    amount0: row.amount0,
    amount1: row.amount1,
    capitalUsd: row.capital_usd,
    openedAt: row.opened_at,
    lastAction: row.last_action,
    lastActionAt: row.last_action_at,
    lastRebalanceAt: row.last_rebalance_at,
    mark: {
      valueUsd: row.mark_value_usd,
      feesUsd: row.mark_fees_usd,
      note: row.mark_note,
      markedAt: row.marked_at,
    },
  };
}

function toRangePosition(row: RangePositionRow): LpRangePositionRecord {
  return {
    id: row.id,
    mode: row.mode,
    chain: row.chain,
    protocol: row.protocol,
    poolId: row.pool_id,
    tokenId: row.token_id,
    token0: row.token0,
    token1: row.token1,
    decimals0: row.decimals0,
    decimals1: row.decimals1,
    feePips: row.fee_pips,
    tickLower: row.tick_lower,
    tickUpper: row.tick_upper,
    liquidity: row.liquidity,
    capitalUsd: usdToMicros(row.capital_usd),
    openedAt: row.opened_at,
    lastAction: row.last_action,
    lastActionAt: row.last_action_at,
    closedAt: row.closed_at,
    mark: {
      valueUsd: row.mark_value_usd === null ? null : usdToMicros(row.mark_value_usd),
      feesUsd: row.mark_fees_usd === null ? null : usdToMicros(row.mark_fees_usd),
      amount0: row.mark_amount0,
      amount1: row.mark_amount1,
      inRange: row.mark_in_range === null ? null : row.mark_in_range === 1,
      poolTick: row.mark_pool_tick,
      note: row.mark_note,
      markedAt: row.marked_at,
    },
  };
}

function toRangeEvent(row: RangeEventRow): LpRangeEventRecord {
  return {
    id: row.id,
    positionId: row.position_id,
    mode: row.mode,
    chain: row.chain,
    protocol: row.protocol,
    poolId: row.pool_id,
    tokenId: row.token_id,
    action: row.action,
    liquidityDelta: row.liquidity_delta,
    liquidityAfter: row.liquidity_after,
    capitalDeltaUsd: usdToMicros(row.capital_delta_usd),
    capitalAfterUsd: usdToMicros(row.capital_after_usd),
    at: row.at,
  };
}

/**
 * A position's token id in one canonical form.
 *
 * It is a uint256 the chain assigned, so it is validated exactly as the
 * base-unit amounts beside it are — digits, no leading zeros — and always
 * stored and looked up in that form. Otherwise '07' and '7' are one position
 * on chain and two rows here.
 */
function canonicalTokenId(tokenId: string): string {
  try {
    return amountToBigint(tokenId).toString();
  } catch (cause) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed position token id', {
      cause,
      details: { tokenId },
    });
  }
}

/**
 * Check a realized block before anything is written against it.
 *
 * `proceedsAllowed` is false on a mint and on an increase, which hand nothing
 * back. Refusing proceeds there rather than ignoring them is the mirror of the
 * refusal a decrease gets for carrying capital: both mean the caller has
 * confused what it paid with what it got, and a figure booked under the wrong
 * heading is a wrong daily loss, not a harmless one.
 */
function assertRealized(realized: RangeRealizedInput, proceedsAllowed: boolean): void {
  if (realized.feeUsd < 0n) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Gas is a cost; it cannot be negative');
  }
  if (realized.proceedsUsd < 0n) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'A burn cannot return a negative amount');
  }
  if (!proceedsAllowed && realized.proceedsUsd !== 0n) {
    throw new AppError(
      ErrorCode.SCHEMA_INVALID,
      'Adding liquidity returns no proceeds; it pays capital in',
    );
  }
}

/** A fee is hundredths of a basis point, so 100% is a million of them. */
const MAX_FEE_PIPS = 1_000_000;

function assertFeePips(feePips: number): void {
  if (!Number.isInteger(feePips) || feePips <= 0 || feePips >= MAX_FEE_PIPS) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Impossible v3 fee tier', {
      details: { feePips },
    });
  }
}

/**
 * Ticks are `number` here for the reason `tick-math.ts` states: a tick is an
 * int24 index, which a double holds exactly and which is what an `int24`
 * decodes into, so converting at this boundary would only add a conversion to
 * get wrong. The bounds are the pool's own, imported rather than copied.
 */
function assertTickRange(tickLower: number, tickUpper: number): void {
  for (const [field, tick] of [
    ['tickLower', tickLower],
    ['tickUpper', tickUpper],
  ] as const) {
    if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, `${field} is outside the v3 tick range`, {
        details: { [field]: tick, min: MIN_TICK, max: MAX_TICK },
      });
    }
  }
  if (tickLower >= tickUpper) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Position range is empty or inverted', {
      details: { tickLower, tickUpper },
    });
  }
}

function toAction(row: ActionRow): LpActionRecord {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    tradeId: row.trade_id,
    mode: row.mode,
    chain: row.chain,
    protocol: row.protocol,
    poolId: row.pool_id,
    action: row.action,
    status: row.status,
    txHash: row.tx_hash,
    lpTokens: row.lp_tokens,
    amount0: row.amount0,
    amount1: row.amount1,
    feeUsd: row.fee_usd,
    capitalUsd: row.capital_usd,
    note: row.note,
    at: row.at,
  };
}
