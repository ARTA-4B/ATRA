import { describe, expect, it } from 'vitest';
import {
  amountToBigint,
  bpsOf,
  ceilDiv,
  floorDiv,
  impliedSlippageBps,
  microsToUsd,
  nativeToUsdMicros,
  priceToAtto,
  usdToMicros,
} from '../src/risk/money.js';

/**
 * These vectors come from docs/specs/risk-engine-spec.md section 3.5 and must
 * pass byte for byte. They exist so a refactor of the arithmetic cannot quietly
 * change what the engine considers "within the limit".
 */

describe('usdToMicros', () => {
  it.each([
    ['25', 25_000_000n],
    ['25.00', 25_000_000n],
    ['0.000001', 1n],
    ['-3.5', -3_500_000n],
    ['0', 0n],
  ])('parses %s', (input, expected) => {
    expect(usdToMicros(input)).toBe(expected);
  });

  it.each(['12.3456789', '1e6', '+5', ' 5', '5.', '.5', '05', '', 'NaN', '1,5'])(
    'rejects %j',
    (input) => {
      expect(() => usdToMicros(input)).toThrow(/Malformed USD/);
    },
  );
});

describe('microsToUsd', () => {
  it.each([
    [25_000_000n, '25.000000'],
    [-1n, '-0.000001'],
    [0n, '0.000000'],
    [1n, '0.000001'],
  ])('renders %s', (input, expected) => {
    expect(microsToUsd(input)).toBe(expected);
  });

  it('round-trips every canonical value', () => {
    for (const value of ['0', '1', '25.5', '1234567.891234']) {
      expect(usdToMicros(microsToUsd(usdToMicros(value)))).toBe(usdToMicros(value));
    }
  });
});

describe('priceToAtto', () => {
  it('keeps 18 decimals of precision', () => {
    expect(priceToAtto('1')).toBe(10n ** 18n);
    expect(priceToAtto('0.0000123456')).toBe(12_345_600_000_000n);
  });

  it('rejects malformed prices', () => {
    expect(() => priceToAtto('-1')).toThrow(/Malformed price/);
    expect(() => priceToAtto('1.0000000000000000001')).toThrow(/Malformed price/);
  });
});

describe('amountToBigint', () => {
  it('parses base units', () => {
    expect(amountToBigint('10000000')).toBe(10_000_000n);
    expect(amountToBigint('0')).toBe(0n);
  });

  it('rejects anything that is not a plain non-negative integer', () => {
    for (const bad of ['-1', '1.0', '0x10', '01', '1e3', '']) {
      expect(() => amountToBigint(bad)).toThrow(/Malformed amount/);
    }
  });
});

describe('nativeToUsdMicros', () => {
  it.each([
    ['10 USDC at 1.000027', 10_000_000n, 6, '1.000027', 'ceil' as const, 10_000_270n],
    ['0.005 WETH ceil', 5_000_000_000_000_000n, 18, '2500.123456', 'ceil' as const, 12_500_618n],
    ['0.005 WETH floor', 5_000_000_000_000_000n, 18, '2500.123456', 'floor' as const, 12_500_617n],
    [
      '0.0123456789 WETH ceil',
      12_345_678_900_000_000n,
      18,
      '2500.123456',
      'ceil' as const,
      30_865_722n,
    ],
    [
      '0.0123456789 WETH floor',
      12_345_678_900_000_000n,
      18,
      '2500.123456',
      'floor' as const,
      30_865_721n,
    ],
    ['1 SOL', 1_000_000_000n, 9, '111.790298', 'ceil' as const, 111_790_298n],
    ['5-decimal token', 1_000_000_000n, 5, '0.0000123456', 'ceil' as const, 123_456n],
    ['250k gas at 0.01 gwei', 2_500_000_000_000n, 18, '2500.123456', 'ceil' as const, 6_251n],
    ['200k gas at 1 gwei on BNB', 200_000_000_000_000n, 18, '600.5', 'ceil' as const, 120_100n],
    ['105k lamports', 105_000n, 9, '111.790298', 'ceil' as const, 11_738n],
  ])('%s', (_name, amount, decimals, price, rounding, expected) => {
    expect(nativeToUsdMicros(amount, decimals, priceToAtto(price), rounding)).toBe(expected);
  });

  it('never rounds a non-zero outgoing value down to zero', () => {
    const dust = nativeToUsdMicros(1n, 18, priceToAtto('2500'), 'ceil');
    expect(dust).toBe(1n);
  });

  it('rejects absurd decimals', () => {
    expect(() => nativeToUsdMicros(1n, -1, 1n, 'ceil')).toThrow(/decimals/);
    expect(() => nativeToUsdMicros(1n, 99, 1n, 'ceil')).toThrow(/decimals/);
  });
});

describe('impliedSlippageBps', () => {
  it.each([
    [111_790_298n, 111_231_347n, 50n],
    [1_000_000n, 995_000n, 50n],
    [1_000_000n, 994_999n, 51n],
    [3_999_800_000_000_000n, 3_987_800_600_000_000n, 30n],
    [1_000_000n, 1_000_000n, 0n],
  ])('expected %s min %s -> %s bps', (expected, min, bps) => {
    expect(impliedSlippageBps(expected, min)).toBe(bps);
  });

  it('rounds up rather than down', () => {
    // floor would give 49 here; the engine must see 50 and compare against the limit.
    expect(impliedSlippageBps(111_790_298n, 111_231_347n)).toBe(50n);
  });

  it('rejects impossible quotes', () => {
    expect(() => impliedSlippageBps(0n, 0n)).toThrow(/non-positive/);
    expect(() => impliedSlippageBps(100n, 101n)).toThrow(/exceeds expected/);
    expect(() => impliedSlippageBps(100n, -1n)).toThrow(/negative/);
  });
});

describe('division helpers', () => {
  it('ceilDiv rounds up for positive values', () => {
    expect(ceilDiv(10n, 3n)).toBe(4n);
    expect(ceilDiv(9n, 3n)).toBe(3n);
    expect(ceilDiv(0n, 3n)).toBe(0n);
  });

  it('floorDiv truncates', () => {
    expect(floorDiv(10n, 3n)).toBe(3n);
  });

  it('rejects a non-positive denominator', () => {
    expect(() => ceilDiv(1n, 0n)).toThrow();
    expect(() => floorDiv(1n, -1n)).toThrow();
  });
});

describe('bpsOf', () => {
  it('applies basis points rounded up', () => {
    expect(bpsOf(1_000_000n, 50)).toBe(5_000n);
    expect(bpsOf(1n, 1)).toBe(1n);
    expect(bpsOf(0n, 500)).toBe(0n);
  });

  it('rejects out-of-range basis points', () => {
    expect(() => bpsOf(1n, -1)).toThrow(/range/);
    expect(() => bpsOf(1n, 10_001)).toThrow(/range/);
  });
});
