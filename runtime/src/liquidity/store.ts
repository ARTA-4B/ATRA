import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { ChainId } from '../chains/registry.js';
import type { LpSnapshot, Mode } from '../risk/types.js';
import { lpPoolKey } from '../risk/types.js';
import { amountToBigint, microsToUsd, usdToMicros } from '../risk/money.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import type { LpRecordedAction } from './types.js';

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

  /** The LP slice of the risk snapshot for one mode. */
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
