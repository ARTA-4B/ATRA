-- Password-guess throttling, persisted.
--
-- The counter used to live in the AuthService instance, which made it two
-- things it must not be: forgettable — a restart handed the next guesser a
-- fresh budget of attempts — and invisible to an attempt that had already
-- started, so requests arriving together were all evaluated against a count
-- none of them had updated yet. Both are fixed by keeping the count here and
-- writing it before the key derivation runs.
--
-- One row, like the other singletons in this schema. `failures` is a JSON
-- array of epoch-millisecond timestamps inside the current window, oldest
-- first; `locked_until` is epoch milliseconds, NULL when the password check
-- is open. Milliseconds rather than ISO text because the service compares
-- them against an injectable clock.
CREATE TABLE auth_throttle (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  failures          TEXT NOT NULL DEFAULT '[]',
  locked_until      INTEGER,
  updated_at        TEXT NOT NULL
);
