import { AppError, ErrorCode } from '../util/errors.js';

/**
 * Query-string parameters.
 *
 * `Number('abc')` is NaN and `Number('2.5')` is not an integer; either one
 * bound to a `LIMIT ?` makes SQLite throw and the route answer 500 for what
 * is a malformed request. Every list route goes through these helpers so a
 * bad `limit` is clamped and a bad cursor is a 422, never an internal error.
 */

/**
 * A page size: the fallback when absent or unparseable, truncated to an
 * integer, and clamped to `[1, max]`.
 */
export function limitParam(raw: string | undefined, fallback: number, max: number): number {
  const ceiling = Math.min(Math.max(Math.trunc(fallback), 1), max);
  if (raw === undefined || raw.trim() === '') return ceiling;
  const value = Number(raw);
  if (!Number.isFinite(value)) return ceiling;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * A pagination cursor or offset: a non-negative integer, or undefined when
 * absent. Anything else is refused with a field error rather than guessed
 * at, because a cursor the client did not mean to send is a page the
 * operator did not ask for.
 */
export function cursorParam(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^\d{1,15}$/.test(raw.trim())) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, `${name} must be a non-negative integer`, {
      errors: [{ path: name, message: 'must be a non-negative integer' }],
    });
  }
  return Number(raw.trim());
}
