-- Phase 5: the project treasury.
--
-- The treasury pays for ATRA's own infrastructure. It is deliberately the
-- least powerful subsystem in the runtime:
--
--  * The treasury wallet is **watch-only**. Its addresses are recorded here so
--    balances can be read; no row in this file references vault_secrets, and
--    there is no column that could ever name a signing key. The runtime cannot
--    sign for the treasury, by construction, not by policy.
--  * A payment "proposal" is a reviewed instruction a human executes from the
--    treasury wallet somewhere else. Exporting one produces text, never a
--    transaction.
--  * Treasury funds and user funds never mix: nothing here touches the ledger,
--    trades, LP positions or wallet tables, and nothing there reads these.
--
-- Money follows the same rule as everywhere else: a USD amount is a decimal
-- string with micro-USD precision, never a float. Expenses and proposals are
-- append-only, enforced by triggers, the way audit_events is; a proposal's
-- status is the single exception and moves only along a checked state machine.

-- The singleton configuration: the project-admin credential, the caps every
-- payment is measured against, and the freeze switch.
--
-- The admin credential is a separate secret from the operator password on
-- purpose. Signing into the dashboard lets someone watch the treasury; moving
-- project money needs a second credential that the operator's browser session
-- does not carry. Argon2id parameters are stored beside the hash so they can
-- be raised later without invalidating an existing install.
CREATE TABLE treasury_config (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  admin_algorithm           TEXT,
  admin_salt                BLOB,
  admin_hash                BLOB,
  admin_memory_kib          INTEGER,
  admin_iterations          INTEGER,
  admin_parallelism         INTEGER,
  admin_set_at              TEXT,
  -- USD is the only reporting currency the runtime can cross-check prices in.
  currency                  TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  low_balance_threshold_usd TEXT NOT NULL DEFAULT '0.000000',
  per_payment_cap_usd       TEXT NOT NULL DEFAULT '0.000000',
  monthly_cap_usd           TEXT NOT NULL DEFAULT '0.000000',
  approval_threshold_usd    TEXT NOT NULL DEFAULT '0.000000',
  frozen                    INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1)),
  frozen_reason             TEXT,
  frozen_at                 TEXT,
  frozen_by                 TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

-- The watch-only treasury addresses, one row per chain. Part of the
-- configuration conceptually, normalized into its own table so the chain is
-- checked by the database and an address can be disabled without being
-- forgotten. `tokens_json` lists the extra assets to read at that address
-- (a treasury that holds USDC rather than the native coin), as
-- [{ "address": "...", "symbol": "...", "decimals": n }].
CREATE TABLE treasury_addresses (
  chain             TEXT PRIMARY KEY CHECK (chain IN ('base', 'bsc', 'robinhood', 'solana')),
  address           TEXT NOT NULL,
  label             TEXT NOT NULL,
  tokens_json       TEXT NOT NULL DEFAULT '[]',
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  added_at          TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Who ATRA pays, and how. `billing_mode` decides what a payment for this
-- provider can even be: only 'on-chain' providers may carry a recipient
-- address and only they can become a payment proposal. A card, invoice or
-- manual provider becomes a manual payable — an expense the project creator
-- settles with a card or a bank transfer, recorded so the burn rate is honest.
CREATE TABLE treasury_providers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  category          TEXT NOT NULL CHECK (category IN (
                      'rpc', 'hosting', 'data', 'model', 'domain', 'security', 'other')),
  billing_mode      TEXT NOT NULL CHECK (billing_mode IN ('on-chain', 'card', 'invoice', 'manual')),
  monthly_budget_usd TEXT NOT NULL DEFAULT '0.000000',
  recipient_chain   TEXT CHECK (recipient_chain IS NULL
                      OR recipient_chain IN ('base', 'bsc', 'robinhood', 'solana')),
  recipient_address TEXT,
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note              TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  -- A recipient is meaningless without its chain, and vice versa.
  CHECK ((recipient_address IS NULL) = (recipient_chain IS NULL)),
  -- The allowlist is the billing mode: on-chain providers have exactly one
  -- allowlisted recipient, everyone else has none.
  CHECK ((billing_mode = 'on-chain') = (recipient_address IS NOT NULL))
);

-- Recorded operating expenses, append-only. `period` is the calendar month the
-- expense belongs to (YYYY-MM), which is what the burn rate is computed from;
-- `recorded_at` is when the row was written, which is not the same thing.
CREATE TABLE treasury_expenses (
  id                TEXT PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES treasury_providers(id),
  period            TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  amount_usd        TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('recurring', 'one-off', 'manual-payable')),
  status            TEXT NOT NULL CHECK (status IN ('paid', 'due', 'payable')),
  source            TEXT NOT NULL CHECK (source IN ('imported', 'manual')),
  note              TEXT NOT NULL DEFAULT '',
  recorded_at       TEXT NOT NULL,
  recorded_by       TEXT NOT NULL
);

CREATE INDEX idx_treasury_expenses_period ON treasury_expenses (period, provider_id);
CREATE INDEX idx_treasury_expenses_recorded ON treasury_expenses (recorded_at DESC);

CREATE TRIGGER treasury_expenses_no_update
BEFORE UPDATE ON treasury_expenses
BEGIN
  SELECT RAISE(ABORT, 'treasury_expenses is append-only');
END;

CREATE TRIGGER treasury_expenses_no_delete
BEFORE DELETE ON treasury_expenses
BEGIN
  SELECT RAISE(ABORT, 'treasury_expenses is append-only');
END;

-- Payment proposals. A row records what was asked for, the cap evaluation at
-- proposal time, and — once decided — the cap evaluation the decision actually
-- rested on. Both evaluations carry every check with its observed value and
-- its limit, so an approval can be re-derived from the row months later
-- without the code that produced it.
--
-- Everything except the status columns is immutable. The status moves only
-- along: proposed -> approved | rejected, approved -> exported | cancelled.
CREATE TABLE treasury_payment_proposals (
  id                TEXT PRIMARY KEY,
  created_at        TEXT NOT NULL,
  provider_id       TEXT NOT NULL REFERENCES treasury_providers(id),
  chain             TEXT NOT NULL CHECK (chain IN ('base', 'bsc', 'robinhood', 'solana')),
  recipient         TEXT NOT NULL,
  asset             TEXT NOT NULL,
  amount_usd        TEXT NOT NULL,
  period            TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  memo              TEXT NOT NULL DEFAULT '',
  proposed_by       TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('admin', 'agent')),
  checks_json       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN (
                      'proposed', 'approved', 'rejected', 'exported', 'cancelled')),
  creator_approval  INTEGER NOT NULL DEFAULT 0 CHECK (creator_approval IN (0, 1)),
  decided_at        TEXT,
  decided_by        TEXT,
  decision_note     TEXT,
  decision_json     TEXT,
  exported_at       TEXT,
  exported_by       TEXT,
  export_json       TEXT
);

CREATE INDEX idx_treasury_proposals_created ON treasury_payment_proposals (created_at DESC);
CREATE INDEX idx_treasury_proposals_status ON treasury_payment_proposals (status, created_at DESC);

CREATE TRIGGER treasury_payment_proposals_immutable
BEFORE UPDATE ON treasury_payment_proposals
WHEN OLD.id IS NOT NEW.id
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.provider_id IS NOT NEW.provider_id
  OR OLD.chain IS NOT NEW.chain
  OR OLD.recipient IS NOT NEW.recipient
  OR OLD.asset IS NOT NEW.asset
  OR OLD.amount_usd IS NOT NEW.amount_usd
  OR OLD.period IS NOT NEW.period
  OR OLD.memo IS NOT NEW.memo
  OR OLD.proposed_by IS NOT NEW.proposed_by
  OR OLD.source IS NOT NEW.source
  OR OLD.checks_json IS NOT NEW.checks_json
  -- The creator-approval flag is written with the decision, once.
  OR (OLD.status <> 'proposed' AND OLD.creator_approval IS NOT NEW.creator_approval)
  -- A decision, once recorded, is history.
  OR (OLD.decided_at IS NOT NULL AND OLD.decided_at IS NOT NEW.decided_at)
  OR (OLD.decided_by IS NOT NULL AND OLD.decided_by IS NOT NEW.decided_by)
  OR (OLD.decision_note IS NOT NULL AND OLD.decision_note IS NOT NEW.decision_note)
  OR (OLD.decision_json IS NOT NULL AND OLD.decision_json IS NOT NEW.decision_json)
  OR (OLD.exported_at IS NOT NULL AND OLD.exported_at IS NOT NEW.exported_at)
  OR (OLD.exported_by IS NOT NULL AND OLD.exported_by IS NOT NEW.exported_by)
  OR (OLD.export_json IS NOT NULL AND OLD.export_json IS NOT NEW.export_json)
BEGIN
  SELECT RAISE(ABORT, 'a treasury payment proposal is immutable apart from its status');
END;

CREATE TRIGGER treasury_payment_proposals_status
BEFORE UPDATE OF status ON treasury_payment_proposals
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'proposed' AND NEW.status IN ('approved', 'rejected'))
  OR (OLD.status = 'approved' AND NEW.status IN ('exported', 'cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal treasury payment proposal transition');
END;

CREATE TRIGGER treasury_payment_proposals_no_delete
BEFORE DELETE ON treasury_payment_proposals
BEGIN
  SELECT RAISE(ABORT, 'treasury_payment_proposals is append-only');
END;

-- Alerts the treasury review raised: a low balance, a balance that could not be
-- read, a provider over its budget, a short runway, a model recommendation that
-- was overridden. Only `acknowledged_at` may change after the row is written.
CREATE TABLE treasury_alerts (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN (
                      'low_balance', 'balance_unreadable', 'price_unknown', 'budget_exceeded',
                      'runway_short', 'frozen', 'model_override')),
  severity          TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  summary           TEXT NOT NULL,
  detail_json       TEXT NOT NULL DEFAULT '{}',
  raised_at         TEXT NOT NULL,
  acknowledged_at   TEXT
);

CREATE INDEX idx_treasury_alerts_raised ON treasury_alerts (raised_at DESC);

CREATE TRIGGER treasury_alerts_immutable
BEFORE UPDATE ON treasury_alerts
WHEN OLD.id IS NOT NEW.id
  OR OLD.kind IS NOT NEW.kind
  OR OLD.severity IS NOT NEW.severity
  OR OLD.summary IS NOT NEW.summary
  OR OLD.detail_json IS NOT NEW.detail_json
  OR OLD.raised_at IS NOT NEW.raised_at
BEGIN
  SELECT RAISE(ABORT, 'a treasury alert is immutable apart from its acknowledgement');
END;

CREATE TRIGGER treasury_alerts_no_delete
BEFORE DELETE ON treasury_alerts
BEGIN
  SELECT RAISE(ABORT, 'treasury_alerts is append-only');
END;

-- Dated balance readings, one row per address per reading. A failed RPC read is
-- stored with a NULL amount and a reason: a zero would be indistinguishable
-- from an empty wallet and would quietly become a runway of nothing. An
-- unpriced balance is stored with the amount present and value_usd NULL.
CREATE TABLE treasury_snapshots (
  id                TEXT PRIMARY KEY,
  taken_at          TEXT NOT NULL,
  chain             TEXT NOT NULL CHECK (chain IN ('base', 'bsc', 'robinhood', 'solana')),
  address           TEXT NOT NULL,
  asset             TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  decimals          INTEGER NOT NULL,
  amount            TEXT,
  price_usd         TEXT,
  value_usd         TEXT,
  reason            TEXT,
  source            TEXT NOT NULL
);

CREATE INDEX idx_treasury_snapshots_taken ON treasury_snapshots (taken_at DESC);

CREATE TRIGGER treasury_snapshots_no_update
BEFORE UPDATE ON treasury_snapshots
BEGIN
  SELECT RAISE(ABORT, 'treasury_snapshots is append-only');
END;

CREATE TRIGGER treasury_snapshots_no_delete
BEFORE DELETE ON treasury_snapshots
BEGIN
  SELECT RAISE(ABORT, 'treasury_snapshots is append-only');
END;

-- Short-lived project-admin tokens. Stored as a SHA-256 of the bearer value and
-- bound to the dashboard session that obtained them, so a token lifted from one
-- session cannot be replayed from another.
CREATE TABLE treasury_admin_tokens (
  id                TEXT PRIMARY KEY,
  token_hash        BLOB NOT NULL UNIQUE,
  session_id        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT
);

CREATE INDEX idx_treasury_admin_tokens_expires ON treasury_admin_tokens (expires_at);
