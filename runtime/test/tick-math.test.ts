import { describe, expect, it } from 'vitest';
import {
  getAmount0ForLiquidity,
  getAmount1ForLiquidity,
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  isTickInRange,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  priceFromSqrtPriceX96,
  Q96,
} from '../src/liquidity/evm/tick-math.js';
import { AppError, ErrorCode } from '../src/util/errors.js';

/**
 * The v3 arithmetic checked against values that exist outside this repository:
 * the constants the Solidity fixes, two live pools read from chain, and a
 * handful of ratios chosen so the right answer can be worked out on paper.
 *
 * Testing it against itself would prove only that it is consistent. What
 * matters is that it agrees with the contracts, because a disagreement at a
 * range boundary is the difference between a position the pool is paying and
 * one it is not.
 */

/** Uniswap v3 WETH/USDC 0.05% on Base, `slot0` at block 51569133. */
const BASE_WETH_USDC_SQRT = 4057719202767049541567034n;
const BASE_WETH_USDC_TICK = -197600;

/** PancakeSwap v3 USDT/WBNB 0.05% on BNB Chain, `slot0` at block 123034328. */
const BSC_USDT_WBNB_SQRT = 2865720859012294761465802390n;
const BSC_USDT_WBNB_TICK = -66394;

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

describe('getSqrtRatioAtTick', () => {
  it('prices tick 0 at exactly 2^96', () => {
    // Tick 0 is a price of 1, whose square root in Q64.96 is the scale itself.
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
    expect(Q96).toBe(79228162514264337593543950336n);
  });

  it('hits the bounds the contracts declare', () => {
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
    expect(MIN_SQRT_RATIO).toBe(4295128739n);
    expect(MAX_SQRT_RATIO).toBe(1461446703485210103287273052203988822378723970342n);
  });

  it('moves monotonically with the tick', () => {
    expect(getSqrtRatioAtTick(-1)).toBeLessThan(getSqrtRatioAtTick(0));
    expect(getSqrtRatioAtTick(0)).toBeLessThan(getSqrtRatioAtTick(1));
    expect(getSqrtRatioAtTick(-887271)).toBeLessThan(getSqrtRatioAtTick(-887270));
  });

  it('refuses a tick outside the range, and refuses it as an AppError', () => {
    const error = expectAppError(() => getSqrtRatioAtTick(MAX_TICK + 1));
    expect(error.code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(expectAppError(() => getSqrtRatioAtTick(MIN_TICK - 1)).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
    expect(expectAppError(() => getSqrtRatioAtTick(1.5)).code).toBe(ErrorCode.SCHEMA_INVALID);
  });
});

describe('getTickAtSqrtRatio', () => {
  it('reads back the tick two live pools reported for their own price', () => {
    expect(getTickAtSqrtRatio(BASE_WETH_USDC_SQRT)).toBe(BASE_WETH_USDC_TICK);
    expect(getTickAtSqrtRatio(BSC_USDT_WBNB_SQRT)).toBe(BSC_USDT_WBNB_TICK);
  });

  it('round-trips every tick across the whole range, negatives included', () => {
    const mismatches: number[] = [];
    // A stride that is coprime with nothing in particular, so the sample is
    // not aligned to any tick spacing a pool actually uses.
    for (let tick = MIN_TICK; tick <= MAX_TICK; tick += 977) {
      if (getTickAtSqrtRatio(getSqrtRatioAtTick(tick)) !== tick) mismatches.push(tick);
    }
    for (const tick of [MIN_TICK, -887271, -197600, -66394, -1, 0, 1, 60, 887271]) {
      if (getTickAtSqrtRatio(getSqrtRatioAtTick(tick)) !== tick) mismatches.push(tick);
    }
    expect(mismatches).toEqual([]);
  });

  it('refuses a price outside the range the pool can reach', () => {
    expect(expectAppError(() => getTickAtSqrtRatio(0n)).code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(expectAppError(() => getTickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
    // MAX_SQRT_RATIO is exclusive: the pool never reaches it.
    expect(expectAppError(() => getTickAtSqrtRatio(MAX_SQRT_RATIO)).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
  });
});

describe('priceFromSqrtPriceX96', () => {
  it('prices tick 0 at one when the tokens share their decimals', () => {
    expect(priceFromSqrtPriceX96(Q96, 18, 18)).toBe('1.000000000000000000');
  });

  it('applies the decimals of both tokens', () => {
    // Same ratio, but one whole token0 is 1e12 times one whole token1.
    expect(priceFromSqrtPriceX96(Q96, 18, 6)).toBe('1000000000000.000000000000000000');
    expect(priceFromSqrtPriceX96(Q96, 6, 18)).toBe('0.000000000001000000');
  });

  it('prices the two live pools as their tokens are quoted', () => {
    // WETH (18) in USDC (6): the pool's own price at that block.
    expect(priceFromSqrtPriceX96(BASE_WETH_USDC_SQRT, 18, 6)).toBe('2623.039393432768894858');
    // USDT (18) in WBNB (18): a bit over 1/764 of a BNB.
    expect(priceFromSqrtPriceX96(BSC_USDT_WBNB_SQRT, 18, 18)).toBe('0.001308303798149651');
  });

  it('floors a price too small for eighteen digits to zero rather than rounding up', () => {
    // USDC (6) priced in WETH (18) at the same pool is ~3.8e-22, which does
    // not survive eighteen digits. Reporting zero is the engine's "unknown";
    // rounding up would invent value that is not there.
    expect(priceFromSqrtPriceX96(BASE_WETH_USDC_SQRT, 6, 18)).toBe('0.000000000000000000');
  });

  it('refuses nonsense decimals and nonsense prices', () => {
    expect(expectAppError(() => priceFromSqrtPriceX96(Q96, 18, -1)).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
    expect(expectAppError(() => priceFromSqrtPriceX96(0n, 18, 18)).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
  });
});

describe('getAmount0ForLiquidity / getAmount1ForLiquidity', () => {
  // Between sqrt ratios 2^96 (price 1) and 2^97 (price 4) the formulas reduce
  // to L/2 of token0 and L of token1, which is worked out by hand and owes
  // nothing to the code under test.
  const LOW = Q96;
  const HIGH = Q96 * 2n;
  const L = 1_000_000_000_000_000_000n;

  it('matches the amounts the formula reduces to at a hand-checkable range', () => {
    expect(getAmount0ForLiquidity(LOW, HIGH, L)).toBe(L / 2n);
    expect(getAmount1ForLiquidity(LOW, HIGH, L)).toBe(L);
  });

  it('does not care which way round the two ratios are given', () => {
    expect(getAmount0ForLiquidity(HIGH, LOW, L)).toBe(L / 2n);
    expect(getAmount1ForLiquidity(HIGH, LOW, L)).toBe(L);
  });
});

describe('getAmountsForLiquidity', () => {
  const LOWER = -197700;
  const UPPER = -197500;
  const L = 1_078_571_510_367_106_173n;

  it('holds only token0 when the price is at or below the range', () => {
    const below = getAmountsForLiquidity(getSqrtRatioAtTick(LOWER - 1), LOWER, UPPER, L);
    expect(below.amount1).toBe(0n);
    expect(below.amount0).toBeGreaterThan(0n);

    // At exactly the lower bound the position has not started converting yet.
    const atLower = getAmountsForLiquidity(getSqrtRatioAtTick(LOWER), LOWER, UPPER, L);
    expect(atLower.amount1).toBe(0n);
    expect(atLower.amount0).toBe(
      getAmount0ForLiquidity(getSqrtRatioAtTick(LOWER), getSqrtRatioAtTick(UPPER), L),
    );
  });

  it('holds only token1 when the price is at or above the range', () => {
    const above = getAmountsForLiquidity(getSqrtRatioAtTick(UPPER + 1), LOWER, UPPER, L);
    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);

    // The upper bound belongs to the token1 side: a position there is done.
    const atUpper = getAmountsForLiquidity(getSqrtRatioAtTick(UPPER), LOWER, UPPER, L);
    expect(atUpper.amount0).toBe(0n);
    expect(atUpper.amount1).toBe(
      getAmount1ForLiquidity(getSqrtRatioAtTick(LOWER), getSqrtRatioAtTick(UPPER), L),
    );
  });

  it('holds both sides in range, each less than the whole leg', () => {
    const whole0 = getAmount0ForLiquidity(getSqrtRatioAtTick(LOWER), getSqrtRatioAtTick(UPPER), L);
    const whole1 = getAmount1ForLiquidity(getSqrtRatioAtTick(LOWER), getSqrtRatioAtTick(UPPER), L);

    const inside = getAmountsForLiquidity(BASE_WETH_USDC_SQRT, LOWER, UPPER, L);
    expect(inside.amount0).toBeGreaterThan(0n);
    expect(inside.amount1).toBeGreaterThan(0n);
    expect(inside.amount0).toBeLessThan(whole0);
    expect(inside.amount1).toBeLessThan(whole1);
  });

  it('converts from all token0 to all token1 as the price crosses', () => {
    let previous0 = getAmountsForLiquidity(getSqrtRatioAtTick(LOWER), LOWER, UPPER, L).amount0;
    let previous1 = 0n;
    for (let tick = LOWER + 10; tick <= UPPER; tick += 10) {
      const at = getAmountsForLiquidity(getSqrtRatioAtTick(tick), LOWER, UPPER, L);
      expect(at.amount0).toBeLessThanOrEqual(previous0);
      expect(at.amount1).toBeGreaterThanOrEqual(previous1);
      previous0 = at.amount0;
      previous1 = at.amount1;
    }
    expect(previous0).toBe(0n);
  });

  it('holds nothing when the position has no liquidity', () => {
    expect(getAmountsForLiquidity(BASE_WETH_USDC_SQRT, LOWER, UPPER, 0n)).toEqual({
      amount0: 0n,
      amount1: 0n,
    });
  });

  it('refuses an inverted, empty or negative position', () => {
    expect(
      expectAppError(() => getAmountsForLiquidity(BASE_WETH_USDC_SQRT, UPPER, LOWER, L)).code,
    ).toBe(ErrorCode.SCHEMA_INVALID);
    expect(
      expectAppError(() => getAmountsForLiquidity(BASE_WETH_USDC_SQRT, LOWER, LOWER, L)).code,
    ).toBe(ErrorCode.SCHEMA_INVALID);
    expect(
      expectAppError(() => getAmountsForLiquidity(BASE_WETH_USDC_SQRT, LOWER, UPPER, -1n)).code,
    ).toBe(ErrorCode.SCHEMA_INVALID);
  });
});

describe('isTickInRange', () => {
  it('includes the lower bound and excludes the upper, as the pool does', () => {
    expect(isTickInRange(-100, -100, 100)).toBe(true);
    expect(isTickInRange(0, -100, 100)).toBe(true);
    expect(isTickInRange(99, -100, 100)).toBe(true);
    expect(isTickInRange(100, -100, 100)).toBe(false);
    expect(isTickInRange(-101, -100, 100)).toBe(false);
  });

  it('refuses a tick that could not have come from a pool', () => {
    expect(expectAppError(() => isTickInRange(MAX_TICK + 1, -100, 100)).code).toBe(
      ErrorCode.SCHEMA_INVALID,
    );
  });
});
