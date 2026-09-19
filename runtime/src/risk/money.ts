import { AppError, ErrorCode } from '../util/errors.js';

/**
 * Money arithmetic for the risk engine.
 *
 * Every value is a bigint of fixed-scale integers. No `number` ever holds an
 * amount and there is no floating point anywhere in this file: a rounding error
 * here is a real loss of the operator's money, and IEEE 754 cannot represent
 * 0.1 exactly.
 *
 * Scales:
 *   USD     -> micro-USD  (1e6)   enough for sub-cent fees
 *   price   -> atto-USD   (1e18)  so a token worth 0.0000000123 keeps precision
 *   amounts -> base units (wei, lamports, token base units)
 */

export const USD_SCALE = 1_000_000n;
export const PRICE_SCALE = 1_000_000_000_000_000_000n;
export const BPS_DENOM = 10_000n;

const USD_RE = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;
const PRICE_RE = /^(0|[1-9]\d*)(?:\.(\d{1,18}))?$/;
const AMOUNT_RE = /^(0|[1-9]\d*)$/;

/** A malformed numeric string coming from a model, an API or a config file. */
export class MoneyFormatError extends AppError {
  constructor(message: string) {
    super(ErrorCode.SCHEMA_INVALID, message);
    this.name = 'MoneyFormatError';
  }
}

/**
 * Parse a USD string into micro-USD.
 *
 * Strict on purpose: `"1e6"`, `"+5"`, `"05"`, `" 5"`, `"5."` and `".5"` are all
 * rejected rather than coerced, because every one of them is a sign that an
 * untrusted producer is feeding the engine something it did not intend.
 */
export function usdToMicros(value: string): bigint {
  const match = USD_RE.exec(value);
  if (!match) throw new MoneyFormatError(`Malformed USD value: ${JSON.stringify(value)}`);
  const sign = match[1];
  const integer = match[2] ?? '0';
  const fraction = match[3] ?? '';
  const micros = BigInt(integer) * USD_SCALE + BigInt(fraction.padEnd(6, '0') || '0');
  return sign === '-' ? -micros : micros;
}

/** Render micro-USD in canonical form: always exactly six fractional digits. */
export function microsToUsd(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const integer = absolute / USD_SCALE;
  const fraction = (absolute % USD_SCALE).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${integer.toString()}.${fraction}`;
}

/** Parse a price string into atto-USD. Prices are never negative. */
export function priceToAtto(value: string): bigint {
  const match = PRICE_RE.exec(value);
  if (!match) throw new MoneyFormatError(`Malformed price: ${JSON.stringify(value)}`);
  const integer = match[1] ?? '0';
  const fraction = match[2] ?? '';
  return BigInt(integer) * PRICE_SCALE + BigInt(fraction.padEnd(18, '0') || '0');
}

/** Parse a base-unit amount. Always a non-negative integer string. */
export function amountToBigint(value: string): bigint {
  if (!AMOUNT_RE.test(value)) {
    throw new MoneyFormatError(`Malformed amount: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new MoneyFormatError('Division by a non-positive denominator');
  if (a <= 0n) return a / b;
  return (a + b - 1n) / b;
}

export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new MoneyFormatError('Division by a non-positive denominator');
  return a / b;
}

export type Rounding = 'ceil' | 'floor';

/**
 * Convert a base-unit amount into micro-USD at the given price.
 *
 * Rounding always works against the trade: values that could breach a maximum
 * round up, values that could breach a minimum round down. That way a rounding
 * error can only ever make the engine more conservative.
 */
export function nativeToUsdMicros(
  amount: bigint,
  decimals: number,
  priceAtto: bigint,
  rounding: Rounding,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new MoneyFormatError(`Unsupported token decimals: ${decimals}`);
  }
  // A zero price is not a price: it is a provider saying "unknown" in the
  // shape of a number. Valuing anything at it makes every USD cap pass
  // trivially, so it is refused here as defence in depth; the engine treats a
  // zero price as missing data long before reaching this point.
  if (priceAtto <= 0n) {
    throw new MoneyFormatError('Cannot value an amount at a non-positive price');
  }
  const numerator = amount * priceAtto;
  const denominator = 10n ** BigInt(decimals) * (PRICE_SCALE / USD_SCALE);
  return rounding === 'ceil' ? ceilDiv(numerator, denominator) : floorDiv(numerator, denominator);
}

/**
 * Slippage implied by an expected output versus the minimum accepted output.
 *
 * Rounded up, so a quote sitting exactly on the policy limit is treated as
 * being at the limit rather than just under it.
 */
export function impliedSlippageBps(expectedOut: bigint, minOut: bigint): bigint {
  if (expectedOut <= 0n) throw new MoneyFormatError('Quote has a non-positive expected output');
  if (minOut < 0n) throw new MoneyFormatError('Quote has a negative minimum output');
  if (minOut > expectedOut) throw new MoneyFormatError('Quote minimum exceeds expected output');
  return ceilDiv((expectedOut - minOut) * BPS_DENOM, expectedOut);
}

/** Apply a basis-point haircut, rounded up. Used for worst-case cost. */
export function bpsOf(value: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyFormatError(`Basis points out of range: ${bps}`);
  }
  return ceilDiv(value * BigInt(bps), BPS_DENOM);
}

export function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
