import { AppError, ErrorCode } from '../../util/errors.js';
import { floorDiv } from '../../risk/money.js';

/**
 * Uniswap v3 tick arithmetic, ported from the Solidity the pools themselves
 * run.
 *
 * A v3 pool prices itself as `sqrtPriceX96`, a Q64.96 fixed-point square root
 * of token1-per-token0, and indexes prices by `tick`, where
 * `price = 1.0001^tick`. Nothing here is an approximation of that: the
 * conversions below are the contracts' own, constant for constant, so a
 * position this build reports as "in range" is in range by the same rule the
 * pool uses to pay it fees. An implementation that merely came close would
 * disagree with the chain at exactly the boundary that matters.
 *
 * References (v3-core / v3-periphery v1.0.0, the tag deployed on Base and the
 * lineage PancakeSwap v3 forked):
 *  - TickMath.getSqrtRatioAtTick / getTickAtSqrtRatio
 *    https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/libraries/TickMath.sol
 *  - LiquidityAmounts.getAmountsForLiquidity
 *    https://github.com/Uniswap/v3-periphery/blob/v1.0.0/contracts/libraries/LiquidityAmounts.sol
 *
 * Every value that is money or a price is a bigint. Ticks cross this boundary
 * as `number` because a tick is an int24 index, which a double holds exactly
 * and which is what viem decodes an `int24` into; each one is range-checked on
 * the way in, and all arithmetic over it is done in bigint.
 */

/** 2^96, the fixed-point scale of `sqrtPriceX96`. */
export const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const Q32 = 1n << 32n;
const UINT256_MAX = (1n << 256n) - 1n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/** Fractional digits of every price string this module returns. */
export const PRICE_DECIMALS = 18;
const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);

const MAX_DECIMALS = 36;

/**
 * The twenty Q128.128 factors of `getSqrtRatioAtTick`, one per bit of |tick|.
 *
 * The Solidity assigns the first factor instead of multiplying by it; starting
 * the accumulator at 2^128 makes the loop uniform without changing a single
 * result, because `(2^128 * m) >> 128 == m` exactly.
 */
const SQRT_RATIO_FACTORS: readonly bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/** The seven binary-search steps of the most-significant-bit scan. */
const MSB_SHIFTS: readonly bigint[] = [7n, 6n, 5n, 4n, 3n, 2n, 1n];

/** `sqrt(1.0001)` in Q128.128, and the two error bounds around its logarithm. */
const LOG_SQRT_10001 = 255738958999603826347141n;
const TICK_LOW_ERROR = 3402992956809132418596140100660247210n;
const TICK_HIGH_ERROR = 291339464771989622907027621153398088495n;

/** `sqrtPriceX96` at a tick: TickMath.getSqrtRatioAtTick. */
export function getSqrtRatioAtTick(tick: number): bigint {
  assertTick(tick, 'tick');
  const absTick = tick < 0 ? BigInt(-tick) : BigInt(tick);

  let ratio = Q128;
  for (const [bit, factor] of SQRT_RATIO_FACTORS.entries()) {
    if ((absTick & (1n << BigInt(bit))) !== 0n) {
      ratio = (ratio * factor) >> 128n;
    }
  }
  // Negative ticks were accumulated; a positive tick is their reciprocal.
  if (tick > 0) ratio = UINT256_MAX / ratio;

  // Q128.128 down to Q64.96, rounded up so the result never reports a price
  // below the one the tick actually stands for.
  return (ratio >> 32n) + (ratio % Q32 === 0n ? 0n : 1n);
}

/**
 * The greatest tick whose `sqrtPriceX96` is at most the given one:
 * TickMath.getTickAtSqrtRatio.
 */
export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  assertSqrtRatio(sqrtPriceX96);

  const ratio = sqrtPriceX96 << 32n;
  let scan = ratio;
  let msb = 0n;
  for (const shift of MSB_SHIFTS) {
    const step = (scan > (1n << (1n << shift)) - 1n ? 1n : 0n) << shift;
    msb |= step;
    scan >>= step;
  }
  msb |= scan > 1n ? 1n : 0n;

  let remainder = msb >= 128n ? ratio >> (msb - 127n) : ratio << (127n - msb);
  let log2 = (msb - 128n) << 64n;
  for (let i = 0n; i < 14n; i += 1n) {
    remainder = (remainder * remainder) >> 127n;
    const bit = remainder >> 128n;
    log2 |= bit << (63n - i);
    remainder >>= bit;
  }

  const logSqrt10001 = log2 * LOG_SQRT_10001;
  const tickLow = (logSqrt10001 - TICK_LOW_ERROR) >> 128n;
  const tickHigh = (logSqrt10001 + TICK_HIGH_ERROR) >> 128n;
  if (tickLow === tickHigh) return Number(tickLow);
  // The bounds straddle a tick boundary, so ask the forward conversion.
  return getSqrtRatioAtTick(Number(tickHigh)) <= sqrtPriceX96 ? Number(tickHigh) : Number(tickLow);
}

/**
 * The price of one whole token0 in whole token1, as a decimal string with
 * exactly 18 fractional digits.
 *
 * Eighteen digits and a floor, because that is what `priceToAtto` in the risk
 * engine parses: the string can be handed straight to it without a second
 * rounding step. A pair whose true price is below 1e-18 of a token1 floors to
 * "0.000000000000000000", which the engine already treats as an absent price
 * rather than a free asset.
 */
export function priceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): string {
  assertSqrtRatio(sqrtPriceX96);
  assertDecimals(decimals0, 'decimals0');
  assertDecimals(decimals1, 'decimals1');

  const numerator = sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(decimals0) * PRICE_SCALE;
  const denominator = Q96 * Q96 * 10n ** BigInt(decimals1);
  const scaled = floorDiv(numerator, denominator);
  const whole = scaled / PRICE_SCALE;
  const fraction = (scaled % PRICE_SCALE).toString().padStart(PRICE_DECIMALS, '0');
  return `${whole.toString()}.${fraction}`;
}

export interface PositionAmounts {
  amount0: bigint;
  amount1: bigint;
}

/**
 * What a position of `liquidity` over [tickLower, tickUpper) is made of at the
 * pool's current price: LiquidityAmounts.getAmountsForLiquidity.
 *
 * Below its range a position is entirely token0 and above it entirely token1,
 * which is the whole reason a v3 position cannot be valued like an LP-token
 * balance. Both amounts are floored, so they are what a burn would return and
 * never more. Fees owed are not included; they are a separate balance the
 * position manager tracks.
 */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): PositionAmounts {
  assertSqrtRatio(sqrtPriceX96);
  assertTick(tickLower, 'tickLower');
  assertTick(tickUpper, 'tickUpper');
  if (tickLower >= tickUpper) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Position range is empty or inverted', {
      details: { tickLower, tickUpper },
    });
  }
  if (liquidity < 0n) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Position liquidity is negative');
  }
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n };

  const lower = getSqrtRatioAtTick(tickLower);
  const upper = getSqrtRatioAtTick(tickUpper);

  if (sqrtPriceX96 <= lower) {
    return { amount0: getAmount0ForLiquidity(lower, upper, liquidity), amount1: 0n };
  }
  if (sqrtPriceX96 < upper) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceX96, upper, liquidity),
      amount1: getAmount1ForLiquidity(lower, sqrtPriceX96, liquidity),
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(lower, upper, liquidity) };
}

/**
 * Whether the pool's tick sits inside the position's range.
 *
 * The upper bound is exclusive, as it is in the pool: at `tick == tickUpper`
 * the position holds only token1 and earns nothing.
 */
export function isTickInRange(tick: number, tickLower: number, tickUpper: number): boolean {
  assertTick(tick, 'tick');
  assertTick(tickLower, 'tickLower');
  assertTick(tickUpper, 'tickUpper');
  return tick >= tickLower && tick < tickUpper;
}

/**
 * Token0 held by `liquidity` between two sqrt ratios:
 * `FullMath.mulDiv(L << 96, b - a, b) / a`.
 *
 * The two divisions stay separate because the Solidity divides twice, and
 * `floor(floor(x / b) / a)` is not `floor(x / (a * b))` at every input.
 */
export function getAmount0ForLiquidity(a: bigint, b: bigint, liquidity: bigint): bigint {
  const low = a <= b ? a : b;
  const high = a <= b ? b : a;
  return floorDiv(floorDiv((liquidity << 96n) * (high - low), high), low);
}

/** Token1 held by `liquidity` between two sqrt ratios: `L * (b - a) / 2^96`. */
export function getAmount1ForLiquidity(a: bigint, b: bigint, liquidity: bigint): bigint {
  const low = a <= b ? a : b;
  const high = a <= b ? b : a;
  return floorDiv(liquidity * (high - low), Q96);
}

function assertTick(tick: number, field: string): void {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, `${field} is outside the v3 tick range`, {
      details: { [field]: tick, min: MIN_TICK, max: MAX_TICK },
    });
  }
}

function assertSqrtRatio(sqrtPriceX96: bigint): void {
  // The pool itself refuses to move outside these bounds, so a value beyond
  // them is a reply that did not come from a working v3 pool.
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'sqrtPriceX96 is outside the v3 price range', {
      details: { sqrtPriceX96: sqrtPriceX96.toString() },
    });
  }
}

function assertDecimals(decimals: number, field: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, `Unsupported token decimals in ${field}`, {
      details: { [field]: decimals },
    });
  }
}
