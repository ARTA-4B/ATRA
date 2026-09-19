import type { Db } from '../db/database.js';
import type { AuditLog } from '../audit/audit.js';
import type { StateStore } from '../core/state.js';
import type { RiskPolicyStore } from './store.js';
import type { LedgerService, PriceLookup } from '../trading/ledger.js';
import { evaluate } from './engine.js';
import type { MarketSnapshot, Mode, ProposedAction, RiskDecision, RuntimeState } from './types.js';
import { marketKey } from './types.js';
import { childLogger } from '../logging/logger.js';

/**
 * The stateful wrapper around the pure risk engine.
 *
 * `evaluate()` reads nothing but its arguments. This class is where the
 * arguments come from and where the answer goes:
 *
 *  1. idempotency — the same intent proposed twice returns the first decision
 *     and never executes, even if the first was allowed;
 *  2. state assembly — switches, activation, cooldowns and the ledger are read
 *     from their stores at the moment of the decision;
 *  3. persistence — every decision is written with the exact action and
 *     snapshot it was made on, so it can be re-derived from the row;
 *  4. cooldowns — started only when an allowed action is actually dispatched,
 *     so an allowed-but-never-executed action does not lock a market.
 */

const DECISION_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface RiskGateDeps {
  db: Db;
  audit: AuditLog;
  state: StateStore;
  policy: RiskPolicyStore;
  ledger: LedgerService;
  now?: () => number;
}

export class RiskGate {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #state: StateStore;
  readonly #policy: RiskPolicyStore;
  readonly #ledger: LedgerService;
  readonly #now: () => number;
  readonly #log = childLogger('risk-gate');

  constructor(deps: RiskGateDeps) {
    this.#db = deps.db;
    this.#audit = deps.audit;
    this.#state = deps.state;
    this.#policy = deps.policy;
    this.#ledger = deps.ledger;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Decide, persist, and return.
   *
   * `priceLookup` marks the ledger's positions so unrealized P&L is current at
   * decision time; it is derived from the same snapshot the engine sees.
   */
  decide(action: ProposedAction, snapshot: MarketSnapshot, priceLookup: PriceLookup): RiskDecision {
    this.#pruneExpired();

    const replay = this.#findByIdempotencyKey(action.idempotencyKey);
    if (replay) {
      const duplicate: RiskDecision = {
        ...replay,
        actionId: action.actionId,
        evaluatedAt: this.#now(),
        allowed: false,
        code: 'DUPLICATE_ACTION',
        reason: `duplicate of ${replay.actionId}: the same intent was already decided`,
        checks: [],
        replayOf: replay.actionId,
      };
      this.#log.warn({ actionId: action.actionId, replayOf: replay.actionId }, 'duplicate action');
      return duplicate;
    }

    const decision = this.#evaluate(action, snapshot, priceLookup);
    this.#persist(action, snapshot, decision);
    return decision;
  }

  /** Same evaluation, nothing written. For the dashboard's "what if". */
  preview(
    action: ProposedAction,
    snapshot: MarketSnapshot,
    priceLookup: PriceLookup,
  ): RiskDecision {
    return this.#evaluate(action, snapshot, priceLookup);
  }

  /**
   * Start cooldowns for a dispatched action.
   *
   * Called by the executor once the action is handed to the signer or the
   * paper simulator — not when it is allowed, and not when it fills.
   */
  markDispatched(action: ProposedAction): void {
    // An approval moves no funds and always precedes the swap it enables;
    // starting a cooldown on it would block that swap. Cooldowns are for
    // trades.
    if (action.kind === 'approve') return;

    const now = this.#now();
    const key = marketKey(action.chain, action.tokenIn.address, action.tokenOut.address);

    const write = this.#db.transaction(() => {
      this.#db
        .prepare(
          'INSERT INTO cooldowns (market_key, last_action_at) VALUES (?, ?)' +
            ' ON CONFLICT(market_key) DO UPDATE SET last_action_at = excluded.last_action_at',
        )
        .run(key, now);
      this.#db
        .prepare(
          "INSERT INTO settings (key, value_json, updated_at) VALUES ('lastAnyActionAt', ?, ?)" +
            ' ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
        )
        .run(JSON.stringify(now), new Date(now).toISOString());
    });
    write();
  }

  /** The state slice the engine reads, assembled from every store. */
  runtimeState(priceLookup: PriceLookup, mode?: Mode): RuntimeState {
    const now = this.#now();
    const effectiveMode = mode ?? this.#state.getMode();

    const cooldowns: Record<string, number> = {};
    for (const row of this.#db
      .prepare<[], { market_key: string; last_action_at: number }>(
        'SELECT market_key, last_action_at FROM cooldowns',
      )
      .all()) {
      cooldowns[row.market_key] = row.last_action_at;
    }

    const lastAny = this.#db
      .prepare<[], { value_json: string }>(
        "SELECT value_json FROM settings WHERE key = 'lastAnyActionAt'",
      )
      .get();

    return this.#state.toRiskState({
      now,
      cooldowns,
      lastAnyActionAt: lastAny ? (JSON.parse(lastAny.value_json) as number) : null,
      ledger: this.#ledger.toRiskLedger(effectiveMode, priceLookup, now),
    });
  }

  /** Recent decisions, newest first, for the dashboard. */
  listDecisions(limit = 50): Array<{
    actionId: string;
    decisionCycleId: string;
    chain: string;
    kind: string;
    mode: Mode;
    allowed: boolean;
    code: string;
    reason: string;
    createdAt: string;
  }> {
    return this.#db
      .prepare<[number], DecisionRow>(
        'SELECT action_id, decision_cycle_id, chain, kind, mode, allowed, code, reason, created_at' +
          ' FROM action_decisions ORDER BY created_at DESC LIMIT ?',
      )
      .all(Math.min(Math.max(limit, 1), 500))
      .map((row) => ({
        actionId: row.action_id,
        decisionCycleId: row.decision_cycle_id,
        chain: row.chain,
        kind: row.kind,
        mode: row.mode,
        allowed: row.allowed === 1,
        code: row.code,
        reason: row.reason,
        createdAt: row.created_at,
      }));
  }

  getDecision(actionId: string): RiskDecision | undefined {
    const row = this.#db
      .prepare<[string], { decision_json: string }>(
        'SELECT decision_json FROM action_decisions WHERE action_id = ?',
      )
      .get(actionId);
    return row ? (JSON.parse(row.decision_json) as RiskDecision) : undefined;
  }

  #evaluate(
    action: ProposedAction,
    snapshot: MarketSnapshot,
    priceLookup: PriceLookup,
  ): RiskDecision {
    const { policy, hash } = this.#policy.getWithHash();
    const state = this.runtimeState(priceLookup, action.mode);

    return evaluate({
      now: this.#now(),
      policy,
      policyHash: hash,
      action,
      state,
      snapshot,
    });
  }

  #persist(action: ProposedAction, snapshot: MarketSnapshot, decision: RiskDecision): void {
    const now = this.#now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + DECISION_RETENTION_MS).toISOString();

    const write = this.#db.transaction(() => {
      this.#db
        .prepare(
          'INSERT INTO action_decisions (action_id, idempotency_key, decision_cycle_id, chain, kind,' +
            ' mode, allowed, code, reason, policy_hash, action_json, decision_json, snapshot_json,' +
            ' created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          action.actionId,
          action.idempotencyKey,
          action.decisionCycleId,
          action.chain,
          action.kind,
          action.mode,
          decision.allowed ? 1 : 0,
          decision.code,
          decision.reason,
          decision.policyHash,
          JSON.stringify(action),
          JSON.stringify(decision),
          JSON.stringify(snapshot),
          createdAt,
          expiresAt,
        );

      this.#audit.append({
        category: 'risk',
        action: decision.allowed ? 'decision.allowed' : 'decision.rejected',
        status: decision.allowed ? 'ok' : 'rejected',
        summary: decision.allowed
          ? `Allowed ${action.kind} on ${action.chain} (${action.protocol})`
          : `Rejected ${action.kind} on ${action.chain}: ${decision.code}`,
        chain: action.chain,
        actor: `agent:${action.source}`,
        mode: action.mode,
        correlationId: action.decisionCycleId,
        detail: {
          actionId: action.actionId,
          code: decision.code,
          reason: decision.reason,
          policyHash: decision.policyHash,
          derived: decision.derived,
          failedChecks: decision.checks
            .filter((check) => !check.passed && check.skipped === undefined)
            .map((check) => check.name),
        },
      });
    });

    write();
  }

  #findByIdempotencyKey(key: string): RiskDecision | undefined {
    const row = this.#db
      .prepare<[string], { decision_json: string }>(
        'SELECT decision_json FROM action_decisions WHERE idempotency_key = ?',
      )
      .get(key);
    return row ? (JSON.parse(row.decision_json) as RiskDecision) : undefined;
  }

  #pruneExpired(): void {
    this.#db
      .prepare('DELETE FROM action_decisions WHERE expires_at < ?')
      .run(new Date(this.#now()).toISOString());
  }
}

interface DecisionRow {
  action_id: string;
  decision_cycle_id: string;
  chain: string;
  kind: string;
  mode: Mode;
  allowed: number;
  code: string;
  reason: string;
  created_at: string;
}
