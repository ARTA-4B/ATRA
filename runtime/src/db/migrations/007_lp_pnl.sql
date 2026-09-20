-- What an LP action realized, in the table the daily-loss check reads.
--
-- The check reads LedgerService.realizedPnlTodayUsd, which summed `fills`
-- alone, and no LP executor writes a fill. So two LP exits that realized 80
-- USD of impermanent loss plus 4 USD of gas left the engine reporting
-- "today 0.000000" and the next add sailed through the cap.
--
-- The LP side gets its own table rather than rows in `fills` because an LP
-- action is not a swap: an add sends two assets and receives LP tokens, a
-- burn does the reverse, and both are valued against the cost basis held in
-- `lp_positions`, not against the average cost basis `fills` maintains in
-- `positions`. Writing them as fills would move position rows no LP action
-- owns. `realizedPnlTodayUsd` sums both tables instead, so an LP loss reaches
-- the cap exactly as a swap loss does.
--
-- Append-only like `fills` and `lp_actions`: what was realized is history.
-- `trade_id` is nullable and unconstrained, as in `lp_actions`, so a row
-- reconciled without its trade can still be recorded rather than dropped.
CREATE TABLE lp_pnl (
  id                TEXT PRIMARY KEY,
  trade_id          TEXT,
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
  chain             TEXT NOT NULL,
  protocol          TEXT NOT NULL,
  pool_id           TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('HOLD', 'ADD', 'REMOVE', 'REBALANCE', 'COLLECT_FEES', 'EXIT')),
  proceeds_usd      TEXT NOT NULL,
  cost_released_usd TEXT NOT NULL,
  fee_usd           TEXT NOT NULL,
  realized_pnl_usd  TEXT NOT NULL,
  at                TEXT NOT NULL,
  simulated         INTEGER NOT NULL CHECK (simulated IN (0, 1))
);

CREATE INDEX idx_lp_pnl_at ON lp_pnl (mode, at DESC);

CREATE TRIGGER lp_pnl_no_update
BEFORE UPDATE ON lp_pnl
BEGIN
  SELECT RAISE(ABORT, 'lp_pnl is append-only');
END;

CREATE TRIGGER lp_pnl_no_delete
BEFORE DELETE ON lp_pnl
BEGIN
  SELECT RAISE(ABORT, 'lp_pnl is append-only');
END;
