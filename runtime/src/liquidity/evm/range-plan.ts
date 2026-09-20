import { AppError, ErrorCode } from '../../util/errors.js';
import { BPS_DENOM, ceilDiv, floorDiv } from '../../risk/money.js';
import {
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  isTickInRange,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  Q96,
} from './tick-math.js';
import type { PositionAmounts } from './tick-math.js';

/**
 * The arithmetic a concentrated-liquidity position needs before it exists.
 *
 * `tick-math.ts` answers the question a position already asks of itself: given
 * liquidity and a range, what is it made of? This file answers the one asked
 * before there is a position at all: given capital and a range, how much
 * liquidity fits, and what does it cost? That is the direction a mint runs in,
 * and it is pure arithmetic, so it can be written and proven long before any
 * transaction exists. Nothing here builds, encodes, signs or sends anything;
 * every function is a pure function of its arguments.
 *
 * Three rules hold throughout.
 *
 *  1. A plan never asks for more than the operator has. Every division that
 *     turns capital into liquidity floors, and the amounts a plan reports are
 *     not recomputed from a second formula — they are exactly what
 *     `getAmountsForLiquidity` returns for the liquidity the plan chose, so a
 *     mint built from a plan and the reader that later values that position
 *     cannot disagree.
 *  2. A tick a pool would reject is never returned. The pool takes only
 *     multiples of its own `tickSpacing` inside [MIN_TICK, MAX_TICK], and the
 *     alignment here is done in bigint with a real floor, because JavaScript's
 *     `/` truncates toward zero and `-7 / 10` truncating to `0` would hand a
 *     pool a tick above the one that was asked for.
 *  3. Rounding that is not forced is resolved in the position's favour, not
 *     the pool's: amounts down, minimums up.
 *
 * References (v3-core / v3-periphery v1.0.0, the tag deployed on Base and the
 * lineage PancakeSwap v3 forked):
 *  - LiquidityAmounts.getLiquidityForAmount0 / getLiquidityForAmount1 /
 *    getLiquidityForAmounts
 *    https://github.com/Uniswap/v3-periphery/blob/v1.0.0/contracts/libraries/LiquidityAmounts.sol
 *  - Tick.tickSpacingToMaxLiquidityPerTick
 *    https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/libraries/Tick.sol
 *  - TickMath.MIN_TICK / MAX_TICK, via `tick-math.ts`
 *    https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/libraries/TickMath.sol
 *  - nearestUsableTick
 *    https://github.com/Uniswap/v3-sdk/blob/v3.9.0/src/utils/nearestUsableTick.ts
 *
 * Money is bigint and results cross the boundary as base-unit decimal strings,
 * as the rest of the liquidity layer does. Ticks and tick spacings cross as
 * `number` because a tick is an int24 index, which a double holds exactly and
 * which is what viem decodes an `int24` into — the same boundary `tick-math.ts`
 * draws. There is no floating-point arithmetic anywhere in this file: every
 * step over a tick is taken in bigint and range-checked back into a number.
 */

/** Uniswap's widest tick spacing; anything above it is not a v3 pool reply. */
const MAX_TICK_SPACING = 16_384;

/** The pool stores liquidity as a uint128; `toUint128` reverts above this. */
const MAX_UINT128 = (1n << 128n) - 1n;

const MIN_TICK_BIG = BigInt(MIN_TICK);
const MAX_TICK_BIG = BigInt(MAX_TICK);
const Q192 = Q96 * Q96;

/** The whole tick range, so a half-width can be checked without overflowing. */
const MAX_HALF_WIDTH_TICKS = MAX_TICK - MIN_TICK;

/** 1,000,000 bps is a hundred-fold move; past that a "width" is not a width. */
const MAX_WIDTH_BPS = 1_000_000;

// --- tick alignment ----------------------------------------------------------

/**
 * Whether a pool would accept this tick as a position bound.
 *
 * Invariant: true exactly when the tick is an integer inside
 * [MIN_TICK, MAX_TICK] and an exact multiple of the spacing — the same test
 * the pool's `mint` applies before it will touch a tick. A tick that is not a
 * usable index is answered `false` rather than thrown, because asking is the
 * point; a spacing that no pool could report is still refused.
 */
export function isUsableTick(tick: number, tickSpacing: number): boolean {
  const spacing = assertTickSpacing(tickSpacing);
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) return false;
  return BigInt(tick) % spacing === 0n;
}

/**
 * The greatest usable tick at or below `tick`.
 *
 * Invariant: the result is usable, and it is at most `tick` — except where
 * flooring would leave the tick range, in which case the lowest usable tick
 * wins, because a tick below MIN_TICK is not a tick the pool has.
 *
 * The flooring is a real floor. `Math.trunc(-7 / 10) * 10` is `0`, which is
 * *above* -7 and on the wrong side of the position's lower bound; below the
 * price of one token1 per token0 — where every USDC-quoted pair on Base
 * lives — that is the entire domain.
 */
export function alignTickDown(tick: number, tickSpacing: number): number {
  const spacing = assertTickSpacing(tickSpacing);
  assertTick(tick, 'tick');
  return intoRange(alignDown(BigInt(tick), spacing), spacing);
}

/**
 * The least usable tick at or above `tick`.
 *
 * Invariant: the mirror of {@link alignTickDown} — usable, and at least
 * `tick` unless that would leave the tick range.
 */
export function alignTickUp(tick: number, tickSpacing: number): number {
  const spacing = assertTickSpacing(tickSpacing);
  assertTick(tick, 'tick');
  return intoRange(alignUp(BigInt(tick), spacing), spacing);
}

/**
 * The usable tick closest to `tick`, ties going up.
 *
 * Invariant: no usable tick is strictly closer to `tick` than the result, and
 * the result is usable. Ties break upward so that this agrees with the v3
 * SDK's `nearestUsableTick`, which rounds with `Math.round`; the direction of
 * the tie matters only for a spacing whose half falls on an integer, and
 * disagreeing with the SDK there would put two tools that quote the same
 * strategy on two different ranges.
 */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
  const spacing = assertTickSpacing(tickSpacing);
  assertTick(tick, 'tick');
  // floor((tick + spacing/2) / spacing), computed without halving anything:
  // the doubled fraction is exact for an odd spacing too.
  const rounded = alignDown(BigInt(tick) * 2n + spacing, spacing * 2n) / 2n;
  return intoRange(rounded, spacing);
}

// --- a range from a width ----------------------------------------------------

/** Which way alignment moves a requested bound. */
export type RangeRounding = 'outward' | 'inward';

/** An aligned, non-empty range. Never a transaction input. */
export interface TickRange {
  tickLower: number;
  tickUpper: number;
}

/**
 * The aligned range a half-width in ticks describes around the pool's tick.
 *
 * The width is in **ticks**, not basis points, because a tick is the pool's own
 * unit of price geometry: `price = 1.0001^tick`, so ±N ticks already is a
 * relative band, and turning a percentage into ticks needs a logarithm, which
 * is not an exact bigint operation. {@link halfWidthTicksForBps} bridges the
 * two by searching the pool's own tick ladder instead of taking a logarithm, so
 * a caller that thinks in percent still never meets a float.
 *
 * `outward` (the default) widens to the enclosing usable ticks, so the range is
 * never narrower than asked: a narrower range is a more concentrated position
 * than the operator sized, which is the error that costs money. `inward`
 * narrows to the enclosed ones for a caller whose width is a cap rather than a
 * target.
 *
 * Invariant: `tickLower < tickUpper`, both usable. A width that leaves nothing
 * between them after alignment is refused rather than returned as an empty
 * range, because the pool would take that mint and the position would hold
 * nothing.
 */
export function rangeFromHalfWidth(
  currentTick: number,
  halfWidthTicks: number,
  tickSpacing: number,
  rounding: RangeRounding = 'outward',
): TickRange {
  const spacing = assertTickSpacing(tickSpacing);
  assertTick(currentTick, 'currentTick');
  if (
    !Number.isInteger(halfWidthTicks) ||
    halfWidthTicks < 0 ||
    halfWidthTicks > MAX_HALF_WIDTH_TICKS
  ) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Range half-width is not a usable tick count', {
      details: { halfWidthTicks, max: MAX_HALF_WIDTH_TICKS },
    });
  }

  const half = BigInt(halfWidthTicks);
  const desiredLower = clamp(BigInt(currentTick) - half);
  const desiredUpper = clamp(BigInt(currentTick) + half);

  const tickLower = intoRange(
    rounding === 'outward' ? alignDown(desiredLower, spacing) : alignUp(desiredLower, spacing),
    spacing,
  );
  const tickUpper = intoRange(
    rounding === 'outward' ? alignUp(desiredUpper, spacing) : alignDown(desiredUpper, spacing),
    spacing,
  );

  if (tickLower >= tickUpper) {
    throw new AppError(
      ErrorCode.SCHEMA_INVALID,
      'Range collapses to zero width at this tick spacing',
      { details: { currentTick, halfWidthTicks, tickSpacing, rounding, tickLower, tickUpper } },
    );
  }
  return { tickLower, tickUpper };
}

/**
 * How many ticks a price move of `bps` basis points spans, rounded down.
 *
 * The bridge from a percentage to the pool's ladder, with no logarithm and no
 * float: a binary search for the largest `t` whose boundary price
 * `getSqrtRatioAtTick(t)^2 / 2^192` is still within `1 + bps/10000`. The
 * comparison is made against the pool's own boundary prices rather than against
 * an ideal `1.0001^t`, so the answer is the tick the pool would actually cross,
 * and where the two differ — `getSqrtRatioAtTick` rounds its last bit up — the
 * result is the tick below. A band built from it is therefore never wider than
 * the percentage asked for, on either side of the price.
 *
 * Invariant: the result is in [0, MAX_TICK] and `price(result) <= 1 + bps/1e4`
 * on the pool's ladder. Small enough basis points do not span a whole tick and
 * answer 0; a caller that then asks for a zero-width range is refused by
 * {@link rangeFromHalfWidth}, not quietly given one tick.
 */
export function halfWidthTicksForBps(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_WIDTH_BPS) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Range width in basis points is out of range', {
      details: { bps, max: MAX_WIDTH_BPS },
    });
  }
  const ceilingX192 = (BPS_DENOM + BigInt(bps)) * Q192;

  let low = 0n;
  let high = MAX_TICK_BIG;
  while (low < high) {
    // Round the probe up, or a search that keeps `low` would not terminate.
    const mid = (low + high + 1n) / 2n;
    const boundary = getSqrtRatioAtTick(Number(mid));
    if (boundary * boundary * BPS_DENOM <= ceilingX192) low = mid;
    else high = mid - 1n;
  }
  return Number(low);
}

// --- the solver --------------------------------------------------------------

/**
 * The liquidity `amount0` buys between two sqrt prices:
 * LiquidityAmounts.getLiquidityForAmount0.
 *
 * `L = amount0 * (a * b / 2^96) / (b - a)`, with both divisions floored in the
 * order the Solidity floors them. Invariant: the result never exceeds the
 * liquidity `amount0` actually supports, because every floor moves it down —
 * so `getAmount0ForLiquidity(a, b, L) <= amount0` for every input.
 */
export function getLiquidityForAmount0(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint,
): bigint {
  const low = sqrtRatioAX96 <= sqrtRatioBX96 ? sqrtRatioAX96 : sqrtRatioBX96;
  const high = sqrtRatioAX96 <= sqrtRatioBX96 ? sqrtRatioBX96 : sqrtRatioAX96;
  assertPositiveSpan(low, high);
  assertAmount(amount0, 'amount0');
  const intermediate = floorDiv(low * high, Q96);
  return floorDiv(amount0 * intermediate, high - low);
}

/**
 * The liquidity `amount1` buys between two sqrt prices:
 * LiquidityAmounts.getLiquidityForAmount1.
 *
 * `L = amount1 * 2^96 / (b - a)`, floored. Invariant: the mirror of
 * {@link getLiquidityForAmount0} — `getAmount1ForLiquidity(a, b, L) <=
 * amount1`.
 */
export function getLiquidityForAmount1(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount1: bigint,
): bigint {
  const low = sqrtRatioAX96 <= sqrtRatioBX96 ? sqrtRatioAX96 : sqrtRatioBX96;
  const high = sqrtRatioAX96 <= sqrtRatioBX96 ? sqrtRatioBX96 : sqrtRatioAX96;
  assertPositiveSpan(low, high);
  assertAmount(amount1, 'amount1');
  return floorDiv(amount1 * Q96, high - low);
}

/**
 * The most liquidity a range can hold without asking for more of either token
 * than is available: LiquidityAmounts.getLiquidityForAmounts.
 *
 * The three cases are the three the pool itself distinguishes, split on the
 * same comparisons `getAmountsForLiquidity` splits on — at or below the range
 * only token0 is spent, above it only token1, and inside it both, with the
 * scarcer side deciding. Matching that split exactly is what makes the pair
 * invertible: the amounts the plan reports for this liquidity are the amounts
 * a reader will later find in the position.
 *
 * Invariant: for the returned `L`, `getAmountsForLiquidity(price, lower, upper,
 * L)` is componentwise at most `(amount0, amount1)`. It is maximal up to the
 * floors of the published formula, which err downward only; a liquidity the
 * pool could not store in its uint128 is refused rather than truncated, as
 * `toUint128` refuses it on chain.
 */
export function maxLiquidityForAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  amount0: bigint,
  amount1: bigint,
): bigint {
  assertSqrtRatio(sqrtPriceX96);
  assertRange(tickLower, tickUpper);
  assertAmount(amount0, 'amount0');
  assertAmount(amount1, 'amount1');

  const lower = getSqrtRatioAtTick(tickLower);
  const upper = getSqrtRatioAtTick(tickUpper);

  let liquidity: bigint;
  if (sqrtPriceX96 <= lower) {
    liquidity = getLiquidityForAmount0(lower, upper, amount0);
  } else if (sqrtPriceX96 < upper) {
    const liquidity0 = getLiquidityForAmount0(sqrtPriceX96, upper, amount0);
    const liquidity1 = getLiquidityForAmount1(lower, sqrtPriceX96, amount1);
    liquidity = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  } else {
    liquidity = getLiquidityForAmount1(lower, upper, amount1);
  }

  if (liquidity > MAX_UINT128) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Position liquidity overflows the pool uint128', {
      details: { liquidity: liquidity.toString(), tickLower, tickUpper },
    });
  }
  return liquidity;
}

/**
 * The most liquidity one tick may carry at a given spacing:
 * Tick.tickSpacingToMaxLiquidityPerTick.
 *
 * The pool divides its uint128 by the number of initialisable ticks so that the
 * sum along a range can never overflow, and reverts a mint that would push a
 * single tick past the quotient. The two divisions by `tickSpacing` here
 * truncate toward zero rather than floor, because the Solidity truncates and
 * this constant has to be the pool's, not the mathematically tidier one.
 *
 * Invariant: a necessary condition on a mint, never a sufficient one — the cap
 * is on a tick's whole gross liquidity, and this build cannot see what other
 * positions already put there.
 */
export function maxLiquidityPerTick(tickSpacing: number): bigint {
  const spacing = assertTickSpacing(tickSpacing);
  // Solidity's `int24 / int24` truncates toward zero, so both bounds move
  // toward the middle. A real floor would put `minTick` one spacing lower and
  // quietly hand back a smaller cap than the pool enforces.
  const minTick = (MIN_TICK_BIG / spacing) * spacing;
  const maxTick = (MAX_TICK_BIG / spacing) * spacing;
  const numTicks = (maxTick - minTick) / spacing + 1n;
  return floorDiv(MAX_UINT128, numTicks);
}

/** Where a price sits relative to a range, by the pool's own fee rule. */
export type RangeSide = 'below' | 'in-range' | 'above';

export interface RangeStatus {
  side: RangeSide;
  /** `tickUpper - tickLower`, always positive. */
  widthTicks: number;
  /** `tick - tickLower`; negative once the price has fallen out below. */
  ticksToLower: number;
  /** `tickUpper - tick`; zero or negative once the price has left above. */
  ticksToUpper: number;
  /** Ticks beyond the nearest bound, zero while in range and at the bound. */
  ticksOutside: number;
  /** {@link ticksOutside} as basis points of the width, rounded up. */
  outsideBps: number;
}

/**
 * Where the pool's tick sits relative to a range, and how far outside it is.
 *
 * `side` is the pool's rule, not a second opinion: it defers to
 * `isTickInRange`, whose upper bound is exclusive because a position at
 * `tickUpper` earns nothing. That rule is about fees, and it parts company with
 * composition at exactly one point — at `tickLower` a position is in range and
 * earning while holding nothing but token0.
 *
 * `outsideBps` rounds up, so a rebalance rule written as "act once a quarter of
 * the width outside" acts at the threshold rather than one tick past it. It is
 * not capped at 10,000: a price three widths away reports 30,000.
 *
 * Invariant: `ticksOutside` is zero if and only if
 * `tickLower <= tick <= tickUpper`, and `side` agrees with `isTickInRange`.
 */
export function rangeStatus(tick: number, tickLower: number, tickUpper: number): RangeStatus {
  assertTick(tick, 'tick');
  assertRange(tickLower, tickUpper);

  const side: RangeSide =
    tick < tickLower ? 'below' : isTickInRange(tick, tickLower, tickUpper) ? 'in-range' : 'above';
  const ticksToLower = tick - tickLower;
  const ticksToUpper = tickUpper - tick;
  const ticksOutside = ticksToLower < 0 ? -ticksToLower : ticksToUpper < 0 ? -ticksToUpper : 0;
  const widthTicks = tickUpper - tickLower;

  return {
    side,
    widthTicks,
    ticksToLower,
    ticksToUpper,
    ticksOutside,
    outsideBps: Number(ceilDiv(BigInt(ticksOutside) * BPS_DENOM, BigInt(widthTicks))),
  };
}

// --- minimums ----------------------------------------------------------------

/** The floors a mint may be given, in base units. */
export interface MinimumAmounts {
  amount0Min: bigint;
  amount1Min: bigint;
}

/**
 * The floors that hold a mint to a slippage tolerance.
 *
 * `amount0Min`/`amount1Min` are what the position manager reverts below: they
 * bound how far the composition a mint actually takes may drift from the one
 * that was planned when the price moves between planning and inclusion. A
 * higher floor is the stricter one, so the division rounds **up** — the
 * position keeps the spare base unit of tolerance rather than handing it to
 * whoever moved the price.
 *
 * Invariant: `0 <= min <= amount` for each side, with equality at zero
 * slippage; at 10,000 bps the floor is zero, which is the caller explicitly
 * accepting anything and is refused by policy elsewhere, not here.
 */
export function minimumAmounts(amounts: PositionAmounts, slippageBps: number): MinimumAmounts {
  assertAmount(amounts.amount0, 'amount0');
  assertAmount(amounts.amount1, 'amount1');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > Number(BPS_DENOM)) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Slippage in basis points is out of range', {
      details: { slippageBps, max: Number(BPS_DENOM) },
    });
  }
  const keep = BPS_DENOM - BigInt(slippageBps);
  return {
    amount0Min: ceilDiv(amounts.amount0 * keep, BPS_DENOM),
    amount1Min: ceilDiv(amounts.amount1 * keep, BPS_DENOM),
  };
}

// --- the plan ----------------------------------------------------------------

export interface RangePlanRequest {
  /** The pool's current price, as `slot0` reports it. */
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  /** Token0 the operator has available, in base units. */
  amount0: bigint;
  /** Token1 the operator has available, in base units. */
  amount1: bigint;
  slippageBps: number;
}

/**
 * Everything a mint would need, and nothing that could send one.
 *
 * Amounts are base-unit decimal strings, as the rest of the liquidity layer
 * passes them.
 */
export interface RangePlan {
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  /** The price the plan was solved at, and the tick it falls in. */
  sqrtPriceX96: string;
  tick: number;
  side: RangeSide;
  liquidity: string;
  /** What that liquidity consumes, floored: `getAmountsForLiquidity` exactly. */
  amount0: string;
  amount1: string;
  /** The floors at the requested slippage. */
  amount0Min: string;
  amount1Min: string;
  /** Capital the range cannot take, because the price is where it is. */
  unused0: string;
  unused1: string;
  slippageBps: number;
  /** This is arithmetic. Nothing here has been built, signed or sent. */
  inspectOnly: true;
}

/**
 * Solve a range against the capital available for it.
 *
 * Invariants, all of them checked in `range-plan.test.ts` rather than asserted
 * in prose:
 *  - `amount0 <= request.amount0` and `amount1 <= request.amount1`; the unused
 *    remainders are exactly the differences and are never negative.
 *  - `(amount0, amount1)` is `getAmountsForLiquidity(sqrtPriceX96, tickLower,
 *    tickUpper, liquidity)` — the same function that will value the position
 *    afterwards, called once here rather than reimplemented.
 *  - below the range only token0 is consumed and above it only token1, on the
 *    price comparison the pool makes, not on the tick.
 *  - `amount0Min <= amount0` and `amount1Min <= amount1`.
 *  - both ticks are usable at the pool's spacing, so no plan describes a
 *    position the pool would refuse to open.
 */
export function planRange(request: RangePlanRequest): RangePlan {
  const { sqrtPriceX96, tickLower, tickUpper, tickSpacing, amount0, amount1 } = request;
  assertSqrtRatio(sqrtPriceX96);
  assertRange(tickLower, tickUpper);
  assertAmount(amount0, 'amount0');
  assertAmount(amount1, 'amount1');
  if (!isUsableTick(tickLower, tickSpacing) || !isUsableTick(tickUpper, tickSpacing)) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'A range bound is not a usable tick', {
      details: { tickLower, tickUpper, tickSpacing },
    });
  }
  if (amount0 === 0n && amount1 === 0n) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'A position cannot be planned with no capital');
  }

  const liquidity = maxLiquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0, amount1);
  const cap = maxLiquidityPerTick(tickSpacing);
  if (liquidity > cap) {
    throw new AppError(
      ErrorCode.SCHEMA_INVALID,
      'Position liquidity exceeds what one tick may carry',
      { details: { liquidity: liquidity.toString(), maxLiquidityPerTick: cap.toString() } },
    );
  }

  const amounts = getAmountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity);
  // Defence in depth against a future edit to either side of the inversion:
  // the whole point of the floors above is that this cannot happen, so if it
  // ever does, nothing downstream should be handed a plan it cannot fund.
  if (amounts.amount0 > amount0 || amounts.amount1 > amount1) {
    throw new AppError(
      ErrorCode.INTERNAL,
      'Planned amounts exceed the capital they were solved from',
      {
        details: {
          planned0: amounts.amount0.toString(),
          planned1: amounts.amount1.toString(),
          available0: amount0.toString(),
          available1: amount1.toString(),
        },
      },
    );
  }

  const minimums = minimumAmounts(amounts, request.slippageBps);
  const tick = getTickAtSqrtRatio(sqrtPriceX96);
  const status = rangeStatus(tick, tickLower, tickUpper);

  return {
    tickLower,
    tickUpper,
    tickSpacing,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick,
    side: status.side,
    liquidity: liquidity.toString(),
    amount0: amounts.amount0.toString(),
    amount1: amounts.amount1.toString(),
    amount0Min: minimums.amount0Min.toString(),
    amount1Min: minimums.amount1Min.toString(),
    unused0: (amount0 - amounts.amount0).toString(),
    unused1: (amount1 - amounts.amount1).toString(),
    slippageBps: request.slippageBps,
    inspectOnly: true,
  };
}

// --- internals ---------------------------------------------------------------

/**
 * The greatest multiple of `spacing` at or below `value`, as a real floor.
 *
 * bigint `/` truncates toward zero exactly as `int24 / int24` does in Solidity,
 * so the quotient of a negative value is one too high whenever the division is
 * inexact. Every tick below a price of 1 is negative, so this correction is not
 * an edge case.
 */
function alignDown(value: bigint, spacing: bigint): bigint {
  const quotient = value / spacing;
  const floored = value % spacing === 0n || value >= 0n ? quotient : quotient - 1n;
  return floored * spacing;
}

/** The least multiple of `spacing` at or above `value`. */
function alignUp(value: bigint, spacing: bigint): bigint {
  const quotient = value / spacing;
  const ceiled = value % spacing === 0n || value <= 0n ? quotient : quotient + 1n;
  return ceiled * spacing;
}

/**
 * The aligned tick pulled back inside [MIN_TICK, MAX_TICK].
 *
 * Alignment can step at most one spacing outside the range, and the widest
 * spacing a v3 pool uses is a rounding error against a range 1,774,544 ticks
 * wide, so one step back is always enough and always lands on a usable tick.
 */
function intoRange(aligned: bigint, spacing: bigint): number {
  if (aligned < MIN_TICK_BIG) return Number(aligned + spacing);
  if (aligned > MAX_TICK_BIG) return Number(aligned - spacing);
  return Number(aligned);
}

/** A desired bound held to the ticks a pool actually has. */
function clamp(tick: bigint): bigint {
  if (tick < MIN_TICK_BIG) return MIN_TICK_BIG;
  if (tick > MAX_TICK_BIG) return MAX_TICK_BIG;
  return tick;
}

function assertTick(tick: number, field: string): void {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, `${field} is outside the v3 tick range`, {
      details: { [field]: tick, min: MIN_TICK, max: MAX_TICK },
    });
  }
}

function assertRange(tickLower: number, tickUpper: number): void {
  assertTick(tickLower, 'tickLower');
  assertTick(tickUpper, 'tickUpper');
  if (tickLower >= tickUpper) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Position range is empty or inverted', {
      details: { tickLower, tickUpper },
    });
  }
}

function assertTickSpacing(tickSpacing: number): bigint {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > MAX_TICK_SPACING) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Tick spacing is not one a v3 pool could report', {
      details: { tickSpacing, max: MAX_TICK_SPACING },
    });
  }
  return BigInt(tickSpacing);
}

function assertSqrtRatio(sqrtPriceX96: bigint): void {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'sqrtPriceX96 is outside the v3 price range', {
      details: { sqrtPriceX96: sqrtPriceX96.toString() },
    });
  }
}

/** Capital is a base-unit count. There is no such thing as a negative one. */
function assertAmount(amount: bigint, field: string): void {
  if (amount < 0n) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, `${field} is negative`, {
      details: { [field]: amount.toString() },
    });
  }
}

/** A liquidity formula divides by the span; a zero span is not a range. */
function assertPositiveSpan(low: bigint, high: bigint): void {
  if (low <= 0n) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'A sqrt price bound is not positive', {
      details: { sqrtRatioX96: low.toString() },
    });
  }
  if (high === low) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'A liquidity range of zero width holds nothing', {
      details: { sqrtRatioX96: low.toString() },
    });
  }
}
