import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import { redact } from '../logging/redact.js';
import { childLogger } from '../logging/logger.js';
import type { ChainId } from '../chains/registry.js';

/**
 * The append-only audit trail.
 *
 * Every meaningful operation writes a row here: wallet creation, exports, risk
 * decisions, mode changes, withdrawals, pauses. The table has triggers that
 * reject UPDATE and DELETE, so history cannot be rewritten by a later bug or by
 * a compromised process that still has the database handle.
 *
 * What never goes in: private keys, passwords, session tokens, provider API
 * keys, Telegram secrets. Details are passed through the same redactor the
 * logger uses, so a careless caller cannot leak one by accident.
 */

export type AuditCategory =
  | 'setup'
  | 'auth'
  | 'wallet'
  | 'risk'
  | 'mode'
  | 'control'
  | 'trade'
  | 'liquidity'
  | 'market'
  | 'research'
  | 'telegram'
  | 'system';

export type AuditStatus = 'ok' | 'rejected' | 'failed' | 'pending';

export interface AuditEvent {
  category: AuditCategory;
  action: string;
  status: AuditStatus;
  /** Short human-readable line shown in the Activity page. */
  summary: string;
  chain?: ChainId | undefined;
  /** Who initiated it: 'operator', 'scheduler', 'agent:trader', 'telegram'. */
  actor?: string;
  mode?: 'PAPER' | 'LIVE' | 'NONE';
  detail?: Record<string, unknown>;
  correlationId?: string | undefined;
}

export interface AuditRecord extends AuditEvent {
  id: number;
  eventId: string;
  ts: string;
  actor: string;
  mode: 'PAPER' | 'LIVE' | 'NONE';
  detail: Record<string, unknown>;
}

interface AuditRow {
  id: number;
  event_id: string;
  ts: string;
  category: string;
  action: string;
  status: string;
  chain: string | null;
  actor: string;
  mode: string;
  summary: string;
  detail_json: string;
  correlation_id: string | null;
}

export interface AuditQuery {
  category?: AuditCategory;
  chain?: ChainId;
  status?: AuditStatus;
  /** Cursor: return rows with an id strictly below this. */
  before?: number;
  limit?: number;
}

export class AuditLog {
  readonly #db: Db;
  readonly #log = childLogger('audit');

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Append an event.
   *
   * Returns the generated event id so a caller can correlate a decision with
   * the execution that followed it.
   */
  append(event: AuditEvent): string {
    const eventId = randomUUID();
    const detail = redact(event.detail ?? {}) as Record<string, unknown>;

    this.#db
      .prepare(
        'INSERT INTO audit_events (event_id, ts, category, action, status, chain, actor, mode,' +
          ' summary, detail_json, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        eventId,
        new Date().toISOString(),
        event.category,
        event.action,
        event.status,
        event.chain ?? null,
        event.actor ?? 'system',
        event.mode ?? 'NONE',
        event.summary,
        JSON.stringify(detail),
        event.correlationId ?? null,
      );

    this.#log.info(
      { category: event.category, action: event.action, status: event.status, eventId },
      event.summary,
    );
    return eventId;
  }

  list(query: AuditQuery = {}): AuditRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.category) {
      clauses.push('category = ?');
      params.push(query.category);
    }
    if (query.chain) {
      clauses.push('chain = ?');
      params.push(query.chain);
    }
    if (query.status) {
      clauses.push('status = ?');
      params.push(query.status);
    }
    if (query.before !== undefined) {
      clauses.push('id < ?');
      params.push(query.before);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);

    const rows = this.#db
      .prepare<Array<string | number>, AuditRow>(
        `SELECT * FROM audit_events${where} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit);

    return rows.map(toRecord);
  }

  get(eventId: string): AuditRecord | undefined {
    const row = this.#db
      .prepare<[string], AuditRow>('SELECT * FROM audit_events WHERE event_id = ?')
      .get(eventId);
    return row ? toRecord(row) : undefined;
  }

  count(): number {
    const row = this.#db
      .prepare<[], { total: number }>('SELECT COUNT(*) AS total FROM audit_events')
      .get();
    return row?.total ?? 0;
  }
}

function toRecord(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    ts: row.ts,
    category: row.category as AuditCategory,
    action: row.action,
    status: row.status as AuditStatus,
    chain: (row.chain ?? undefined) as ChainId | undefined,
    actor: row.actor,
    mode: row.mode as 'PAPER' | 'LIVE' | 'NONE',
    summary: row.summary,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    correlationId: row.correlation_id ?? undefined,
  };
}
