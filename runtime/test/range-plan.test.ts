import { describe, expect, it } from 'vitest';
import {
  alignTickDown,
  alignTickUp,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  halfWidthTicksForBps,
  isUsableTick,
  maxLiquidityForAmounts,
  maxLiquidityPerTick,
  minimumAmounts,
  nearestUsableTick,
  planRange,
  rangeFromHalfWidth,
  rangeStatus,
} from '../src/liquidity/evm/range-plan.js';
import * as rangePlanModule from '../src/liquidity/evm/range-plan.js';
import {
  getAmount0ForLiquidity,
  getAmount1ForLiquidity,
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  MAX_TICK,
  MIN_TICK,
  Q96,
} from '../src/liquidity/evm/tick-math.js';
import { AppError, ErrorCode } from '../src/util/errors.js';

/**
 * The arithmetic that has to be right before a position can be opened.
 *
 * Two kinds of claim are on trial. The first is agreement with things that
 * exist outside this repository: the tick ladder the pool indexes prices by,
 * the published `LiquidityAmounts` formulas, and the per-tick liquidity cap the
 * v3 core tests pin. The second is the one that protects the operator's money —
 * that a plan never asks for more of either token than it was given. That one
 * is not asserted at a handful of points but swept across the whole price line
 * and checked by round-tripping through `getAmountsForLiquidity`, because it is
 * the property a mint would rely on and an off-by-one in a floor is exactly how
 * it would be lost.
 *
 * Where a number can be worked out by hand it is written out here rather than
 * taken from the code under test, so the two cannot agree by construction.
 */

/** Uniswap v3 WETH/USDC 0.05% on Base, `slot0` at block 51569133. */
const BASE_SQRT = 4057719202767049541567034n;
const BASE_TICK = -197600;

/** A range that straddles that price, aligned to the pool's spacing of 10. */
const LOWER = -197700;
const UPPER = -197500;

/** One WETH and three thousand USDC, in base units. */
const ONE_WETH = 1_000_000_000_000_000_000n;
const THREE_K_USDC = 3_000_000_000n;

function expectAppError(fn: () => unknown): AppError {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught).not.toBeInstanceOf(TypeError);
  return caught as AppError;
}

// --- tick alignment ----------------------------------------------------------

describe('alignTickDown / alignTickUp', () => {
  it('rounds a positive tick to the spacing either side of it', () => {
    expect(alignTickDown(7, 10)).toBe(0);
    expect(alignTickUp(7, 10)).toBe(10);
    expect(alignTickDown(197_601, 60)).toBe(197_580);
    expect(alignTickUp(197_601, 60)).toBe(197_640);
  });

  it('floors a negative tick instead of truncating it toward zero', () => {
    // The trap: `Math.trunc(-7 / 10) * 10` is 0, which is *above* -7, so a
    // lower bound built that way sits inside the range that was asked for and
    // a caller never sees the difference until the position is the wrong one.
    expect(alignTickDown(-7, 10)).toBe(-10);
    expect(alignTickUp(-7, 10)).toBe(0);
    expect(alignTickDown(-197_601, 60)).toBe(-197_640);
    expect(alignTickUp(-197_601, 60)).toBe(-197_580);
  });

  it('leaves a tick that is already on a boundary exactly where it is', () => {
    for (const [tick, spacing] of [
      [0, 60],
      [-60, 60],
      [60, 60],
      [-197_700, 10],
      [-197_640, 60],
    ] as const) {
      expect(alignTickDown(tick, spacing)).toBe(tick);
      expect(alignTickUp(tick, spacing)).toBe(tick);
    }
  });

  it('brackets every tick it is given, at every spacing a pool uses', () => {
    const wrong: string[] = [];
    for (const spacing of [1, 10, 50, 60, 100, 200, 16_384]) {
      for (let tick = -400_000; tick <= 400_000; tick += 997) {
        const down = alignTickDown(tick, spacing);
        const up = alignTickUp(tick, spacing);
        // `down` is the greatest usable tick at or below, so one spacing more
        // is already past the tick; `up` is the least one at or above.
        const bracketed =
          down <= tick && tick <= up && down + spacing > tick && up - spacing < tick;
        const usable = isUsableTick(down, spacing) && isUsableTick(up, spacing);
        if (!bracketed || !usable) wrong.push(`${tick}/${spacing}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('stays inside the tick range at both ends, where the pool has nothing further', () => {
    // -887280 and 887280 are the true multiples of 60 outside the bounds, and
    // no pool has them: the bound wins and the nearest usable tick is returned.
    expect(alignTickDown(MIN_TICK, 60)).toBe(-887_220);
    expect(alignTickUp(MAX_TICK, 60)).toBe(887_220);
    expect(isUsableTick(alignTickDown(MIN_TICK, 60), 60)).toBe(true);
    expect(isUsableTick(alignTickUp(MAX_TICK, 60), 60)).toBe(true);

    // At a spacing of 1 every tick is usable, so the bounds are themselves.
    expect(alignTickDown(MIN_TICK, 1)).toBe(MIN_TICK);
    expect(alignTickUp(MAX_TICK, 1)).toBe(MAX_TICK);
  });

  it('refuses a spacing no pool could report', () => {
    for (const spacing of [0, -10, 1.5, 16_385, Number.NaN]) {
      expect(expectAppError(() => alignTickDown(0, spacing)).code).toBe(ErrorCode.SCHEMA_INVALID);
      expect(expectAppError(() => alignTickUp(0, spacing)).message).toMatch(/Tick spacing/);
    }
  });

  it('refuses a tick that could not have come from a pool', () => {
    for (const tick of [MIN_TICK - 1, MAX_TICK + 1, 1.5]) {
      expect(expectAppError(() => alignTickDown(tick, 60)).code).toBe(ErrorCode.SCHEMA_INVALID);
      expect(expectAppError(() => alignTickUp(tick, 60)).code).toBe(ErrorCode.SCHEMA_INVALID);
    }
  });
});

describe('nearestUsableTick', () => {
  it('rounds to the closer side, and ties upward', () => {
    expect(nearestUsableTick(4, 10)).toBe(0);
    expect(nearestUsableTick(6, 10)).toBe(10);
    expect(nearestUsableTick(-6, 10)).toBe(-10);
    expect(nearestUsableTick(-4, 10)).toBe(0);
    // Exactly halfway, on both sides of zero: the v3 SDK's `Math.round` takes
    // the upper tick for both, and so must this or the two disagree on a
    // boundary that a strategy sitting on a tick midpoint would hit.
    expect(nearestUsableTick(5, 10)).toBe(10);
    expect(nearestUsableTick(-5, 10)).toBe(0);
    expect(nearestUsableTick(-15, 10)).toBe(-10);
  });

  it('agrees with the v3 SDK formula across the tick range', () => {
    const wrong: string[] = [];
    for (const spacing of [1, 3, 10, 60, 200]) {
      for (let tick = -400_000; tick <= 400_000; tick += 331) {
        // The SDK's own line. The double division is exact here: a tie is a
        // value of the form k + 1/2, which IEEE 754 represents exactly at this
        // magnitude, so this oracle owes nothing to the code under test.
        const rounded = Math.round(tick / spacing) * spacing;
        if (nearestUsableTick(tick, spacing) !== (rounded === 0 ? 0 : rounded)) {
          wrong.push(`${tick}/${spacing}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('never rounds out of the tick range', () => {
    expect(nearestUsableTick(MIN_TICK, 60)).toBe(-887_220);
    expect(nearestUsableTick(MAX_TICK, 60)).toBe(887_220);
    expect(nearestUsableTick(MAX_TICK, 16_384)).toBe(884_736);
  });
});

describe('isUsableTick', () => {
  it('accepts only an in-range multiple of the spacing', () => {
    expect(isUsableTick(0, 60)).toBe(true);
    expect(isUsableTick(-197_700, 10)).toBe(true);
    expect(isUsableTick(-197_700, 60)).toBe(true);
    expect(isUsableTick(-197_701, 60)).toBe(false);
    expect(isUsableTick(1.5, 60)).toBe(false);
    // A multiple of the spacing, but outside the range the pool indexes.
    expect(isUsableTick(-887_280, 60)).toBe(false);
    expect(isUsableTick(887_280, 60)).toBe(false);
  });

  it('refuses a spacing no pool could report, rather than answering it', () => {
    expect(expectAppError(() => isUsableTick(0, 0)).code).toBe(ErrorCode.SCHEMA_INVALID);
  });
});

// --- a range from a width ----------------------------------------------------

describe('rangeFromHalfWidth', () => {
  it('widens to the enclosing usable ticks by default', () => {
    // ±99 ticks around -197600 is [-197699, -197501]; at a spacing of 10 the
    // enclosing bounds are the round hundreds either side.
    expect(rangeFromHalfWidth(BASE_TICK, 99, 10)).toEqual({
      tickLower: -197_700,
      tickUpper: -197_500,
    });
    // At a spacing of 60 the same request is pushed further out both ways.
    expect(rangeFromHalfWidth(BASE_TICK, 99, 60)).toEqual({
      tickLower: -197_700,
      tickUpper: -197_460,
    });
  });

  it('narrows to the enclosed usable ticks when asked to round inward', () => {
    expect(rangeFromHalfWidth(BASE_TICK, 99, 60, 'inward')).toEqual({
      tickLower: -197_640,
      tickUpper: -197_520,
    });
  });

  it('never returns a band on the wrong side of the one that was asked for', () => {
    const wrong: string[] = [];
    let collapses = 0;
    for (const spacing of [1, 10, 60, 200]) {
      for (let tick = -300_000; tick <= 300_000; tick += 1_013) {
        for (const half of [1, 60, 99, 500]) {
          const out = rangeFromHalfWidth(tick, half, spacing, 'outward');
          if (out.tickLower > tick - half || out.tickUpper < tick + half) {
            wrong.push(`outward ${tick}/${spacing}/${half}`);
          }
          // Rounding inward can leave nothing between the bounds, and when it
          // does the only acceptable answer is the refusal — never a band on
          // the wrong side of the width, and never an empty one.
          try {
            const inward = rangeFromHalfWidth(tick, half, spacing, 'inward');
            if (inward.tickLower < tick - half || inward.tickUpper > tick + half) {
              wrong.push(`inward ${tick}/${spacing}/${half}`);
            }
            if (inward.tickLower >= inward.tickUpper)
              wrong.push(`empty ${tick}/${spacing}/${half}`);
          } catch (error) {
            collapses += 1;
            if (!(error instanceof AppError) || !/collapses to zero width/.test(error.message)) {
              wrong.push(`inward threw ${String(error)} at ${tick}/${spacing}/${half}`);
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(collapses).toBeGreaterThan(0);
  });

  it('refuses a width that collapses to nothing once it is aligned', () => {
    // Half a spacing either side, rounded inward, meets in the middle: both
    // bounds land on -197580 and the position would hold nothing at all.
    const collapsed = expectAppError(() => rangeFromHalfWidth(BASE_TICK, 20, 60, 'inward'));
    expect(collapsed.code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(collapsed.message).toMatch(/collapses to zero width/);
    expect(collapsed.details?.['tickLower']).toBe(collapsed.details?.['tickUpper']);

    // And outward, the degenerate request: no width at all on a tick that is
    // already aligned, so there is nothing for alignment to open up.
    expect(expectAppError(() => rangeFromHalfWidth(-197_640, 0, 60)).message).toMatch(
      /collapses to zero width/,
    );
    expect(expectAppError(() => rangeFromHalfWidth(0, 0, 1)).message).toMatch(
      /collapses to zero width/,
    );
  });

  it('clamps a width wider than the tick range to the ticks that exist', () => {
    // ±1,500,000 ticks around the pool's tick runs off both ends of the ladder.
    const range = rangeFromHalfWidth(BASE_TICK, 1_500_000, 60);

    expect(range.tickLower).toBe(-887_220);
    expect(range.tickUpper).toBe(887_220);
    expect(isUsableTick(range.tickLower, 60)).toBe(true);
    expect(isUsableTick(range.tickUpper, 60)).toBe(true);
  });

  it('refuses a half-width that is not a tick count', () => {
    for (const half of [-1, 1.5, 2_000_000]) {
      expect(expectAppError(() => rangeFromHalfWidth(BASE_TICK, half, 60)).code).toBe(
        ErrorCode.SCHEMA_INVALID,
      );
    }
    expect(expectAppError(() => rangeFromHalfWidth(BASE_TICK, 60, 0)).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
  });
});

describe('halfWidthTicksForBps', () => {
  it('spans the ticks a percentage move covers, without overshooting it', () => {
    // 1.0001^99 = 1.00994…, still inside 1%; 1.0001^100 = 1.01005… is not.
    expect(halfWidthTicksForBps(100)).toBe(99);
    // A doubling is ln(2)/ln(1.0001) = 6931.47… ticks.
    expect(halfWidthTicksForBps(10_000)).toBe(6_931);
    expect(halfWidthTicksForBps(10)).toBe(9);
    expect(halfWidthTicksForBps(1_000)).toBe(953);
  });

  it('is checked against the pool ladder, not against this module', () => {
    // The invariant spelled out: the boundary price at the tick returned is
    // inside the requested ratio, and the next tick up is not.
    const wrong: number[] = [];
    for (const bps of [2, 10, 50, 100, 250, 500, 1_000, 10_000]) {
      const ticks = halfWidthTicksForBps(bps);
      const inside = getSqrtRatioAtTick(ticks) ** 2n * 10_000n;
      const past = getSqrtRatioAtTick(ticks + 1) ** 2n * 10_000n;
      const ceiling = BigInt(10_000 + bps) * Q96 * Q96;
      if (inside > ceiling || past <= ceiling) wrong.push(bps);
    }
    expect(wrong).toEqual([]);
  });

  it('answers zero for a move too small to reach the next tick', () => {
    // One tick *is* one basis point, but the pool's boundary price at tick 1 is
    // `getSqrtRatioAtTick(1)`, whose last bit is rounded up and therefore sits
    // a hair above 1.0001. Answering 0 keeps the band inside the width asked
    // for; a caller who then wants a range is refused by `rangeFromHalfWidth`
    // rather than quietly given one tick.
    expect(halfWidthTicksForBps(1)).toBe(0);
    expect(halfWidthTicksForBps(0)).toBe(0);
    expect(halfWidthTicksForBps(2)).toBe(1);
  });

  it('never moves backwards as the width grows', () => {
    let previous = -1;
    for (let bps = 0; bps <= 5_000; bps += 37) {
      const ticks = halfWidthTicksForBps(bps);
      expect(ticks).toBeGreaterThanOrEqual(previous);
      previous = ticks;
    }
  });

  it('refuses a width that is not basis points', () => {
    for (const bps of [-1, 0.5, 1_000_001]) {
      expect(expectAppError(() => halfWidthTicksForBps(bps)).code).toBe(ErrorCode.SCHEMA_INVALID);
    }
  });
});

// --- the liquidity formulas --------------------------------------------------

describe('getLiquidityForAmount0 / getLiquidityForAmount1', () => {
  // Between sqrt ratios 2^96 (price 1) and 2^97 (price 4) the formulas reduce
  // to L = 2 * amount0 and L = amount1, worked out by hand from the published
  // formulas and owing nothing to the code under test. They are the exact
  // inverses of the amounts `tick-math.test.ts` pins at the same two ratios.
  const LOW = Q96;
  const HIGH = Q96 * 2n;

  it('inverts the amount formulas at a hand-checkable range', () => {
    expect(getLiquidityForAmount0(LOW, HIGH, ONE_WETH)).toBe(ONE_WETH * 2n);
    expect(getLiquidityForAmount1(LOW, HIGH, ONE_WETH)).toBe(ONE_WETH);

    expect(getAmount0ForLiquidity(LOW, HIGH, getLiquidityForAmount0(LOW, HIGH, ONE_WETH))).toBe(
      ONE_WETH,
    );
    expect(getAmount1ForLiquidity(LOW, HIGH, getLiquidityForAmount1(LOW, HIGH, ONE_WETH))).toBe(
      ONE_WETH,
    );
  });

  it('does not care which way round the two ratios are given', () => {
    expect(getLiquidityForAmount0(HIGH, LOW, ONE_WETH)).toBe(ONE_WETH * 2n);
    expect(getLiquidityForAmount1(HIGH, LOW, ONE_WETH)).toBe(ONE_WETH);
  });

  it('buys nothing with nothing', () => {
    expect(getLiquidityForAmount0(LOW, HIGH, 0n)).toBe(0n);
    expect(getLiquidityForAmount1(LOW, HIGH, 0n)).toBe(0n);
  });

  it('refuses a zero-width span and a negative amount', () => {
    expect(expectAppError(() => getLiquidityForAmount0(LOW, LOW, ONE_WETH)).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
    expect(expectAppError(() => getLiquidityForAmount1(LOW, LOW, ONE_WETH)).message).toMatch(
      /zero width/,
    );
    expect(expectAppError(() => getLiquidityForAmount0(0n, HIGH, ONE_WETH)).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
    expect(expectAppError(() => getLiquidityForAmount0(LOW, HIGH, -1n)).message).toMatch(
      /amount0 is negative/,
    );
    expect(expectAppError(() => getLiquidityForAmount1(LOW, HIGH, -1n)).message).toMatch(
      /amount1 is negative/,
    );
  });
});

describe('maxLiquidityForAmounts', () => {
  it('spends only token0 when the price is at or below the range', () => {
    const price = getSqrtRatioAtTick(-198_000);
    const liquidity = maxLiquidityForAmounts(price, LOWER, UPPER, ONE_WETH, THREE_K_USDC);
    const amounts = getAmountsForLiquidity(price, LOWER, UPPER, liquidity);

    expect(amounts.amount1).toBe(0n);
    expect(amounts.amount0).toBeGreaterThan(0n);
    expect(amounts.amount0).toBeLessThanOrEqual(ONE_WETH);
    // Whatever token1 was offered is untouched: below its range the position
    // is entirely token0, so the other leg cannot buy any liquidity at all.
    expect(maxLiquidityForAmounts(price, LOWER, UPPER, 0n, THREE_K_USDC)).toBe(0n);
    // And the token0 leg alone buys exactly the same liquidity.
    expect(maxLiquidityForAmounts(price, LOWER, UPPER, ONE_WETH, 0n)).toBe(liquidity);
  });

  it('spends only token1 when the price is at or above the range', () => {
    const price = getSqrtRatioAtTick(-197_000);
    const liquidity = maxLiquidityForAmounts(price, LOWER, UPPER, ONE_WETH, THREE_K_USDC);
    const amounts = getAmountsForLiquidity(price, LOWER, UPPER, liquidity);

    expect(amounts.amount0).toBe(0n);
    expect(amounts.amount1).toBeGreaterThan(0n);
    expect(amounts.amount1).toBeLessThanOrEqual(THREE_K_USDC);
    expect(maxLiquidityForAmounts(price, LOWER, UPPER, ONE_WETH, 0n)).toBe(0n);
    // The whole token1 leg is taken but for a base unit the floor keeps back.
    expect(THREE_K_USDC - amounts.amount1).toBeLessThanOrEqual(1n);
  });

  it('lets the scarcer side decide in range, on the published formula', () => {
    // Both legs written out from LiquidityAmounts, inline, so a swapped bound
    // or a division in the wrong order would not cancel out.
    const lower = getSqrtRatioAtTick(LOWER);
    const upper = getSqrtRatioAtTick(UPPER);
    const liquidity0 = (ONE_WETH * ((BASE_SQRT * upper) / Q96)) / (upper - BASE_SQRT);
    const liquidity1 = (THREE_K_USDC * Q96) / (BASE_SQRT - lower);

    expect(liquidity0).toBeLessThan(liquidity1);
    expect(maxLiquidityForAmounts(BASE_SQRT, LOWER, UPPER, ONE_WETH, THREE_K_USDC)).toBe(
      liquidity0,
    );

    // With only a third of the USDC the other leg binds, and the answer follows
    // it rather than staying on the side it was on.
    const liquidity1Small = (1_000_000_000n * Q96) / (BASE_SQRT - lower);
    expect(maxLiquidityForAmounts(BASE_SQRT, LOWER, UPPER, ONE_WETH, 1_000_000_000n)).toBe(
      liquidity1Small,
    );
  });

  it('splits on the price, not on the tick, at the lower bound', () => {
    // At exactly `getSqrtRatioAtTick(tickLower)` the pool's tick is tickLower,
    // so the position is in range and earning — and yet it is all token0. The
    // solver has to take the price branch here or it would size the position
    // against a token1 leg that will not be spent.
    const price = getSqrtRatioAtTick(LOWER);
    const liquidity = maxLiquidityForAmounts(price, LOWER, UPPER, ONE_WETH, THREE_K_USDC);
    const amounts = getAmountsForLiquidity(price, LOWER, UPPER, liquidity);

    expect(rangeStatus(LOWER, LOWER, UPPER).side).toBe('in-range');
    expect(amounts.amount1).toBe(0n);
    expect(amounts.amount0).toBeGreaterThan(0n);
    expect(liquidity).toBe(getLiquidityForAmount0(price, getSqrtRatioAtTick(UPPER), ONE_WETH));
  });

  it('never asks for more than it was given, anywhere on the price line', () => {
    // The property a mint depends on, swept rather than sampled: prices from
    // far below the range to far above it, through both of its boundaries.
    const overspent: string[] = [];
    let ranBelow = false;
    let ranInside = false;
    let ranAbove = false;

    const ticks: number[] = [];
    for (let tick = -300_000; tick <= -100_000; tick += 977) ticks.push(tick);
    // And a fine pass over the range itself and both of its boundaries, which
    // a coarse stride steps straight over.
    for (let tick = LOWER - 30; tick <= UPPER + 30; tick += 7) ticks.push(tick);

    for (const tick of ticks) {
      const price = getSqrtRatioAtTick(tick);
      const liquidity = maxLiquidityForAmounts(price, LOWER, UPPER, ONE_WETH, THREE_K_USDC);
      const amounts = getAmountsForLiquidity(price, LOWER, UPPER, liquidity);

      if (amounts.amount0 > ONE_WETH || amounts.amount1 > THREE_K_USDC) {
        overspent.push(`${tick}: ${amounts.amount0}/${amounts.amount1}`);
      }
      if (tick < LOWER) ranBelow = true;
      else if (tick < UPPER) ranInside = true;
      else ranAbove = true;
    }

    expect(overspent).toEqual([]);
    expect([ranBelow, ranInside, ranAbove]).toEqual([true, true, true]);
  });

  it('leaves at most dust on the side that binds', () => {
    // Tightness, not just safety: a solver that returned half the liquidity
    // that fits would pass every "never exceeds" assertion above.
    const below = getSqrtRatioAtTick(-198_000);
    const belowAmounts = getAmountsForLiquidity(
      below,
      LOWER,
      UPPER,
      maxLiquidityForAmounts(below, LOWER, UPPER, ONE_WETH, THREE_K_USDC),
    );
    expect(ONE_WETH - belowAmounts.amount0).toBeLessThan(1_000n);

    const insideAmounts = getAmountsForLiquidity(
      BASE_SQRT,
      LOWER,
      UPPER,
      maxLiquidityForAmounts(BASE_SQRT, LOWER, UPPER, ONE_WETH, THREE_K_USDC),
    );
    // Token0 binds at this price, so it is token0 that must be all but spent;
    // the leftover USDC is the honest answer, not a rounding failure.
    expect(ONE_WETH - insideAmounts.amount0).toBeLessThan(1_000n);
    expect(insideAmounts.amount1).toBeLessThan(THREE_K_USDC);
  });

  it('refuses a liquidity the pool could not store', () => {
    // uint128 is the pool's own width, and `toUint128` reverts above it: the
    // number is correct, the position is impossible, and saying so here is
    // cheaper than finding out from a reverted transaction.
    const error = expectAppError(() =>
      maxLiquidityForAmounts(BASE_SQRT, LOWER, UPPER, 1n << 200n, 1n << 200n),
    );

    expect(error.code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(error.message).toMatch(/overflows the pool uint128/);
  });

  it('refuses an inverted range, a negative amount and an impossible price', () => {
    expect(
      expectAppError(() => maxLiquidityForAmounts(BASE_SQRT, UPPER, LOWER, ONE_WETH, 0n)).message,
    ).toMatch(/empty or inverted/);
    expect(
      expectAppError(() => maxLiquidityForAmounts(BASE_SQRT, LOWER, LOWER, ONE_WETH, 0n)).code,
    ).toBe(ErrorCode.SCHEMA_INVALID);
    expect(
      expectAppError(() => maxLiquidityForAmounts(BASE_SQRT, LOWER, UPPER, -1n, 0n)).message,
    ).toMatch(/negative/);
    expect(expectAppError(() => maxLiquidityForAmounts(0n, LOWER, UPPER, 1n, 1n)).message).toMatch(
      /sqrtPriceX96 is outside/,
    );
  });
});

describe('maxLiquidityPerTick', () => {
  it('matches the constants the v3 core tests pin', () => {
    // From Tick.spec.ts in v3-core: the cap is uint128 max divided by the
    // number of initialisable ticks, with both bounds truncated toward zero
    // the way Solidity truncates them.
    expect(maxLiquidityPerTick(1)).toBe(191757530477355301479181766273477n);
    expect(maxLiquidityPerTick(10)).toBe(1917569901783203986719870431555990n);
    expect(maxLiquidityPerTick(60)).toBe(11505743598341114571880798222544994n);
    expect(maxLiquidityPerTick(200)).toBe(38350317471085141830651933667504588n);
  });

  it('grows with the spacing and stays inside a uint128', () => {
    expect(maxLiquidityPerTick(10)).toBeGreaterThan(maxLiquidityPerTick(1));
    expect(maxLiquidityPerTick(200)).toBeGreaterThan(maxLiquidityPerTick(60));
    expect(maxLiquidityPerTick(16_384)).toBeLessThan(1n << 128n);
  });

  it('refuses a spacing no pool could report', () => {
    expect(expectAppError(() => maxLiquidityPerTick(0)).code).toBe(ErrorCode.SCHEMA_INVALID);
  });
});

// --- minimums ----------------------------------------------------------------

describe('minimumAmounts', () => {
  it('rounds the floor up, toward the position', () => {
    // 3 * 9950 / 10000 = 2.985. Flooring would hand a base unit of tolerance
    // to whoever moved the price; the position keeps it.
    expect(minimumAmounts({ amount0: 1_000n, amount1: 3n }, 50)).toEqual({
      amount0Min: 995n,
      amount1Min: 3n,
    });
    expect(minimumAmounts({ amount0: 12_345n, amount1: 1n }, 100)).toEqual({
      amount0Min: 12_222n,
      amount1Min: 1n,
    });
  });

  it('is the identity at zero slippage and nothing at all slippage', () => {
    expect(minimumAmounts({ amount0: ONE_WETH, amount1: THREE_K_USDC }, 0)).toEqual({
      amount0Min: ONE_WETH,
      amount1Min: THREE_K_USDC,
    });
    // 10,000 bps is the caller saying "take anything"; policy refuses that
    // elsewhere, the arithmetic does not pretend it means something else.
    expect(minimumAmounts({ amount0: ONE_WETH, amount1: THREE_K_USDC }, 10_000)).toEqual({
      amount0Min: 0n,
      amount1Min: 0n,
    });
  });

  it('never returns a floor above the amount it protects', () => {
    const wrong: string[] = [];
    for (const amount of [0n, 1n, 7n, 999n, ONE_WETH, THREE_K_USDC]) {
      for (const bps of [0, 1, 5, 50, 300, 9_999, 10_000]) {
        const { amount0Min } = minimumAmounts({ amount0: amount, amount1: amount }, bps);
        if (amount0Min > amount || amount0Min < 0n) wrong.push(`${amount}@${bps}`);
        // Tolerance actually given away is never more than was asked for.
        if ((amount - amount0Min) * 10_000n > amount * BigInt(bps))
          wrong.push(`loose ${amount}@${bps}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('refuses a slippage that is not basis points, and a negative amount', () => {
    for (const bps of [-1, 10_001, 2.5]) {
      expect(expectAppError(() => minimumAmounts({ amount0: 1n, amount1: 1n }, bps)).code).toBe(
        ErrorCode.SCHEMA_INVALID,
      );
    }
    expect(expectAppError(() => minimumAmounts({ amount0: -1n, amount1: 1n }, 50)).message).toMatch(
      /negative/,
    );
  });
});

// --- where a position sits ---------------------------------------------------

describe('rangeStatus', () => {
  it('reads the three regions, on the pool’s own half-open rule', () => {
    expect(rangeStatus(BASE_TICK, LOWER, UPPER)).toEqual({
      side: 'in-range',
      widthTicks: 200,
      ticksToLower: 100,
      ticksToUpper: 100,
      ticksOutside: 0,
      outsideBps: 0,
    });
    expect(rangeStatus(-197_800, LOWER, UPPER)).toMatchObject({
      side: 'below',
      ticksToLower: -100,
      ticksOutside: 100,
      outsideBps: 5_000,
    });
    expect(rangeStatus(-197_400, LOWER, UPPER)).toMatchObject({
      side: 'above',
      ticksToUpper: -100,
      ticksOutside: 100,
      outsideBps: 5_000,
    });
  });

  it('puts the lower bound in range and the upper bound out, as the pool does', () => {
    expect(rangeStatus(LOWER, LOWER, UPPER)).toMatchObject({
      side: 'in-range',
      ticksOutside: 0,
      ticksToLower: 0,
    });
    // At the top bound the position has stopped earning but has not travelled
    // past anything yet: out of range, zero ticks outside.
    expect(rangeStatus(UPPER, LOWER, UPPER)).toMatchObject({
      side: 'above',
      ticksOutside: 0,
      ticksToUpper: 0,
    });
    expect(rangeStatus(UPPER - 1, LOWER, UPPER).side).toBe('in-range');
    expect(rangeStatus(LOWER - 1, LOWER, UPPER)).toMatchObject({ side: 'below', ticksOutside: 1 });
  });

  it('rounds the distance up, so a rebalance rule fires at its threshold', () => {
    // One tick outside a 200-tick range is exactly 50 bps of it, either side.
    expect(rangeStatus(UPPER + 1, LOWER, UPPER).outsideBps).toBe(50);
    expect(rangeStatus(LOWER - 1, LOWER, UPPER).outsideBps).toBe(50);

    // Across a 300-tick range the division is inexact: 10000/300 is 33.33…,
    // and a rule written as "act a third of a percent outside" must not be
    // made to wait a tick longer by a floor.
    const wide = { lower: -197_700, upper: -197_400 };
    expect(rangeStatus(wide.upper + 1, wide.lower, wide.upper).outsideBps).toBe(34);
    expect(rangeStatus(wide.lower - 2, wide.lower, wide.upper).outsideBps).toBe(67);

    // Far outside it is not capped: three widths away reads as three widths.
    expect(rangeStatus(UPPER + 600, LOWER, UPPER).outsideBps).toBe(30_000);
  });

  it('refuses an inverted range and a tick no pool could report', () => {
    expect(expectAppError(() => rangeStatus(0, UPPER, LOWER)).message).toMatch(/empty or inverted/);
    expect(expectAppError(() => rangeStatus(0, LOWER, LOWER)).code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(expectAppError(() => rangeStatus(MAX_TICK + 1, LOWER, UPPER)).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
  });
});

// --- the plan ----------------------------------------------------------------

describe('planRange', () => {
  function plan(overrides: Partial<Parameters<typeof planRange>[0]> = {}) {
    return planRange({
      sqrtPriceX96: BASE_SQRT,
      tickLower: LOWER,
      tickUpper: UPPER,
      tickSpacing: 10,
      amount0: ONE_WETH,
      amount1: THREE_K_USDC,
      slippageBps: 50,
      ...overrides,
    });
  }

  it('reports the position the capital buys, field for field', () => {
    const result = plan();

    expect(result.tickLower).toBe(LOWER);
    expect(result.tickUpper).toBe(UPPER);
    expect(result.tickSpacing).toBe(10);
    expect(result.sqrtPriceX96).toBe(BASE_SQRT.toString());
    expect(result.tick).toBe(BASE_TICK);
    expect(result.side).toBe('in-range');
    expect(result.slippageBps).toBe(50);
    expect(result.inspectOnly).toBe(true);

    // The liquidity is the solver's, and the amounts are exactly what the
    // reader will find in the position once it holds that liquidity.
    const liquidity = maxLiquidityForAmounts(BASE_SQRT, LOWER, UPPER, ONE_WETH, THREE_K_USDC);
    const amounts = getAmountsForLiquidity(BASE_SQRT, LOWER, UPPER, liquidity);
    expect(result.liquidity).toBe(liquidity.toString());
    expect(result.amount0).toBe(amounts.amount0.toString());
    expect(result.amount1).toBe(amounts.amount1.toString());
    expect(result.amount0Min).toBe(minimumAmounts(amounts, 50).amount0Min.toString());
    expect(result.amount1Min).toBe(minimumAmounts(amounts, 50).amount1Min.toString());
  });

  it('accounts for every base unit it was given', () => {
    const result = plan();

    expect(BigInt(result.amount0) + BigInt(result.unused0)).toBe(ONE_WETH);
    expect(BigInt(result.amount1) + BigInt(result.unused1)).toBe(THREE_K_USDC);
    expect(BigInt(result.unused0)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(result.unused1)).toBeGreaterThanOrEqual(0n);
    // Token0 binds here, so the USDC left over is real and visible rather
    // than silently rolled into a position that cannot hold it.
    expect(BigInt(result.unused1)).toBeGreaterThan(0n);
  });

  it('holds its invariants in all three price regions', () => {
    const broken: string[] = [];
    for (const [label, price] of [
      ['below', getSqrtRatioAtTick(-198_000)],
      ['at the lower bound', getSqrtRatioAtTick(LOWER)],
      ['inside', BASE_SQRT],
      ['at the upper bound', getSqrtRatioAtTick(UPPER)],
      ['above', getSqrtRatioAtTick(-197_000)],
    ] as const) {
      const result = plan({ sqrtPriceX96: price });
      const amount0 = BigInt(result.amount0);
      const amount1 = BigInt(result.amount1);
      const roundTrip = getAmountsForLiquidity(price, LOWER, UPPER, BigInt(result.liquidity));

      if (amount0 > ONE_WETH || amount1 > THREE_K_USDC) broken.push(`${label}: overspent`);
      if (roundTrip.amount0 !== amount0 || roundTrip.amount1 !== amount1) {
        broken.push(`${label}: does not round-trip`);
      }
      if (BigInt(result.amount0Min) > amount0 || BigInt(result.amount1Min) > amount1) {
        broken.push(`${label}: floor above the amount`);
      }
      if (!isUsableTick(result.tickLower, 10) || !isUsableTick(result.tickUpper, 10)) {
        broken.push(`${label}: unusable tick`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('plans a one-sided position when the price has left the range', () => {
    const below = plan({ sqrtPriceX96: getSqrtRatioAtTick(-198_000) });
    expect(below.side).toBe('below');
    expect(below.amount1).toBe('0');
    expect(below.amount1Min).toBe('0');
    expect(below.unused1).toBe(THREE_K_USDC.toString());

    const above = plan({ sqrtPriceX96: getSqrtRatioAtTick(-197_000) });
    expect(above.side).toBe('above');
    expect(above.amount0).toBe('0');
    expect(above.unused0).toBe(ONE_WETH.toString());
  });

  it('reports a range the capital cannot reach as an empty position, not an error', () => {
    // Only USDC, and a range entirely above the price: the position would be
    // all token0, so there is nothing to put in it. Saying so plainly is what
    // lets a caller decide; inventing liquidity would not.
    const result = plan({ sqrtPriceX96: getSqrtRatioAtTick(-198_000), amount0: 0n });

    expect(result.liquidity).toBe('0');
    expect(result.amount0).toBe('0');
    expect(result.amount1).toBe('0');
    expect(result.unused1).toBe(THREE_K_USDC.toString());
  });

  it('refuses a bound the pool would reject as misaligned', () => {
    // -197695 is a legal tick, and a pool with a spacing of 10 will not take
    // it. Catching that here is the difference between a refusal and a mint
    // that reverts after the gas has been spent.
    const error = expectAppError(() => plan({ tickLower: -197_695 }));

    expect(error.code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(error.message).toMatch(/not a usable tick/);
    expect(expectAppError(() => plan({ tickUpper: -197_495 })).code).toBe(ErrorCode.SCHEMA_INVALID);
    // The same range is fine at the spacing that actually admits it.
    expect(plan({ tickLower: -197_700, tickUpper: -197_460, tickSpacing: 60 }).tickSpacing).toBe(
      60,
    );
  });

  it('refuses a plan with no capital at all', () => {
    const error = expectAppError(() => plan({ amount0: 0n, amount1: 0n }));

    expect(error.code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(error.message).toMatch(/no capital/);
  });

  it('refuses more liquidity than a single tick may carry', () => {
    // Under the uint128 ceiling, over the pool's own per-tick cap: a mint the
    // pool would revert, refused before anything is built.
    const error = expectAppError(() => plan({ amount0: 10n ** 38n, amount1: 10n ** 38n }));

    expect(error.code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(error.message).toMatch(/one tick may carry/);
    expect(error.details?.['maxLiquidityPerTick']).toBe(maxLiquidityPerTick(10).toString());
  });

  it('refuses an inverted range, a bad price and a bad slippage', () => {
    expect(expectAppError(() => plan({ tickLower: UPPER, tickUpper: LOWER })).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
    expect(expectAppError(() => plan({ sqrtPriceX96: 0n })).message).toMatch(
      /sqrtPriceX96 is outside/,
    );
    expect(expectAppError(() => plan({ amount0: -1n })).message).toMatch(/negative/);
    expect(expectAppError(() => plan({ slippageBps: 10_001 })).code).toBe(ErrorCode.SCHEMA_INVALID);
  });
});

// --- the increment is inert --------------------------------------------------

describe('range-plan is arithmetic and nothing else', () => {
  it('exports no entry point that could reach a chain', () => {
    // The mirror of the enumeration in `v3-pool.test.ts`: a later agent adding
    // a builder, a signer or a broadcaster to this module fails here rather
    // than quietly retiring the inspect-only invariant.
    const exported = Object.keys(rangePlanModule).sort();

    expect(exported).toEqual(
      [
        'alignTickDown',
        'alignTickUp',
        'getLiquidityForAmount0',
        'getLiquidityForAmount1',
        'halfWidthTicksForBps',
        'isUsableTick',
        'maxLiquidityForAmounts',
        'maxLiquidityPerTick',
        'minimumAmounts',
        'nearestUsableTick',
        'planRange',
        'rangeFromHalfWidth',
        'rangeStatus',
      ].sort(),
    );
    for (const name of exported) {
      expect(name).not.toMatch(/build|sign|send|broadcast|approve|mint|execute/i);
    }
  });

  it('is a pure function of its arguments', () => {
    const request = {
      sqrtPriceX96: BASE_SQRT,
      tickLower: LOWER,
      tickUpper: UPPER,
      tickSpacing: 10,
      amount0: ONE_WETH,
      amount1: THREE_K_USDC,
      slippageBps: 50,
    };
    const first = planRange(request);
    const second = planRange({ ...request });

    expect(second).toEqual(first);
    // Nothing observed, nothing dated, nothing stored: no `observedAt` to go
    // stale, because a plan is arithmetic over inputs the caller already has.
    expect(Object.keys(first)).not.toContain('observedAt');
  });
});
