-- Concentrated-liquidity (Uniswap-v3-style) positions: storage only.
--
-- Why a second family of tables rather than columns on lp_positions: a v2
-- position is a fungible ERC-20 LP balance, exactly one per (mode, chain,
-- protocol, pool), and lp_positions states that with its UNIQUE constraint. A
-- v3 position is an ERC-721 — identified by a tokenId, holding a tick range,
-- and a wallet can hold several of them in the same pool at once. Making
-- lp_positions hold both would mean dropping that UNIQUE constraint and
-- teaching every v2 read to skip rows it does not own, in the accounting real
-- money already depends on. Two tables cost one join nobody has to write; one
-- widened table costs the v2 ledger its invariant.
--
-- Same rules as 003 and 007: a USD amount is a decimal string at micro-USD
-- precision, liquidity is a base-unit integer string, never a float. Nothing
-- in this migration is reachable from the executor, the LP pipeline or the
-- risk engine — it is the shelf, not what goes on it.

-- One row per position NFT. The row is the current state of that tokenId and
-- is never deleted: a position closes when its liquidity reaches zero, and the
-- row that says so with a date is the whole point of keeping it.
--
-- What is deliberately NOT here: amount0/amount1. lp_positions stores them
-- because a v2 share of the reserves is a property of the position. A v3
-- position's composition is a property of the *price* — all token0 below its
-- range, all token1 above it — so a stored pair of amounts would be a number
-- that was true once and silently wrong after the next block. What the
-- position is made of belongs to a dated observation, and lives in the mark_*
-- columns with the time it was read.
CREATE TABLE lp_range_positions (
  id                TEXT PRIMARY KEY,
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  chain             TEXT NOT NULL,
  protocol          TEXT NOT NULL,
  pool_id           TEXT NOT NULL,
  -- A uint256 that SQLite's 64-bit INTEGER cannot hold, so text, digits only,
  -- in the same canonical form the runtime writes base-unit amounts in.
  token_id          TEXT NOT NULL CHECK (token_id <> '' AND token_id NOT GLOB '*[^0-9]*'),
  token0            TEXT NOT NULL,
  token1            TEXT NOT NULL,
  decimals0         INTEGER NOT NULL,
  decimals1         INTEGER NOT NULL,
  -- The raw uint24 fee in hundredths of a basis point. Kept even though the
  -- pool implies it: (token0, token1, fee) is how the factory is asked which
  -- pool this is, so a row can be re-derived against the chain on its own.
  fee_pips          INTEGER NOT NULL CHECK (fee_pips > 0 AND fee_pips < 1000000),
  -- Uniswap's MIN_TICK/MAX_TICK. The range is fixed at mint: moving a position
  -- means minting a new tokenId, so these never change (see the trigger below).
  tick_lower        INTEGER NOT NULL CHECK (tick_lower >= -887272 AND tick_lower <= 887272),
  tick_upper        INTEGER NOT NULL CHECK (tick_upper >= -887272 AND tick_upper <= 887272),
  liquidity         TEXT NOT NULL CHECK (liquidity <> '' AND liquidity NOT GLOB '*[^0-9]*'),
  capital_usd       TEXT NOT NULL,
  opened_at         TEXT NOT NULL,
  last_action       TEXT NOT NULL CHECK (last_action IN ('ADD', 'REMOVE', 'EXIT')),
  last_action_at    TEXT NOT NULL,
  closed_at         TEXT,
  mark_value_usd    TEXT,
  mark_fees_usd     TEXT,
  mark_amount0      TEXT,
  mark_amount1      TEXT,
  mark_in_range     INTEGER CHECK (mark_in_range IS NULL OR mark_in_range IN (0, 1)),
  mark_pool_tick    INTEGER,
  mark_note         TEXT,
  marked_at         TEXT,
  -- An empty or inverted range is not a position; the pool itself refuses one.
  CHECK (tick_lower < tick_upper),
  -- "Closed" is not a flag someone sets: it is what zero liquidity means. The
  -- database holds the two in step so no code path can report a closed
  -- position that still has liquidity, or liquidity nobody can see.
  CHECK ((liquidity = '0') = (closed_at IS NOT NULL)),
  -- A tokenId is minted once per position manager, so it identifies the
  -- position on its own; the pool is a property of it, not part of its key.
  -- PAPER and LIVE still never share a row, as everywhere else.
  UNIQUE (mode, chain, protocol, token_id)
);

-- Several positions in one pool is the normal case, not the exception.
CREATE INDEX idx_lp_range_positions_pool ON lp_range_positions (mode, chain, protocol, pool_id);
CREATE INDEX idx_lp_range_positions_open ON lp_range_positions (mode, closed_at, opened_at);

CREATE TRIGGER lp_range_positions_immutable
BEFORE UPDATE ON lp_range_positions
WHEN OLD.id IS NOT NEW.id
  OR OLD.mode IS NOT NEW.mode
  OR OLD.chain IS NOT NEW.chain
  OR OLD.protocol IS NOT NEW.protocol
  OR OLD.pool_id IS NOT NEW.pool_id
  OR OLD.token_id IS NOT NEW.token_id
  OR OLD.token0 IS NOT NEW.token0
  OR OLD.token1 IS NOT NEW.token1
  OR OLD.decimals0 IS NOT NEW.decimals0
  OR OLD.decimals1 IS NOT NEW.decimals1
  OR OLD.fee_pips IS NOT NEW.fee_pips
  OR OLD.tick_lower IS NOT NEW.tick_lower
  OR OLD.tick_upper IS NOT NEW.tick_upper
  OR OLD.opened_at IS NOT NEW.opened_at
BEGIN
  SELECT RAISE(ABORT, 'a range position''s identity and tick range are immutable');
END;

CREATE TRIGGER lp_range_positions_no_delete
BEFORE DELETE ON lp_range_positions
BEGIN
  SELECT RAISE(ABORT, 'lp_range_positions is append-only; a position closes at zero liquidity');
END;

-- Every change to a position's liquidity, immutable, in the same relationship
-- to lp_range_positions that lp_actions has to lp_positions: the mutable row
-- is the current state and is rebuilt from these if it is ever in doubt.
-- lp_actions cannot serve here because it has no tokenId column — its rows are
-- keyed by pool, and a pool holds many range positions.
--
-- Deltas are signed: a burn is '-1500', and `*_after` records what the
-- position held once the row was applied, so a disagreement between the log
-- and the row is visible without replaying the whole log.
CREATE TABLE lp_range_events (
  id                TEXT PRIMARY KEY,
  position_id       TEXT NOT NULL REFERENCES lp_range_positions(id),
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  chain             TEXT NOT NULL,
  protocol          TEXT NOT NULL,
  pool_id           TEXT NOT NULL,
  token_id          TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('ADD', 'REMOVE', 'EXIT')),
  liquidity_delta   TEXT NOT NULL,
  liquidity_after   TEXT NOT NULL,
  capital_delta_usd TEXT NOT NULL,
  capital_after_usd TEXT NOT NULL,
  at                TEXT NOT NULL
);

CREATE INDEX idx_lp_range_events_at ON lp_range_events (at DESC);
CREATE INDEX idx_lp_range_events_token ON lp_range_events (mode, chain, protocol, token_id, at DESC);

CREATE TRIGGER lp_range_events_no_update
BEFORE UPDATE ON lp_range_events
BEGIN
  SELECT RAISE(ABORT, 'lp_range_events is append-only');
END;

CREATE TRIGGER lp_range_events_no_delete
BEFORE DELETE ON lp_range_events
BEGIN
  SELECT RAISE(ABORT, 'lp_range_events is append-only');
END;
