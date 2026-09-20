import { microsToUsd, usdToMicros } from '../risk/money.js';
import type { BurnRate, Runway } from './types.js';

/**
 * Burn rate and runway.
 *
 * Pure functions over recorded expenses and a priced balance. They never read
 * a clock or the database; the caller passes `now` and the rows, so a figure
 * on the dashboard can be reproduced from the same inputs.
 *
 * Two rules the numbers follow:
 *
 *  - the burn rate is the average over the trailing three calendar months
 *    that actually have expenses, and the result says which months those
 *    were. A single month is labelled as such, because a burn rate built on
 *    one month is a guess with a decimal point;
 *  - runway is `balance / burn`, and it is null with a reason whenever either
 *    side is unknown or the burn is zero. It is never zero, infinity or an
 *    extrapolation from a partial reading.
 */

/** `YYYY-MM` in UTC for the given instant. */
export function periodOf(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The `count` calendar months ending with the one containing `now`, oldest first. */
export function trailingPeriods(now: number | Date, count: number): string[] {
  const date = now instanceof Date ? now : new Date(now);
  const periods: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - back, 1));
    periods.push(periodOf(month));
  }
  return periods;
}

/** The first and last instants of the calendar month containing `now`, as ISO strings. */
export function monthBounds(now: number | Date): { start: string; end: string } {
  const date = now instanceof Date ? now : new Date(now);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

export interface ExpenseLike {
  period: string;
  amountUsd: string;
}

/** Sum a list of USD strings without floats; returns a canonical USD string. */
export function sumUsd(amounts: Iterable<string>): string {
  let total = 0n;
  for (const amount of amounts) total += usdToMicros(amount);
  return microsToUsd(total);
}

/**
 * Average monthly spend over the trailing three calendar months that have
 * recorded expenses. Every status counts (paid, due and payable): a bill that
 * is due is still money the project owes for that month.
 */
export function burnRate(expenses: ExpenseLike[], now: number | Date): BurnRate {
  const windowPeriods = trailingPeriods(now, 3);
  const byPeriod = new Map<string, bigint>();

  for (const expense of expenses) {
    if (!windowPeriods.includes(expense.period)) continue;
    byPeriod.set(
      expense.period,
      (byPeriod.get(expense.period) ?? 0n) + usdToMicros(expense.amountUsd),
    );
  }

  const usedPeriods = windowPeriods.filter((period) => byPeriod.has(period));
  let total = 0n;
  for (const period of usedPeriods) total += byPeriod.get(period) ?? 0n;

  if (usedPeriods.length === 0) {
    return {
      monthlyUsd: null,
      windowPeriods,
      usedPeriods,
      totalUsd: microsToUsd(0n),
      basis: 'none',
      reason: `no expenses recorded for ${windowPeriods[0] ?? '?'} to ${windowPeriods[windowPeriods.length - 1] ?? '?'}`,
    };
  }

  const monthly = total / BigInt(usedPeriods.length);
  const basis: BurnRate['basis'] =
    usedPeriods.length === 3
      ? 'trailing-3'
      : usedPeriods.length === 2
        ? 'trailing-2'
        : 'single-month';

  return {
    monthlyUsd: microsToUsd(monthly),
    windowPeriods,
    usedPeriods,
    totalUsd: microsToUsd(total),
    basis,
    reason:
      basis === 'trailing-3'
        ? null
        : basis === 'single-month'
          ? `based on a single month (${usedPeriods[0] ?? '?'}); treat as an estimate, not a trend`
          : `based on two months (${usedPeriods.join(', ')}), not three`,
  };
}

/**
 * Months of runway, to two decimals, rounded down.
 *
 * `balanceUsd` is the priced treasury balance, or null when it could not be
 * established (an unreadable address, an unpriced asset). The caller decides
 * what "established" means; this function only refuses to divide unknowns.
 */
export function runway(
  balanceUsd: string | null,
  balanceReason: string | null,
  burn: BurnRate,
): Runway {
  if (balanceUsd === null) {
    return {
      months: null,
      balanceUsd: null,
      monthlyBurnUsd: burn.monthlyUsd,
      reason: balanceReason ?? 'the treasury balance could not be priced',
    };
  }
  if (burn.monthlyUsd === null) {
    return {
      months: null,
      balanceUsd,
      monthlyBurnUsd: null,
      reason: burn.reason ?? 'no burn rate',
    };
  }

  const burnMicros = usdToMicros(burn.monthlyUsd);
  if (burnMicros <= 0n) {
    return {
      months: null,
      balanceUsd,
      monthlyBurnUsd: burn.monthlyUsd,
      reason: 'the recorded burn rate is zero; runway is undefined rather than infinite',
    };
  }

  // Two decimals, floored: 1234 / 100 -> "12.34".
  const hundredths = (usdToMicros(balanceUsd) * 100n) / burnMicros;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  return {
    months: `${whole.toString()}.${fraction}`,
    balanceUsd,
    monthlyBurnUsd: burn.monthlyUsd,
    reason: burn.reason,
  };
}
