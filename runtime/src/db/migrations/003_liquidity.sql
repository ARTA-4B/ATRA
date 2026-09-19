-- Phase 4: liquidity management (auto-LP).
--
-- Same rules as 001/002: money is text in base units or USD decimal strings,
-- never a float; rows that record a decision or a fill are append-only; the
-- one mutable table (lp_positions) is the current state of a position and is
-- rebuilt from lp_actions if it is ever in doubt. Nothing here stores key
-- material.

-- One row per open LP position per (mode, chain, protocol, pool). PAPER and
-- LIVE never share a row. `capital_usd` is the cost basis (what was paid in,
-- at cross-checked prices at fill time), so impermanent loss is visible as
-- the mark minus the cost basis. The mark_* columns hold the last observation
-- a cycle made and are NULL until one has: the dashboard shows "not observed
-- yet" rather than a guessed value.
CREATE TABLE lp_positions (
  id                TEXT PRIMARY KEY,
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  chain             TEXT NOT NULL,
  protocol          TEXT NOT NULL,
  pool_id           TEXT NOT NULL,
  token0            TEXT NOT NULL,
  token1            TEXT NOT NULL,
  decimals0         INTEGER NOT NULL,
  decimals1         INTEGER NOT NULL,
  lp_tokens         TEXT NOT NULL,
  amount0           TEXT NOT NULL,
  amount1           TEXT NOT NULL,
  capital_usd       TEXT NOT NULL,
  opened_at         TEXT NOT NULL,
  last_action       TEXT NOT NULL,
  last_action_at    TEXT NOT NULL,
  last_rebalance_at TEXT,
  mark_value_usd    TEXT,
  mark_fees_usd     TEXT,
  mark_note         TEXT,
  marked_at         TEXT,
  UNIQUE (mode, chain, protocol, pool_id)
);

-- Every LP decision and its outcome, immutable. A HOLD is recorded too: "the
-- agent looked and chose not to act" is a row, not silence.
CREATE TABLE lp_actions (
  id                TEXT PRIMARY KEY,
  cycle_id          TEXT NOT NULL,
  trade_id          TEXT,
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  chain             TEXT NOT NULL,
  protocol          TEXT NOT NULL,
  pool_id           TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('HOLD', 'ADD', 'REMOVE', 'REBALANCE', 'COLLECT_FEES', 'EXIT')),
  status            TEXT NOT NULL CHECK (status IN ('hold', 'rejected', 'filled', 'failed')),
  tx_hash           TEXT,
  lp_tokens         TEXT,
  amount0           TEXT,
  amount1           TEXT,
  fee_usd           TEXT,
  capital_usd       TEXT,
  note              TEXT NOT NULL,
  at                TEXT NOT NULL
);

CREATE INDEX idx_lp_actions_at ON lp_actions (at DESC);
CREATE INDEX idx_lp_actions_pool ON lp_actions (mode, chain, pool_id, at DESC);
CREATE INDEX idx_lp_actions_cycle ON lp_actions (cycle_id);

CREATE TRIGGER lp_actions_no_update
BEFORE UPDATE ON lp_actions
BEGIN
  SELECT RAISE(ABORT, 'lp_actions is append-only');
END;

CREATE TRIGGER lp_actions_no_delete
BEFORE DELETE ON lp_actions
BEGIN
  SELECT RAISE(ABORT, 'lp_actions is append-only');
END;

-- Rebalances executed per pool per UTC day, read by the REBALANCE_LIMIT check.
CREATE TABLE lp_rebalances (
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  chain             TEXT NOT NULL,
  pool_id           TEXT NOT NULL,
  day_start_utc_ms  INTEGER NOT NULL,
  count             INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (mode, chain, pool_id, day_start_utc_ms)
);

-- LP automation switch. Off by default and stored, like the trade scheduler,
-- so a restart cannot turn it on.
CREATE TABLE lp_scheduler_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  enabled           INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  interval_seconds  INTEGER NOT NULL DEFAULT 1800,
  last_cycle_id     TEXT,
  last_cycle_at     TEXT,
  last_cycle_status TEXT,
  updated_at        TEXT NOT NULL
);
