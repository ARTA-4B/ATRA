-- ATRA gateway schema (D1). Applied with `wrangler d1 migrations apply`.
--
-- Nothing here holds a secret: installation tokens are stored only as an HMAC,
-- pair codes only as a SHA-256, and the Telegram link holds a user id, a chat
-- id and a display name (never a phone number).

-- Installation tokens. One row per minted token; a token is presented as
-- "Authorization: Bearer atra_<uuidv7>.<random>" and looked up by its HMAC.
-- Rotation (a new row whose rotated_from points at the old hash, both valid
-- for a 300 s grace window) is Phase 5: the column exists, the code does not.
CREATE TABLE install_tokens (
  token_hash   TEXT PRIMARY KEY,
  install_id   TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '["telegram"]',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  rotated_from TEXT
);
CREATE INDEX install_tokens_install_id ON install_tokens (install_id);

-- Pairing codes offered by a runtime (frame "pair.offer"). Single use: the
-- consuming statement is
--   UPDATE pair_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL
--     AND expires_at > ? RETURNING install_id
-- which is atomic in SQLite, so a replayed or raced code loses.
CREATE TABLE pair_codes (
  code_hash  TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX pair_codes_install_id ON pair_codes (install_id);

-- The Telegram identity linked to an installation. One link per installation
-- and, by the pairing code path, one installation per Telegram user.
CREATE TABLE tg_links (
  install_id   TEXT PRIMARY KEY,
  tg_user_id   INTEGER NOT NULL,
  tg_chat_id   INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  paired_at    INTEGER NOT NULL
);
CREATE INDEX tg_links_tg_user_id ON tg_links (tg_user_id);

-- Webhook replay protection. Telegram retries an update until it gets a 2xx,
-- so an update that was processed but whose response was lost arrives again.
-- Rows are purged after 24 h by the cron trigger.
CREATE TABLE tg_updates (
  chat_id     INTEGER NOT NULL,
  update_id   INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, update_id)
);
CREATE INDEX tg_updates_received_at ON tg_updates (received_at);
