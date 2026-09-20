import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { ChainId } from '../chains/registry.js';
import type { Mode, ProposedAction, RiskDecision } from '../risk/types.js';
import { marketKey } from '../risk/types.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';

/**
 * The trade record: one row per proposal, walking a fixed state machine.
 *
 *   proposed ─┬─> rejected
 *             └─> allowed ──> dispatched ──> filled | failed | cancelled
 *
 * LIVE actions pass through `signed` and `broadcast` between dispatched and
 * their terminal state, and the transaction hash is written at `signed`, before
 * anything is sent. A crash between signing and broadcasting therefore leaves a
 * row that names its transaction, and the next start reconciles it by hash
 * rather than signing again.
 *
 * Transitions are checked. A row cannot go from `rejected` to `filled`, and a
 * terminal row cannot move at all.
 */

export type TradeStatus =
  | 'proposed'
  | 'rejected'
  | 'allowed'
  | 'dispatched'
  | 'signed'
  | 'broadcast'
  | 'filled'
  | 'failed'
  | 'cancelled';

export type TradeSide = 'open' | 'reduce' | 'close' | 'swap' | 'approve';

const TRANSITIONS: Record<TradeStatus, readonly TradeStatus[]> = {
  proposed: ['rejected', 'allowed'],
  allowed: ['dispatched', 'cancelled'],
  dispatched: ['signed', 'filled', 'failed', 'cancelled'],
  signed: ['broadcast', 'failed'],
  broadcast: ['filled', 'failed'],
  rejected: [],
  filled: [],
  failed: [],
  cancelled: [],
};

export interface TradeRecord {
  id: string;
  actionId: string;
  decisionCycleId: string;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  kind: string;
  side: TradeSide;
  marketKey: string;
  tokenIn: string;
  tokenOut: string;
  /**
   * Decimals as the operator's allowlist states them, not as the chain
   * registry guesses them. Null on rows written before they were persisted.
   */
  tokenInDecimals: number | null;
  tokenOutDecimals: number | null;
  /**
   * The USD prices the decision was made on. Null until the executor writes
   * them, and on every row written before they were persisted.
   */
  quotePrices: { tokenInUsd: string; tokenOutUsd: string; nativeUsd: string } | null;
  amountIn: string;
  expectedOut: string | null;
  minOut: string | null;
  filledOut: string | null;
  feeNative: string | null;
  feeUsd: string | null;
  amountInUsd: string | null;
  status: TradeStatus;
  rejectionCode: string | null;
  txHash: string | null;
  route: Record<string, unknown>;
  researchId: string | null;
  rationale: string | null;
  error: string | null;
  proposedAt: string;
  updatedAt: string;
  filledAt: string | null;
}

export class TradeStore {
  readonly #db: Db;
  readonly #log = childLogger('trades');
  readonly #now: () => number;

  constructor(db: Db, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  /** Record a proposal. Called before the risk engine sees it. */
  propose(
    action: ProposedAction,
    side: TradeSide,
    extras: { researchId?: string | undefined; route?: Record<string, unknown> } = {},
  ): TradeRecord {
    const id = randomUUID();
    const at = new Date(this.#now()).toISOString();

    this.#db
      .prepare(
        'INSERT INTO trades (id, action_id, decision_cycle_id, mode, chain, protocol, kind, side,' +
          ' market_key, token_in, token_out, token_in_decimals, token_out_decimals, amount_in,' +
          ' expected_out, min_out, status, route_json,' +
          ' research_id, rationale, proposed_at, updated_at)' +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        action.actionId,
        action.decisionCycleId,
        action.mode,
        action.chain,
        action.protocol,
        action.kind,
        side,
        marketKey(action.chain, action.tokenIn.address, action.tokenOut.address),
        action.tokenIn.address,
        action.tokenOut.address,
        // The allowlist is the only place that knows the decimals of a token
        // the runtime does not ship with; a fill booked without them is wrong
        // by whatever the registry's default happens to differ by.
        action.tokenIn.decimals,
        action.tokenOut.decimals,
        action.amountIn,
        action.quote?.expectedAmountOut ?? null,
        action.quote?.minAmountOut ?? null,
        JSON.stringify(extras.route ?? {}),
        extras.researchId ?? null,
        action.rationale ?? null,
        at,
        at,
      );

    return this.get(id)!;
  }

  /** Apply the risk decision. */
  decide(tradeId: string, decision: RiskDecision): TradeRecord {
    if (decision.allowed) {
      return this.#transition(tradeId, 'allowed', {
        amount_in_usd: decision.derived?.amountInUsd ?? null,
        fee_usd: decision.derived?.feeUsd ?? null,
      });
    }
    return this.#transition(tradeId, 'rejected', { rejection_code: decision.code });
  }

  /**
   * Persist the prices the decision was made on, before anything is sent.
   *
   * A transaction that confirms while the process is down leaves no fill-time
   * price behind, and a position the wallet really holds must not be missing
   * from the ledger. These are the next best valuation, and the audit row for
   * a fill booked from them says which they are.
   *
   * Not a transition: the status is untouched, so this is safe at any point
   * before dispatch.
   */
  recordQuotePrices(
    tradeId: string,
    prices: { tokenInUsd: string; tokenOutUsd: string; nativeUsd: string },
  ): void {
    this.#db
      .prepare(
        'UPDATE trades SET quote_price_in_usd = ?, quote_price_out_usd = ?,' +
          ' quote_native_usd = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        prices.tokenInUsd,
        prices.tokenOutUsd,
        prices.nativeUsd,
        new Date(this.#now()).toISOString(),
        tradeId,
      );
  }

  markDispatched(tradeId: string): TradeRecord {
    return this.#transition(tradeId, 'dispatched');
  }

  /** Write the hash before broadcast, so a crash cannot cause a double send. */
  markSigned(tradeId: string, txHash: string): TradeRecord {
    return this.#transition(tradeId, 'signed', { tx_hash: txHash });
  }

  markBroadcast(tradeId: string): TradeRecord {
    return this.#transition(tradeId, 'broadcast');
  }

  markFilled(
    tradeId: string,
    fill: { filledOut: string; feeNative: string | null; feeUsd: string; txHash?: string | null },
  ): TradeRecord {
    return this.#transition(tradeId, 'filled', {
      filled_out: fill.filledOut,
      fee_native: fill.feeNative,
      fee_usd: fill.feeUsd,
      ...(fill.txHash ? { tx_hash: fill.txHash } : {}),
      filled_at: new Date(this.#now()).toISOString(),
    });
  }

  markFailed(tradeId: string, error: string): TradeRecord {
    return this.#transition(tradeId, 'failed', { error: error.slice(0, 500) });
  }

  markCancelled(tradeId: string, reason: string): TradeRecord {
    return this.#transition(tradeId, 'cancelled', { error: reason.slice(0, 500) });
  }

  get(id: string): TradeRecord | undefined {
    const row = this.#db.prepare<[string], TradeRow>('SELECT * FROM trades WHERE id = ?').get(id);
    return row ? toRecord(row) : undefined;
  }

  getByAction(actionId: string): TradeRecord | undefined {
    const row = this.#db
      .prepare<[string], TradeRow>('SELECT * FROM trades WHERE action_id = ?')
      .get(actionId);
    return row ? toRecord(row) : undefined;
  }

  list(options: { mode?: Mode; status?: TradeStatus; limit?: number } = {}): TradeRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.mode) {
      clauses.push('mode = ?');
      params.push(options.mode);
    }
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);

    return this.#db
      .prepare<Array<string | number>, TradeRow>(
        `SELECT * FROM trades${where} ORDER BY proposed_at DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map(toRecord);
  }

  /**
   * Rows that were signed or broadcast but never reached a terminal state.
   *
   * These are what a restart must reconcile before doing anything else: each
   * names its transaction hash, and the chain — not the runtime — decides
   * whether it happened.
   */
  listInFlight(): TradeRecord[] {
    return this.#db
      .prepare<[], TradeRow>(
        "SELECT * FROM trades WHERE status IN ('dispatched', 'signed', 'broadcast') ORDER BY proposed_at",
      )
      .all()
      .map(toRecord);
  }

  #transition(
    tradeId: string,
    to: TradeStatus,
    fields: Record<string, string | null> = {},
  ): TradeRecord {
    const current = this.get(tradeId);
    if (!current) {
      throw new AppError(ErrorCode.NOT_FOUND, 'No such trade', { details: { tradeId } });
    }

    if (!TRANSITIONS[current.status].includes(to)) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `A trade cannot move from ${current.status} to ${to}`,
        { details: { tradeId, from: current.status, to } },
      );
    }

    const assignments = ['status = ?', 'updated_at = ?'];
    const values: Array<string | null> = [to, new Date(this.#now()).toISOString()];
    for (const [column, value] of Object.entries(fields)) {
      assignments.push(`${column} = ?`);
      values.push(value);
    }
    values.push(tradeId);

    this.#db.prepare(`UPDATE trades SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    this.#log.debug({ tradeId, from: current.status, to }, 'trade transition');

    return this.get(tradeId)!;
  }
}

interface TradeRow {
  id: string;
  action_id: string;
  decision_cycle_id: string;
  mode: Mode;
  chain: ChainId;
  protocol: string;
  kind: string;
  side: TradeSide;
  market_key: string;
  token_in: string;
  token_out: string;
  token_in_decimals: number | null;
  token_out_decimals: number | null;
  quote_price_in_usd: string | null;
  quote_price_out_usd: string | null;
  quote_native_usd: string | null;
  amount_in: string;
  expected_out: string | null;
  min_out: string | null;
  filled_out: string | null;
  fee_native: string | null;
  fee_usd: string | null;
  amount_in_usd: string | null;
  status: TradeStatus;
  rejection_code: string | null;
  tx_hash: string | null;
  route_json: string;
  research_id: string | null;
  rationale: string | null;
  error: string | null;
  proposed_at: string;
  updated_at: string;
  filled_at: string | null;
}

function toRecord(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    actionId: row.action_id,
    decisionCycleId: row.decision_cycle_id,
    mode: row.mode,
    chain: row.chain,
    protocol: row.protocol,
    kind: row.kind,
    side: row.side,
    marketKey: row.market_key,
    tokenIn: row.token_in,
    tokenOut: row.token_out,
    tokenInDecimals: row.token_in_decimals,
    tokenOutDecimals: row.token_out_decimals,
    // All three are written together, so a partial set means a row that
    // predates the columns rather than a half-priced fill.
    quotePrices:
      row.quote_price_in_usd !== null &&
      row.quote_price_out_usd !== null &&
      row.quote_native_usd !== null
        ? {
            tokenInUsd: row.quote_price_in_usd,
            tokenOutUsd: row.quote_price_out_usd,
            nativeUsd: row.quote_native_usd,
          }
        : null,
    amountIn: row.amount_in,
    expectedOut: row.expected_out,
    minOut: row.min_out,
    filledOut: row.filled_out,
    feeNative: row.fee_native,
    feeUsd: row.fee_usd,
    amountInUsd: row.amount_in_usd,
    status: row.status,
    rejectionCode: row.rejection_code,
    txHash: row.tx_hash,
    route: JSON.parse(row.route_json) as Record<string, unknown>,
    researchId: row.research_id,
    rationale: row.rationale,
    error: row.error,
    proposedAt: row.proposed_at,
    updatedAt: row.updated_at,
    filledAt: row.filled_at,
  };
}
