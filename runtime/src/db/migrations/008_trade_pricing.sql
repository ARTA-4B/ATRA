-- What a trade row needs to be booked after a restart.
--
-- A LIVE transaction that confirms while the process is down has no fill-time
-- prices and no live action object to read decimals from: reconciliation only
-- has the row and the chain's receipt. Until now that meant the row was marked
-- filled and the ledger never heard of the position — deployed capital was
-- under-reported, and the holding could not be closed because no position
-- existed to reduce.
--
-- So the row carries what booking needs. The decimals are the ones the
-- operator allowlisted, not the ones the chain registry happens to ship with:
-- a 6-decimal token that is not in the seed list would otherwise be booked at
-- 18 and be wrong by a factor of 10^12. The prices are the ones the decision
-- was made on, which is not the same thing as the price at the moment the
-- transaction landed; the audit row for such a fill says so.
--
-- Nullable on purpose. Rows written before this migration have nothing here,
-- and reconciliation leaves those unbooked rather than inventing a valuation.
ALTER TABLE trades ADD COLUMN token_in_decimals INTEGER;
ALTER TABLE trades ADD COLUMN token_out_decimals INTEGER;
ALTER TABLE trades ADD COLUMN quote_price_in_usd TEXT;
ALTER TABLE trades ADD COLUMN quote_price_out_usd TEXT;
ALTER TABLE trades ADD COLUMN quote_native_usd TEXT;
