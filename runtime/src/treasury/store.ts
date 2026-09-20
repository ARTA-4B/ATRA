import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { ChainId } from '../chains/registry.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { monthBounds } from './burn.js';
import { treasuryTokenSchema } from './types.js';
import type {
  AlertKind,
  AlertSeverity,
  BalanceSnapshot,
  BillingMode,
  CapDecision,
  Expense,
  ExpenseKind,
  ExpenseSource,
  ExpenseStatus,
  ExportedInstruction,
  PaymentProposal,
  Provider,
  ProviderCategory,
  ProposalSource,
  ProposalStatus,
  TreasuryAddress,
  TreasuryAlert,
  TreasuryCaps,
  TreasuryConfig,
  TreasuryToken,
} from './types.js';

/**
 * Persistence for the treasury.
 *
 * Every table this store touches begins with `treasury_`. It does not read
 * `wallets`, `vault_secrets`, `ledger_*`, `trades` or anything else that
 * belongs to user funds, and the migration that created its tables has no
 * foreign key into them. That is the storage half of "treasury funds and
 * user funds never mix"; the service half is that {@link TreasuryService}'s
 * dependencies contain no wallet and no ledger.
 *
 * Money columns are canonical micro-USD strings. Sums are computed in
 * JavaScript with bigint, never with SQL `SUM()` over text.
 */

interface ConfigRow {
  id: number;
  admin_algorithm: string | null;
  admin_salt: Uint8Array | null;
  admin_hash: Uint8Array | null;
  admin_memory_kib: number | null;
  admin_iterations: number | null;
  admin_parallelism: number | null;
  admin_set_at: string | null;
  currency: 'USD';
  low_balance_threshold_usd: string;
  per_payment_cap_usd: string;
  monthly_cap_usd: string;
  approval_threshold_usd: string;
  frozen: number;
  frozen_reason: string | null;
  frozen_at: string | null;
  frozen_by: string | null;
  created_at: string;
  updated_at: string;
}

interface AddressRow {
  chain: ChainId;
  address: string;
  label: string;
  tokens_json: string;
  enabled: number;
  added_at: string;
  updated_at: string;
}

interface ProviderRow {
  id: string;
  name: string;
  category: ProviderCategory;
  billing_mode: BillingMode;
  monthly_budget_usd: string;
  recipient_chain: ChainId | null;
  recipient_address: string | null;
  active: number;
  note: string;
  created_at: string;
  updated_at: string;
}

interface ExpenseRow {
  id: string;
  provider_id: string;
  period: string;
  amount_usd: string;
  kind: ExpenseKind;
  status: ExpenseStatus;
  source: ExpenseSource;
  note: string;
  recorded_at: string;
  recorded_by: string;
}

interface ProposalRow {
  id: string;
  created_at: string;
  provider_id: string;
  chain: ChainId;
  recipient: string;
  asset: string;
  amount_usd: string;
  period: string;
  memo: string;
  proposed_by: string;
  source: ProposalSource;
  checks_json: string;
  status: ProposalStatus;
  creator_approval: number;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  decision_json: string | null;
  exported_at: string | null;
  exported_by: string | null;
  export_json: string | null;
}

interface AlertRow {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  summary: string;
  detail_json: string;
  raised_at: string;
  acknowledged_at: string | null;
}

interface SnapshotRow {
  id: string;
  taken_at: string;
  chain: ChainId;
  address: string;
  asset: string;
  symbol: string;
  decimals: number;
  amount: string | null;
  price_usd: string | null;
  value_usd: string | null;
  reason: string | null;
  source: string;
}

interface AdminTokenRow {
  id: string;
  token_hash: Uint8Array;
  session_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface AdminCredential {
  algorithm: string;
  salt: Uint8Array;
  hash: Uint8Array;
  memoryKib: number;
  iterations: number;
  parallelism: number;
  setAt: string;
}

export interface ProviderInput {
  name: string;
  category: ProviderCategory;
  billingMode: BillingMode;
  monthlyBudgetUsd: string;
  recipient: { chain: ChainId; address: string } | null;
  note: string;
}

export interface ExpenseInput {
  providerId: string;
  period: string;
  amountUsd: string;
  kind: ExpenseKind;
  status: ExpenseStatus;
  source: ExpenseSource;
  note: string;
  recordedBy: string;
}

export interface ProposalInsert {
  providerId: string;
  chain: ChainId;
  recipient: string;
  asset: string;
  amountUsd: string;
  period: string;
  memo: string;
  proposedBy: string;
  source: ProposalSource;
  checks: CapDecision;
}

export class TreasuryStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    this.#ensureConfigRow();
  }

  get db(): Db {
    return this.#db;
  }

  #ensureConfigRow(): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT OR IGNORE INTO treasury_config (id, created_at, updated_at) VALUES (1, ?, ?)',
      )
      .run(now, now);
  }

  // --- config ---------------------------------------------------------------

  #configRow(): ConfigRow {
    const row = this.#db.prepare<[], ConfigRow>('SELECT * FROM treasury_config WHERE id = 1').get();
    if (!row) {
      // The constructor inserted it; a missing row means the table was
      // tampered with, which is not something to paper over silently.
      throw new AppError(ErrorCode.INTERNAL, 'The treasury configuration row is missing');
    }
    return row;
  }

  getConfig(): TreasuryConfig {
    const row = this.#configRow();
    return {
      currency: row.currency,
      adminConfigured: row.admin_hash !== null,
      adminSetAt: row.admin_set_at,
      lowBalanceThresholdUsd: row.low_balance_threshold_usd,
      perPaymentCapUsd: row.per_payment_cap_usd,
      monthlyCapUsd: row.monthly_cap_usd,
      approvalThresholdUsd: row.approval_threshold_usd,
      frozen: row.frozen === 1,
      frozenReason: row.frozen_reason,
      frozenAt: row.frozen_at,
      frozenBy: row.frozen_by,
      addresses: this.listAddresses(),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** The freeze flag alone: one indexed read, no joins, nothing else needed. */
  isFrozen(): boolean {
    const row = this.#db
      .prepare<[], { frozen: number }>('SELECT frozen FROM treasury_config WHERE id = 1')
      .get();
    return row?.frozen === 1;
  }

  updateCaps(caps: Partial<TreasuryCaps>): void {
    const current = this.#configRow();
    this.#db
      .prepare(
        'UPDATE treasury_config SET low_balance_threshold_usd = ?, per_payment_cap_usd = ?,' +
          ' monthly_cap_usd = ?, approval_threshold_usd = ?, updated_at = ? WHERE id = 1',
      )
      .run(
        caps.lowBalanceThresholdUsd ?? current.low_balance_threshold_usd,
        caps.perPaymentCapUsd ?? current.per_payment_cap_usd,
        caps.monthlyCapUsd ?? current.monthly_cap_usd,
        caps.approvalThresholdUsd ?? current.approval_threshold_usd,
        new Date().toISOString(),
      );
  }

  setFrozen(frozen: boolean, reason: string | null, by: string): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'UPDATE treasury_config SET frozen = ?, frozen_reason = ?, frozen_at = ?, frozen_by = ?,' +
          ' updated_at = ? WHERE id = 1',
      )
      .run(frozen ? 1 : 0, frozen ? reason : null, frozen ? now : null, frozen ? by : null, now);
  }

  // --- admin credential -------------------------------------------------------

  getAdminCredential(): AdminCredential | undefined {
    const row = this.#configRow();
    if (
      row.admin_hash === null ||
      row.admin_salt === null ||
      row.admin_algorithm === null ||
      row.admin_memory_kib === null ||
      row.admin_iterations === null ||
      row.admin_parallelism === null ||
      row.admin_set_at === null
    ) {
      return undefined;
    }
    return {
      algorithm: row.admin_algorithm,
      salt: row.admin_salt,
      hash: row.admin_hash,
      memoryKib: row.admin_memory_kib,
      iterations: row.admin_iterations,
      parallelism: row.admin_parallelism,
      setAt: row.admin_set_at,
    };
  }

  /**
   * Store the admin credential. The `admin_hash IS NULL` predicate makes the
   * write single-use at the database, so two racing setup requests cannot
   * both succeed even if both passed the service's check.
   */
  setAdminCredential(credential: Omit<AdminCredential, 'setAt'>): boolean {
    const now = new Date().toISOString();
    const result = this.#db
      .prepare(
        'UPDATE treasury_config SET admin_algorithm = ?, admin_salt = ?, admin_hash = ?,' +
          ' admin_memory_kib = ?, admin_iterations = ?, admin_parallelism = ?, admin_set_at = ?,' +
          ' updated_at = ? WHERE id = 1 AND admin_hash IS NULL',
      )
      .run(
        credential.algorithm,
        credential.salt,
        credential.hash,
        credential.memoryKib,
        credential.iterations,
        credential.parallelism,
        now,
        now,
      );
    return Number(result.changes) === 1;
  }

  // --- admin tokens -------------------------------------------------------------

  insertAdminToken(tokenHash: Uint8Array, sessionId: string, expiresAt: string): string {
    const id = randomUUID();
    this.#db
      .prepare(
        'INSERT INTO treasury_admin_tokens (id, token_hash, session_id, created_at, expires_at)' +
          ' VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, tokenHash, sessionId, new Date().toISOString(), expiresAt);
    return id;
  }

  findAdminToken(tokenHash: Uint8Array): AdminTokenRow | undefined {
    return this.#db
      .prepare<[Uint8Array], AdminTokenRow>(
        'SELECT * FROM treasury_admin_tokens WHERE token_hash = ?',
      )
      .get(tokenHash);
  }

  revokeAdminTokens(sessionId: string): number {
    const result = this.#db
      .prepare(
        'UPDATE treasury_admin_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL',
      )
      .run(new Date().toISOString(), sessionId);
    return Number(result.changes);
  }

  pruneAdminTokens(now: string): void {
    this.#db.prepare('DELETE FROM treasury_admin_tokens WHERE expires_at <= ?').run(now);
  }

  // --- addresses -----------------------------------------------------------------

  listAddresses(): TreasuryAddress[] {
    return this.#db
      .prepare<[], AddressRow>('SELECT * FROM treasury_addresses ORDER BY chain')
      .all()
      .map(toAddress);
  }

  getAddress(chain: ChainId): TreasuryAddress | undefined {
    const row = this.#db
      .prepare<[string], AddressRow>('SELECT * FROM treasury_addresses WHERE chain = ?')
      .get(chain);
    return row ? toAddress(row) : undefined;
  }

  upsertAddress(input: {
    chain: ChainId;
    address: string;
    label: string;
    tokens: TreasuryToken[];
    enabled: boolean;
  }): TreasuryAddress {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO treasury_addresses (chain, address, label, tokens_json, enabled, added_at, updated_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?)' +
          ' ON CONFLICT(chain) DO UPDATE SET address = excluded.address, label = excluded.label,' +
          ' tokens_json = excluded.tokens_json, enabled = excluded.enabled, updated_at = excluded.updated_at',
      )
      .run(
        input.chain,
        input.address,
        input.label,
        JSON.stringify(input.tokens),
        input.enabled ? 1 : 0,
        now,
        now,
      );
    return this.getAddress(input.chain)!;
  }

  enabledChains(): ChainId[] {
    return this.listAddresses()
      .filter((address) => address.enabled)
      .map((address) => address.chain);
  }

  // --- providers -------------------------------------------------------------------

  listProviders(): Provider[] {
    return this.#db
      .prepare<[], ProviderRow>('SELECT * FROM treasury_providers ORDER BY name')
      .all()
      .map(toProvider);
  }

  getProvider(id: string): Provider | undefined {
    const row = this.#db
      .prepare<[string], ProviderRow>('SELECT * FROM treasury_providers WHERE id = ?')
      .get(id);
    return row ? toProvider(row) : undefined;
  }

  findProviderByName(name: string): Provider | undefined {
    const row = this.#db
      .prepare<[string], ProviderRow>(
        'SELECT * FROM treasury_providers WHERE name = ? COLLATE NOCASE',
      )
      .get(name);
    return row ? toProvider(row) : undefined;
  }

  insertProvider(input: ProviderInput): Provider {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO treasury_providers (id, name, category, billing_mode, monthly_budget_usd,' +
          ' recipient_chain, recipient_address, active, note, created_at, updated_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      )
      .run(
        id,
        input.name,
        input.category,
        input.billingMode,
        input.monthlyBudgetUsd,
        input.recipient?.chain ?? null,
        input.recipient?.address ?? null,
        input.note,
        now,
        now,
      );
    return this.getProvider(id)!;
  }

  updateProvider(id: string, input: ProviderInput & { active: boolean }): Provider {
    this.#db
      .prepare(
        'UPDATE treasury_providers SET name = ?, category = ?, billing_mode = ?, monthly_budget_usd = ?,' +
          ' recipient_chain = ?, recipient_address = ?, active = ?, note = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        input.name,
        input.category,
        input.billingMode,
        input.monthlyBudgetUsd,
        input.recipient?.chain ?? null,
        input.recipient?.address ?? null,
        input.active ? 1 : 0,
        input.note,
        new Date().toISOString(),
        id,
      );
    return this.getProvider(id)!;
  }

  // --- expenses ----------------------------------------------------------------------

  listExpenses(query: { period?: string; providerId?: string; limit?: number } = {}): Expense[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.period) {
      clauses.push('period = ?');
      params.push(query.period);
    }
    if (query.providerId) {
      clauses.push('provider_id = ?');
      params.push(query.providerId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 2_000);
    return this.#db
      .prepare<Array<string | number>, ExpenseRow>(
        `SELECT * FROM treasury_expenses${where} ORDER BY period DESC, recorded_at DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map(toExpense);
  }

  /** Every expense whose period is one of the given months. */
  expensesInPeriods(periods: string[]): Expense[] {
    if (periods.length === 0) return [];
    const marks = periods.map(() => '?').join(', ');
    return this.#db
      .prepare<string[], ExpenseRow>(
        `SELECT * FROM treasury_expenses WHERE period IN (${marks}) ORDER BY period, recorded_at`,
      )
      .all(...periods)
      .map(toExpense);
  }

  insertExpense(input: ExpenseInput): Expense {
    const id = randomUUID();
    this.#db
      .prepare(
        'INSERT INTO treasury_expenses (id, provider_id, period, amount_usd, kind, status, source,' +
          ' note, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.providerId,
        input.period,
        input.amountUsd,
        input.kind,
        input.status,
        input.source,
        input.note,
        new Date().toISOString(),
        input.recordedBy,
      );
    return toExpense(
      this.#db
        .prepare<[string], ExpenseRow>('SELECT * FROM treasury_expenses WHERE id = ?')
        .get(id)!,
    );
  }

  // --- proposals ------------------------------------------------------------------------

  listProposals(query: { status?: ProposalStatus; limit?: number } = {}): PaymentProposal[] {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000);
    const rows = query.status
      ? this.#db
          .prepare<[string, number], ProposalRow>(
            'SELECT * FROM treasury_payment_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(query.status, limit)
      : this.#db
          .prepare<[number], ProposalRow>(
            'SELECT * FROM treasury_payment_proposals ORDER BY created_at DESC LIMIT ?',
          )
          .all(limit);
    return rows.map(toProposal);
  }

  getProposal(id: string): PaymentProposal | undefined {
    const row = this.#db
      .prepare<[string], ProposalRow>('SELECT * FROM treasury_payment_proposals WHERE id = ?')
      .get(id);
    return row ? toProposal(row) : undefined;
  }

  insertProposal(input: ProposalInsert): PaymentProposal {
    const id = randomUUID();
    this.#db
      .prepare(
        'INSERT INTO treasury_payment_proposals (id, created_at, provider_id, chain, recipient, asset,' +
          ' amount_usd, period, memo, proposed_by, source, checks_json, status)' +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')",
      )
      .run(
        id,
        new Date().toISOString(),
        input.providerId,
        input.chain,
        input.recipient,
        input.asset,
        input.amountUsd,
        input.period,
        input.memo,
        input.proposedBy,
        input.source,
        JSON.stringify(input.checks),
      );
    return this.getProposal(id)!;
  }

  /**
   * Record a decision. The status transition itself is enforced by the
   * database trigger; this method only writes the columns that go with it.
   */
  decideProposal(
    id: string,
    status: 'approved' | 'rejected',
    by: string,
    note: string,
    decision: CapDecision,
    creatorApproval: boolean,
  ): PaymentProposal {
    this.#db
      .prepare(
        'UPDATE treasury_payment_proposals SET status = ?, creator_approval = ?, decided_at = ?,' +
          ' decided_by = ?, decision_note = ?, decision_json = ? WHERE id = ?',
      )
      .run(
        status,
        creatorApproval ? 1 : 0,
        new Date().toISOString(),
        by,
        note,
        JSON.stringify(decision),
        id,
      );
    return this.getProposal(id)!;
  }

  /**
   * Cancel an approved proposal. The approval's decision columns stay as they
   * were (the immutability trigger insists on it); who cancelled and why is
   * the audit row's business.
   */
  cancelProposal(id: string): PaymentProposal {
    this.#db
      .prepare("UPDATE treasury_payment_proposals SET status = 'cancelled' WHERE id = ?")
      .run(id);
    return this.getProposal(id)!;
  }

  exportProposal(id: string, by: string, instruction: ExportedInstruction): PaymentProposal {
    this.#db
      .prepare(
        "UPDATE treasury_payment_proposals SET status = 'exported', exported_at = ?, exported_by = ?," +
          ' export_json = ? WHERE id = ?',
      )
      .run(instruction.exportedAt, by, JSON.stringify(instruction), id);
    return this.getProposal(id)!;
  }

  /** Approved and exported proposals decided in the calendar month containing `now`. */
  approvedInMonth(now: number): PaymentProposal[] {
    const { start, end } = monthBounds(now);
    return this.#db
      .prepare<[string, string], ProposalRow>(
        "SELECT * FROM treasury_payment_proposals WHERE status IN ('approved', 'exported')" +
          ' AND decided_at >= ? AND decided_at < ? ORDER BY decided_at',
      )
      .all(start, end)
      .map(toProposal);
  }

  /** Approved and exported proposals for one provider and billing period. */
  approvedForProviderPeriod(providerId: string, period: string): PaymentProposal[] {
    return this.#db
      .prepare<[string, string], ProposalRow>(
        "SELECT * FROM treasury_payment_proposals WHERE status IN ('approved', 'exported')" +
          ' AND provider_id = ? AND period = ? ORDER BY decided_at',
      )
      .all(providerId, period)
      .map(toProposal);
  }

  // --- alerts -----------------------------------------------------------------------------

  listAlerts(query: { includeAcknowledged?: boolean; limit?: number } = {}): TreasuryAlert[] {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000);
    const where = query.includeAcknowledged ? '' : ' WHERE acknowledged_at IS NULL';
    return this.#db
      .prepare<[number], AlertRow>(
        `SELECT * FROM treasury_alerts${where} ORDER BY raised_at DESC LIMIT ?`,
      )
      .all(limit)
      .map(toAlert);
  }

  /** An open (unacknowledged) alert of this kind with this dedupe key, if any. */
  findOpenAlert(kind: AlertKind, key: string): TreasuryAlert | undefined {
    const row = this.#db
      .prepare<[string, string], AlertRow>(
        'SELECT * FROM treasury_alerts WHERE kind = ? AND acknowledged_at IS NULL' +
          " AND json_extract(detail_json, '$.key') = ? ORDER BY raised_at DESC LIMIT 1",
      )
      .get(kind, key);
    return row ? toAlert(row) : undefined;
  }

  insertAlert(
    kind: AlertKind,
    severity: AlertSeverity,
    summary: string,
    detail: Record<string, unknown>,
  ): TreasuryAlert {
    const id = randomUUID();
    const raisedAt = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO treasury_alerts (id, kind, severity, summary, detail_json, raised_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, kind, severity, summary, JSON.stringify(detail), raisedAt);
    return { id, kind, severity, summary, detail, raisedAt, acknowledgedAt: null };
  }

  acknowledgeAlert(id: string): TreasuryAlert | undefined {
    this.#db
      .prepare(
        'UPDATE treasury_alerts SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL',
      )
      .run(new Date().toISOString(), id);
    const row = this.#db
      .prepare<[string], AlertRow>('SELECT * FROM treasury_alerts WHERE id = ?')
      .get(id);
    return row ? toAlert(row) : undefined;
  }

  // --- snapshots ---------------------------------------------------------------------------

  insertSnapshot(snapshot: Omit<BalanceSnapshot, 'id'>): BalanceSnapshot {
    const id = randomUUID();
    this.#db
      .prepare(
        'INSERT INTO treasury_snapshots (id, taken_at, chain, address, asset, symbol, decimals, amount,' +
          ' price_usd, value_usd, reason, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        snapshot.takenAt,
        snapshot.chain,
        snapshot.address,
        snapshot.asset,
        snapshot.symbol,
        snapshot.decimals,
        snapshot.amount,
        snapshot.priceUsd,
        snapshot.valueUsd,
        snapshot.reason,
        snapshot.source,
      );
    return { id, ...snapshot };
  }

  latestSnapshots(limit = 50): BalanceSnapshot[] {
    return this.#db
      .prepare<[number], SnapshotRow>(
        'SELECT * FROM treasury_snapshots ORDER BY taken_at DESC LIMIT ?',
      )
      .all(Math.min(Math.max(limit, 1), 1_000))
      .map(toSnapshot);
  }
}

// --- row mappers ---------------------------------------------------------------

function toAddress(row: AddressRow): TreasuryAddress {
  let tokens: TreasuryToken[];
  try {
    const parsed = treasuryTokenSchema.array().safeParse(JSON.parse(row.tokens_json));
    tokens = parsed.success ? parsed.data : [];
  } catch {
    tokens = [];
  }
  return {
    chain: row.chain,
    address: row.address,
    label: row.label,
    tokens,
    enabled: row.enabled === 1,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    billingMode: row.billing_mode,
    monthlyBudgetUsd: row.monthly_budget_usd,
    recipient:
      row.recipient_chain !== null && row.recipient_address !== null
        ? { chain: row.recipient_chain, address: row.recipient_address }
        : null,
    active: row.active === 1,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    providerId: row.provider_id,
    period: row.period,
    amountUsd: row.amount_usd,
    kind: row.kind,
    status: row.status,
    source: row.source,
    note: row.note,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
  };
}

function toProposal(row: ProposalRow): PaymentProposal {
  return {
    id: row.id,
    createdAt: row.created_at,
    providerId: row.provider_id,
    chain: row.chain,
    recipient: row.recipient,
    asset: row.asset,
    amountUsd: row.amount_usd,
    period: row.period,
    memo: row.memo,
    proposedBy: row.proposed_by,
    source: row.source,
    checks: JSON.parse(row.checks_json) as CapDecision,
    status: row.status,
    creatorApproval: row.creator_approval === 1,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    decision: row.decision_json === null ? null : (JSON.parse(row.decision_json) as CapDecision),
    exportedAt: row.exported_at,
    exportedBy: row.exported_by,
    export: row.export_json === null ? null : (JSON.parse(row.export_json) as ExportedInstruction),
  };
}

function toAlert(row: AlertRow): TreasuryAlert {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    summary: row.summary,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    raisedAt: row.raised_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

function toSnapshot(row: SnapshotRow): BalanceSnapshot {
  return {
    id: row.id,
    takenAt: row.taken_at,
    chain: row.chain,
    address: row.address,
    asset: row.asset,
    symbol: row.symbol,
    decimals: row.decimals,
    amount: row.amount,
    priceUsd: row.price_usd,
    valueUsd: row.value_usd,
    reason: row.reason,
    source: row.source,
  };
}
