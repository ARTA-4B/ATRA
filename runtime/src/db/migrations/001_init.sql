-- ATRA initial schema (Phase 1 + Phase 2).
--
-- Design rules:
--  * money is stored as text, never as a float: native amounts are base-unit
--    integers ("12340000000000000") and USD values are decimal strings.
--  * every financial or security-relevant action appends to audit_events,
--    which is append-only (enforced by triggers below).
--  * no table ever stores plaintext key material. Ciphertext lives in
--    vault_secrets; its wrapping key never touches the database.

CREATE TABLE installation (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  -- 'PAPER' | 'LIVE'. LIVE is only reachable through the explicit
  -- multi-step activation recorded in live_activation.
  mode              TEXT NOT NULL DEFAULT 'PAPER' CHECK (mode IN ('PAPER', 'LIVE')),
  setup_completed   INTEGER NOT NULL DEFAULT 0 CHECK (setup_completed IN (0, 1)),
  enabled_chains    TEXT NOT NULL DEFAULT '[]',
  singleton         INTEGER NOT NULL DEFAULT 1 CHECK (singleton = 1),
  UNIQUE (singleton)
);

-- Operator password material. Argon2id parameters are stored alongside the
-- hash so they can be raised later without invalidating existing installs.
CREATE TABLE auth_credential (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  algorithm         TEXT NOT NULL,
  salt              BLOB NOT NULL,
  hash              BLOB NOT NULL,
  memory_kib        INTEGER NOT NULL,
  iterations        INTEGER NOT NULL,
  parallelism       INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Vault header: the data encryption key (DEK) wrapped by a key derived from
-- the operator password. Changing the password rewraps this row only.
CREATE TABLE vault_header (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  version           INTEGER NOT NULL,
  kdf               TEXT NOT NULL,
  kdf_salt          BLOB NOT NULL,
  kdf_memory_kib    INTEGER NOT NULL,
  kdf_iterations    INTEGER NOT NULL,
  kdf_parallelism   INTEGER NOT NULL,
  cipher            TEXT NOT NULL,
  wrapped_dek       BLOB NOT NULL,
  wrap_nonce        BLOB NOT NULL,
  created_at        TEXT NOT NULL,
  rotated_at        TEXT
);

-- One row per encrypted secret. `kind` says what the plaintext is so the
-- correct decoder is used on export; the plaintext itself is only ever held
-- in a short-lived Uint8Array.
CREATE TABLE vault_secrets (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('evm_private_key', 'solana_keypair', 'provider_api_key')),
  label             TEXT NOT NULL,
  nonce             BLOB NOT NULL,
  ciphertext        BLOB NOT NULL,
  aad               TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE wallets (
  id                TEXT PRIMARY KEY,
  family            TEXT NOT NULL CHECK (family IN ('evm', 'solana')),
  address           TEXT NOT NULL,
  secret_id         TEXT NOT NULL REFERENCES vault_secrets(id),
  created_at        TEXT NOT NULL,
  UNIQUE (family),
  UNIQUE (address)
);

CREATE TABLE risk_policy (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  version           INTEGER NOT NULL,
  policy_json       TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Mutable runtime switches. Kept in their own table so emergency stop can be
-- written and read without touching any other subsystem.
CREATE TABLE runtime_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  global_pause      INTEGER NOT NULL DEFAULT 0 CHECK (global_pause IN (0, 1)),
  emergency_stop    INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop IN (0, 1)),
  paused_reason     TEXT,
  emergency_reason  TEXT,
  updated_at        TEXT NOT NULL
);

-- Progress through the LIVE activation checklist. Every prerequisite is a
-- separate column so the dashboard can show exactly what is missing and the
-- runtime can never "infer" completion.
CREATE TABLE live_activation (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  acknowledged_at   TEXT,
  reauth_at         TEXT,
  risk_reviewed_at  TEXT,
  wallet_funded_at  TEXT,
  gas_checked_at    TEXT,
  adapter_checked_at TEXT,
  activated_at      TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  token_hash        BLOB NOT NULL UNIQUE,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  revoked_at        TEXT
);

CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Short-lived single-use tokens gating export / withdraw / LIVE activation.
CREATE TABLE reauth_tokens (
  id                TEXT PRIMARY KEY,
  token_hash        BLOB NOT NULL UNIQUE,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  purpose           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  used_at           TEXT
);

CREATE INDEX idx_reauth_expires ON reauth_tokens (expires_at);

CREATE TABLE settings (
  key               TEXT PRIMARY KEY,
  value_json        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Append-only audit trail. Inserts only: the triggers below reject UPDATE and
-- DELETE so history cannot be rewritten by a later bug.
CREATE TABLE audit_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          TEXT NOT NULL UNIQUE,
  ts                TEXT NOT NULL,
  category          TEXT NOT NULL,
  action            TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('ok', 'rejected', 'failed', 'pending')),
  chain             TEXT,
  actor             TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE', 'NONE')),
  summary           TEXT NOT NULL,
  detail_json       TEXT NOT NULL DEFAULT '{}',
  correlation_id    TEXT
);

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

-- Wallet-level transfers initiated by the operator (deposits observed,
-- withdrawals prepared/sent). Agent trades live in their own Phase 3 tables.
CREATE TABLE wallet_transactions (
  id                TEXT PRIMARY KEY,
  chain             TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind              TEXT NOT NULL CHECK (kind IN ('native', 'token')),
  token_address     TEXT,
  token_symbol      TEXT,
  decimals          INTEGER,
  amount_base       TEXT NOT NULL,
  to_address        TEXT NOT NULL,
  from_address      TEXT NOT NULL,
  fee_base          TEXT,
  fee_usd           TEXT,
  tx_hash           TEXT,
  status            TEXT NOT NULL CHECK (status IN ('prepared', 'simulated', 'submitted', 'confirmed', 'failed', 'cancelled')),
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  idempotency_key   TEXT UNIQUE,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  error_code        TEXT,
  error_message     TEXT
);

CREATE INDEX idx_wallet_tx_created ON wallet_transactions (created_at DESC);
CREATE INDEX idx_wallet_tx_chain ON wallet_transactions (chain, created_at DESC);

-- Phase 2: normalized market snapshots. `fetched_at` and `source` are
-- mandatory so the research agent can reject stale or unattributed data.
CREATE TABLE market_snapshots (
  id                TEXT PRIMARY KEY,
  chain             TEXT NOT NULL,
  pool_id           TEXT NOT NULL,
  base_address      TEXT NOT NULL,
  base_symbol       TEXT NOT NULL,
  quote_address     TEXT NOT NULL,
  quote_symbol      TEXT NOT NULL,
  price_usd         TEXT,
  price_native      TEXT,
  liquidity_usd     TEXT,
  volume_24h_usd    TEXT,
  change_24h_bps    INTEGER,
  dex_id            TEXT,
  source            TEXT NOT NULL,
  observed_at       TEXT NOT NULL,
  fetched_at        TEXT NOT NULL,
  raw_json          TEXT NOT NULL DEFAULT '{}',
  UNIQUE (chain, pool_id, source, fetched_at)
);

CREATE INDEX idx_market_lookup ON market_snapshots (chain, pool_id, fetched_at DESC);

CREATE TABLE watchlist (
  id                TEXT PRIMARY KEY,
  chain             TEXT NOT NULL,
  pool_id           TEXT NOT NULL,
  label             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (chain, pool_id)
);

-- Phase 2: structured research output. Facts and interpretation are stored
-- separately so a later phase can never quietly promote opinion into evidence.
CREATE TABLE research_results (
  id                TEXT PRIMARY KEY,
  created_at        TEXT NOT NULL,
  chain             TEXT,
  pool_id           TEXT,
  status            TEXT NOT NULL CHECK (status IN ('OK', 'INSUFFICIENT_DATA', 'ERROR')),
  facts_json        TEXT NOT NULL DEFAULT '[]',
  interpretation_json TEXT NOT NULL DEFAULT '[]',
  stale_inputs_json TEXT NOT NULL DEFAULT '[]',
  sources_json      TEXT NOT NULL DEFAULT '[]',
  model             TEXT,
  model_status      TEXT,
  correlation_id    TEXT
);

CREATE INDEX idx_research_created ON research_results (created_at DESC);
