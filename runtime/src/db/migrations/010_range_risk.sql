-- How a v3 rebalance is counted, so that REBALANCE_LIMIT can see one at all.
--
-- 003 counts v2 rebalances in lp_rebalances, and it can: a v2 rebalance is one
-- call against one fungible position, so `bookAdd({ rebalance: true })` bumps a
-- counter and the check reads it. A v3 position cannot be moved. Its tick range
-- is fixed at mint (009 holds the database to that), so rebalancing means
-- burning one tokenId and minting another — one operator decision expressed as
-- two transactions against two different positions.
--
-- The decision this table encodes is that the pair counts once, at the mint:
--
--   * Counting both halves would halve maxRebalancePerDay without ever telling
--     the operator their limit had changed.
--   * Counting the burn would charge a rebalance to a run that burned and then
--     failed to mint, leaving the operator out of the market AND out of a
--     rebalance they never got.
--   * Counting the mint puts the tick where the new exposure appears, which is
--     where v2 already counts it, so one pool's daily figure means the same
--     thing whichever family of position it holds.
--
-- And a table rather than an increment of lp_rebalances, because that counter
-- has nowhere to put the two token ids. A v3 rebalance count that cannot be
-- reconciled against lp_range_events is exactly the kind of number 009 exists
-- not to have; and leaving lp_rebalances alone keeps the v2 counter meaning
-- only what it has always meant. The two are added together in one visible
-- place, LiquidityStore.toRiskSnapshot, which is what the engine reads.
--
-- Same rules as 003, 007 and 009: append-only, PAPER and LIVE never share a
-- row, and nothing here is reachable from the executor, the LP pipeline or the
-- risk engine.
CREATE TABLE lp_range_rebalances (
  id                 TEXT PRIMARY KEY,
  mode               TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  chain              TEXT NOT NULL,
  protocol           TEXT NOT NULL,
  -- The pool the NEW position was minted into. A rebalance usually stays in
  -- its pool, but moving to another fee tier is the same decision, and the
  -- limit is about the pool the operator is now exposed to.
  pool_id            TEXT NOT NULL,
  -- Digits only, canonical, as token ids are stored in lp_range_positions.
  closed_token_id    TEXT NOT NULL
                       CHECK (closed_token_id <> '' AND closed_token_id NOT GLOB '*[^0-9]*'),
  opened_token_id    TEXT NOT NULL
                       CHECK (opened_token_id <> '' AND opened_token_id NOT GLOB '*[^0-9]*'),
  -- Both sides are positions this ledger already knows: a burn it did not book
  -- is a burn it cannot have released cost basis for, so the link is real
  -- rather than a pair of strings that may or may not resolve.
  closed_position_id TEXT NOT NULL REFERENCES lp_range_positions(id),
  opened_position_id TEXT NOT NULL REFERENCES lp_range_positions(id),
  -- The same UTC-day bucket lp_rebalances uses, so counting a day is an
  -- indexed equality rather than a range scan over ISO strings.
  day_start_utc_ms   INTEGER NOT NULL,
  at                 TEXT NOT NULL,
  -- Replacing a position with itself is not a rebalance; on chain it is not
  -- even possible, since the new tokenId is freshly minted.
  CHECK (closed_token_id <> opened_token_id),
  -- A mint happens once, so it can be the second half of at most one
  -- rebalance. This is what stops the same pair being counted twice.
  UNIQUE (mode, chain, protocol, opened_token_id)
);

CREATE INDEX idx_lp_range_rebalances_day
  ON lp_range_rebalances (mode, chain, pool_id, day_start_utc_ms);
CREATE INDEX idx_lp_range_rebalances_closed
  ON lp_range_rebalances (mode, chain, protocol, closed_token_id);

CREATE TRIGGER lp_range_rebalances_no_update
BEFORE UPDATE ON lp_range_rebalances
BEGIN
  SELECT RAISE(ABORT, 'lp_range_rebalances is append-only');
END;

CREATE TRIGGER lp_range_rebalances_no_delete
BEFORE DELETE ON lp_range_rebalances
BEGIN
  SELECT RAISE(ABORT, 'lp_range_rebalances is append-only');
END;
