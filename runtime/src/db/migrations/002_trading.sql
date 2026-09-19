-- Phase 3: trading, execution and the paper ledger.
--
-- Same rules as 001: money is text in base units or micro-USD, never a float;
-- every row that records a decision or a fill is immutable once written (the
-- state-machine tables update a status column, nothing else); nothing here
-- stores key material.

-- Every risk decision, keyed by the action's idempotency key. A second
-- proposal with the same key gets the original decision back and never
-- executes, even if the original was allowed.
CREATE TABLE action_decisions (
  action_id         TEXT PRIMARY KEY,
  idempotency_key   TEXT NOT NULL UNIQUE,
  decision_cycle_id TEXT NOT NULL,
  chain             TEXT NOT NULL,
  kind              TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  allowed           INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  code              TEXT NOT NULL,
  reason            TEXT NOT NULL,
  policy_hash       TEXT NOT NULL,
  action_json       TEXT NOT NULL,
  decision_json     TEXT NOT NULL,
  snapshot_json     TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL
);

CREATE INDEX idx_action_decisions_expires ON action_decisions (expires_at);
CREATE INDEX idx_action_decisions_created ON action_decisions (created_at DESC);

CREATE TRIGGER action_decisions_no_update
BEFORE UPDATE ON action_decisions
BEGIN
  SELECT RAISE(ABORT, 'action_decisions is append-only');
END;

-- Per-market cooldowns, written only when an allowed action is actually
-- dispatched. A rejected or never-dispatched action must not lock a market.
CREATE TABLE cooldowns (
  market_key        TEXT PRIMARY KEY,
  last_action_at    INTEGER NOT NULL
);

-- The execution record for one action. Status walks a fixed state machine:
--   proposed -> allowed -> dispatched -> filled | failed | cancelled
--   proposed -> rejected
-- LIVE additionally passes through signed -> broadcast before filled/failed,
-- and the tx hash is written BEFORE broadcast so a crash between the two can
-- be reconciled rather than re-broadcast.
CREATE TABLE trades (
  id                TEXT PRIMARY KEY,
  action_id         TEXT NOT NULL UNIQUE,
  decision_cycle_id TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  chain             TEXT NOT NULL,
  protocol          TEXT NOT NULL,
  kind              TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('open', 'reduce', 'close', 'swap', 'approve')),
  market_key        TEXT NOT NULL,
  token_in          TEXT NOT NULL,
  token_out         TEXT NOT NULL,
  amount_in         TEXT NOT NULL,
  expected_out      TEXT,
  min_out           TEXT,
  filled_out        TEXT,
  fee_native        TEXT,
  fee_usd           TEXT,
  amount_in_usd     TEXT,
  status            TEXT NOT NULL CHECK (status IN (
                      'proposed', 'rejected', 'allowed', 'dispatched', 'signed',
                      'broadcast', 'filled', 'failed', 'cancelled')),
  rejection_code    TEXT,
  tx_hash           TEXT,
  route_json        TEXT NOT NULL DEFAULT '{}',
  research_id       TEXT,
  rationale         TEXT,
  error             TEXT,
  proposed_at       TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  filled_at         TEXT
);

CREATE INDEX idx_trades_proposed ON trades (proposed_at DESC);
CREATE INDEX idx_trades_status ON trades (status, proposed_at DESC);
CREATE INDEX idx_trades_market ON trades (market_key, proposed_at DESC);

-- Open positions in the ledger. One row per (mode, chain, token); a reduce
-- lowers `amount`, a close deletes. cost_basis is the micro-USD paid for the
-- amount currently held, so unrealized P&L is mark minus cost.
CREATE TABLE positions (
  id                TEXT PRIMARY KEY,
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  chain             TEXT NOT NULL,
  token             TEXT NOT NULL,
  decimals          INTEGER NOT NULL,
  amount            TEXT NOT NULL,
  cost_basis_usd    TEXT NOT NULL,
  opened_at         TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (mode, chain, token)
);

-- Every fill, immutable. Realized P&L for a day is the sum over fills whose
-- filled_at falls in that UTC day; fees are recorded as negatives inside it.
CREATE TABLE fills (
  id                TEXT PRIMARY KEY,
  trade_id          TEXT NOT NULL REFERENCES trades(id),
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  chain             TEXT NOT NULL,
  token_in          TEXT NOT NULL,
  token_out         TEXT NOT NULL,
  amount_in         TEXT NOT NULL,
  amount_out        TEXT NOT NULL,
  price_in_usd      TEXT NOT NULL,
  price_out_usd     TEXT NOT NULL,
  fee_usd           TEXT NOT NULL,
  realized_pnl_usd  TEXT NOT NULL,
  filled_at         TEXT NOT NULL,
  simulated         INTEGER NOT NULL CHECK (simulated IN (0, 1))
);

CREATE INDEX idx_fills_filled ON fills (mode, filled_at DESC);

CREATE TRIGGER fills_no_update
BEFORE UPDATE ON fills
BEGIN
  SELECT RAISE(ABORT, 'fills is append-only');
END;

CREATE TRIGGER fills_no_delete
BEFORE DELETE ON fills
BEGIN
  SELECT RAISE(ABORT, 'fills is append-only');
END;

-- Paper balances. LIVE balances come from the chain; PAPER balances live here,
-- seeded by the operator, so paper trading is bounded by a stated bankroll
-- rather than an imaginary infinite one.
CREATE TABLE paper_balances (
  chain             TEXT NOT NULL,
  token             TEXT NOT NULL,
  decimals          INTEGER NOT NULL,
  amount            TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (chain, token)
);

-- Daily ledger marks: the unrealized P&L recorded at the start of each UTC
-- day, which the daily-loss check uses as its baseline.
CREATE TABLE ledger_days (
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  day_start_utc_ms  INTEGER NOT NULL,
  unrealized_at_start_usd TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  PRIMARY KEY (mode, day_start_utc_ms)
);

-- Scheduler state, so a restart neither double-runs a cycle nor forgets that
-- automation was on.
CREATE TABLE scheduler_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  auto_trade_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_trade_enabled IN (0, 1)),
  interval_seconds  INTEGER NOT NULL DEFAULT 300,
  last_cycle_id     TEXT,
  last_cycle_at     TEXT,
  last_cycle_status TEXT,
  updated_at        TEXT NOT NULL
);

-- Phase 3 adds a fifth audit status, `hold`: the agent looked and chose not
-- to act. That is neither `ok` (something happened) nor `rejected` (the risk
-- engine refused). SQLite cannot alter a CHECK constraint in place, so the
-- append-only table is rebuilt once with the wider constraint. Rows are
-- copied verbatim; the append-only triggers are re-created on the new table.
DROP TRIGGER audit_events_no_update;
DROP TRIGGER audit_events_no_delete;

CREATE TABLE audit_events_v2 (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          TEXT NOT NULL UNIQUE,
  ts                TEXT NOT NULL,
  category          TEXT NOT NULL,
  action            TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('ok', 'rejected', 'failed', 'pending', 'hold')),
  chain             TEXT,
  actor             TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE', 'NONE')),
  summary           TEXT NOT NULL,
  detail_json       TEXT NOT NULL DEFAULT '{}',
  correlation_id    TEXT
);

INSERT INTO audit_events_v2 (id, event_id, ts, category, action, status, chain, actor, mode, summary, detail_json, correlation_id)
  SELECT id, event_id, ts, category, action, status, chain, actor, mode, summary, detail_json, correlation_id
  FROM audit_events ORDER BY id;

DROP TABLE audit_events;
ALTER TABLE audit_events_v2 RENAME TO audit_events;

CREATE INDEX idx_audit_ts ON audit_events (ts DESC);
CREATE INDEX idx_audit_category ON audit_events (category, ts DESC);
CREATE INDEX idx_audit_correlation ON audit_events (correlation_id);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
