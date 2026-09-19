-- Phase 4: Telegram control.
--
-- Same rules as before: nothing here stores a bot token, a gateway token or
-- any other secret. Pairing codes are stored only as a SHA-256 of the code,
-- so a copy of the database cannot be used to pair with the bot. The link
-- itself is a Telegram user id, chat id and display name: public identifiers,
-- not credentials.

-- Short-lived single-use pairing challenges. The dashboard shows the code
-- once; the operator sends it to the bot. Verification is an atomic UPDATE
-- (used_at IS NULL AND expires_at > now) so a code can be consumed exactly
-- once even when two attempts race. Issuing a new code invalidates every
-- older unused one.
CREATE TABLE telegram_pair_codes (
  id                TEXT PRIMARY KEY,
  code_hash         TEXT NOT NULL UNIQUE,
  transport         TEXT NOT NULL CHECK (transport IN ('gateway', 'direct')),
  created_at        TEXT NOT NULL,
  expires_at        INTEGER NOT NULL,
  used_at           INTEGER,
  invalidated_at    INTEGER
);

CREATE INDEX idx_telegram_pair_codes_expires ON telegram_pair_codes (expires_at);

-- The one Telegram identity allowed to talk to this installation. A singleton:
-- an installation is paired with at most one Telegram user, and re-pairing
-- replaces the row. The runtime authorises every command against this row
-- regardless of what the gateway forwarded.
CREATE TABLE telegram_link (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  user_id           INTEGER NOT NULL,
  chat_id           INTEGER NOT NULL,
  display_name      TEXT NOT NULL,
  transport         TEXT NOT NULL CHECK (transport IN ('gateway', 'direct')),
  paired_at         TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Replay protection: the highest Telegram update id seen per chat. A command
-- whose update id is not strictly greater than this is dropped. Kept per
-- chat, not per installation, so a foreign chat cannot advance the cursor of
-- the paired one.
CREATE TABLE telegram_chat_cursor (
  chat_id           INTEGER PRIMARY KEY,
  last_update_id    INTEGER NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Notification preferences, the master alert switch, the long-polling offset
-- of the direct transport and the day on which the daily-loss warning fired.
CREATE TABLE telegram_state (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  notify_risk_rejections    INTEGER NOT NULL DEFAULT 1 CHECK (notify_risk_rejections IN (0, 1)),
  notify_trade_decisions    INTEGER NOT NULL DEFAULT 1 CHECK (notify_trade_decisions IN (0, 1)),
  notify_liquidity_updates  INTEGER NOT NULL DEFAULT 1 CHECK (notify_liquidity_updates IN (0, 1)),
  notify_runtime_alerts     INTEGER NOT NULL DEFAULT 1 CHECK (notify_runtime_alerts IN (0, 1)),
  alerts_enabled            INTEGER NOT NULL DEFAULT 1 CHECK (alerts_enabled IN (0, 1)),
  poll_offset               INTEGER,
  daily_loss_warned_day_ms  INTEGER,
  updated_at                TEXT NOT NULL
);

-- Every command the runtime accepted or refused, append-only. Records the
-- command word and the decision, never the message text: a message could
-- contain anything the operator typed by mistake.
CREATE TABLE telegram_commands (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at       TEXT NOT NULL,
  transport         TEXT NOT NULL CHECK (transport IN ('gateway', 'direct')),
  update_id         INTEGER NOT NULL,
  chat_id           INTEGER NOT NULL,
  user_id           INTEGER NOT NULL,
  command           TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN (
                      'ok', 'refused', 'unauthorized', 'replayed', 'stale',
                      'rate_limited', 'failed')),
  detail            TEXT
);

CREATE INDEX idx_telegram_commands_received ON telegram_commands (received_at DESC);

CREATE TRIGGER telegram_commands_no_update
BEFORE UPDATE ON telegram_commands
BEGIN
  SELECT RAISE(ABORT, 'telegram_commands is append-only');
END;

CREATE TRIGGER telegram_commands_no_delete
BEFORE DELETE ON telegram_commands
BEGIN
  SELECT RAISE(ABORT, 'telegram_commands is append-only');
END;
