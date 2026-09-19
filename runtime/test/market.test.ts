import { describe, expect, it } from 'vitest';
import { MarketService } from '../src/market/service.js';
import { DexScreenerProvider } from '../src/market/providers/dexscreener.js';
import { GeckoTerminalProvider } from '../src/market/providers/geckoterminal.js';
import type {
  MarketDataProvider,
  MarketSnapshot,
  OhlcvSeries,
  ProviderHealth,
} from '../src/market/types.js';

/**
 * Market-layer tests.
 *
 * No network: providers are stubbed so the assertions are about the service's
 * judgement, which is the part that decides whether ATRA believes a number.
 * The provider mapping itself is covered by feeding each one a recorded
 * response body.
 */

const NOW = 1_789_828_200_000;

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    chain: 'base',
    poolId: '0xpool',
    dexId: 'uniswap',
    base: { address: '0xbase', symbol: 'WETH', name: null, decimals: null },
    quote: { address: '0xquote', symbol: 'USDC', name: null, decimals: null },
    priceUsd: '2500',
    priceNative: '2500',
    liquidityUsd: '1000000',
    volume24hUsd: '500000',
    change: { m5: 1, h1: 10, h6: -20, h24: 150 },
    observedAt: new Date(NOW - 5_000).toISOString(),
    fetchedAt: new Date(NOW - 5_000).toISOString(),
    source: 'dexscreener',
    freshnessMs: 0,
    ...overrides,
  };
}

function stubProvider(
  source: MarketSnapshot['source'],
  behaviour: Partial<MarketDataProvider> = {},
): MarketDataProvider {
  return {
    source: source,
    chains: ['base', 'bsc', 'robinhood', 'solana'] as const,
    health: () =>
      Promise.resolve({
        source,
        healthy: true,
        latencyMs: 1,
        error: null,
        chains: ['base'],
      } as ProviderHealth),
    getPoolsForToken: () => Promise.resolve([snapshot({ source })]),
    getPool: () => Promise.resolve(snapshot({ source })),
    getTokenPriceUsd: () => Promise.resolve('2500'),
    search: () => Promise.resolve([snapshot({ source })]),
    ...behaviour,
  };
}

function service(providers: MarketDataProvider[]): MarketService {
  return new MarketService(providers, undefined, { now: () => NOW, cacheTtlMs: 0 });
}

describe('cross-checked pricing', () => {
  it('agrees when providers agree', async () => {
    const result = await service([
      stubProvider('dexscreener'),
      stubProvider('geckoterminal'),
    ]).getCrossCheckedPrice('base', '0xtoken');

    expect(result.priceUsd).toBe('2500');
    expect(result.sources).toHaveLength(2);
    expect(result.deviationBps).toBe(0);
    expect(result.disputed).toBe(false);
  });

  it('flags a disagreement instead of silently picking one', async () => {
    const result = await service([
      stubProvider('dexscreener'),
      stubProvider('geckoterminal', { getTokenPriceUsd: () => Promise.resolve('3000') }),
    ]).getCrossCheckedPrice('base', '0xtoken');

    // 2500 -> 3000 is 2000 bps, well past the 200 bps tolerance.
    expect(result.deviationBps).toBe(2000);
    expect(result.disputed).toBe(true);
    expect(result.reason).toContain('disagree');
    expect(result.sources).toHaveLength(2);
  });

  it('tolerates a small spread', async () => {
    const result = await service([
      stubProvider('dexscreener'),
      stubProvider('geckoterminal', { getTokenPriceUsd: () => Promise.resolve('2510') }),
    ]).getCrossCheckedPrice('base', '0xtoken');

    expect(result.deviationBps).toBe(40);
    expect(result.disputed).toBe(false);
  });

  it('says so when only one provider answered', async () => {
    const result = await service([
      stubProvider('dexscreener'),
      stubProvider('geckoterminal', { getTokenPriceUsd: () => Promise.resolve(null) }),
    ]).getCrossCheckedPrice('base', '0xtoken');

    expect(result.priceUsd).toBe('2500');
    expect(result.deviationBps).toBeNull();
    expect(result.reason).toContain('could not be cross-checked');
  });

  it('returns null rather than a guess when nothing answered', async () => {
    const result = await service([
      stubProvider('dexscreener', { getTokenPriceUsd: () => Promise.resolve(null) }),
    ]).getCrossCheckedPrice('base', '0xtoken');

    expect(result.priceUsd).toBeNull();
    expect(result.reason).toContain('no provider');
  });

  it('survives a provider that throws', async () => {
    const result = await service([
      stubProvider('dexscreener'),
      stubProvider('geckoterminal', {
        getTokenPriceUsd: () => Promise.reject(new Error('rate limited')),
      }),
    ]).getCrossCheckedPrice('base', '0xtoken');

    expect(result.priceUsd).toBe('2500');
    expect(result.sources).toHaveLength(1);
  });

  it('takes the median of three so one outlier cannot move the price', async () => {
    const result = await service([
      stubProvider('dexscreener', { getTokenPriceUsd: () => Promise.resolve('2500') }),
      stubProvider('geckoterminal', { getTokenPriceUsd: () => Promise.resolve('2510') }),
      stubProvider('jupiter', { getTokenPriceUsd: () => Promise.resolve('9999') }),
    ]).getCrossCheckedPrice('base', '0xtoken');

    expect(result.priceUsd).toBe('2510');
    expect(result.disputed).toBe(true);
  });
});

describe('freshness', () => {
  it('stamps age onto every snapshot', async () => {
    const pools = await service([stubProvider('dexscreener')]).getPoolsForToken('base', '0xtoken');
    expect(pools[0]?.freshnessMs).toBe(5_000);
  });

  it('marks an old snapshot stale', () => {
    const svc = service([stubProvider('dexscreener')]);
    expect(svc.isStale({ ...snapshot(), freshnessMs: 5_000 })).toBe(false);
    expect(svc.isStale({ ...snapshot(), freshnessMs: 600_000 })).toBe(true);
  });
});

describe('provider failures', () => {
  it('returns partial data when one provider fails', async () => {
    const pools = await service([
      stubProvider('dexscreener'),
      stubProvider('geckoterminal', { getPoolsForToken: () => Promise.reject(new Error('down')) }),
    ]).getPoolsForToken('base', '0xtoken');

    expect(pools).toHaveLength(1);
  });

  it('throws rather than reporting an empty market when all providers fail', async () => {
    await expect(
      service([
        stubProvider('dexscreener', { getPoolsForToken: () => Promise.reject(new Error('down')) }),
      ]).getPoolsForToken('base', '0xtoken'),
    ).rejects.toThrow(/Could not retrieve/);
  });

  it('refuses a chain no provider covers', async () => {
    const limited = stubProvider('dexscreener');
    Object.defineProperty(limited, 'chains', { value: ['base'] as const });

    await expect(service([limited]).getPoolsForToken('solana', 'mint')).rejects.toThrow(
      /No market-data provider covers solana/,
    );
  });
});

describe('DexScreener mapping', () => {
  const body = [
    {
      chainId: 'robinhood',
      dexId: 'uniswap',
      pairAddress: '0xabc',
      baseToken: { address: '0xWETH', name: 'Wrapped Ether', symbol: 'WETH' },
      quoteToken: { address: '0xUSDG', name: 'USDG', symbol: 'USDG' },
      priceUsd: '2645.69',
      priceNative: '1.0',
      liquidity: { usd: 24184560.43 },
      volume: { h24: 1000.5 },
      priceChange: { h24: 1.25 },
    },
  ];

  function provider(payload: unknown): DexScreenerProvider {
    return new DexScreenerProvider({
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    });
  }

  it('maps a Robinhood Chain pair', async () => {
    const [pool] = await provider(body).getPoolsForToken('robinhood', '0xWETH');

    expect(pool?.chain).toBe('robinhood');
    expect(pool?.priceUsd).toBe('2645.69');
    expect(pool?.liquidityUsd).toBe('24184560.43');
    expect(pool?.change.h24).toBe(125);
    expect(pool?.base.symbol).toBe('WETH');
  });

  it('never reports decimals it was not given', async () => {
    const [pool] = await provider(body).getPoolsForToken('robinhood', '0xWETH');
    expect(pool?.base.decimals).toBeNull();
  });

  it('drops a pair from a chain ATRA does not support', async () => {
    const pools = await provider([{ ...body[0], chainId: 'ethereum' }]).getPoolsForToken(
      'base',
      '0xtoken',
    );
    expect(pools).toEqual([]);
  });

  it('drops a pair belonging to a different chain than requested', async () => {
    const pools = await provider(body).getPoolsForToken('base', '0xtoken');
    expect(pools).toEqual([]);
  });

  it('drops a malformed row instead of propagating NaN', async () => {
    const pools = await provider([{ chainId: 'base', priceUsd: '1' }]).getPoolsForToken(
      'base',
      '0xtoken',
    );
    expect(pools).toEqual([]);
  });

  it('reports a missing price as null with a reason', async () => {
    const [pool] = await provider([{ ...body[0], priceUsd: null }]).getPoolsForToken(
      'robinhood',
      '0xWETH',
    );
    expect(pool?.priceUsd).toBeNull();
    expect(pool?.reason).toContain('no usable USD price');
  });

  it('rejects a price that is not a plain decimal', async () => {
    const [pool] = await provider([{ ...body[0], priceUsd: '1e-7' }]).getPoolsForToken(
      'robinhood',
      '0xWETH',
    );
    expect(pool?.priceUsd).toBeNull();
  });

  it('prices a token only from pools where it is the base token', async () => {
    const mixed = [
      // WETH is the quote here, so this pool's price describes USDC.
      {
        ...body[0],
        pairAddress: '0xwrong',
        baseToken: { address: '0xUSDC', symbol: 'USDC', name: 'USD Coin' },
        quoteToken: { address: '0xWETH', symbol: 'WETH', name: 'Wrapped Ether' },
        priceUsd: '1.0001',
        liquidity: { usd: 99999999 },
      },
      body[0],
    ];

    const price = await provider(mixed).getTokenPriceUsd('robinhood', '0xWETH');
    expect(price).toBe('2645.69');
  });

  it('surfaces a rate limit as a typed error', async () => {
    const limited = new DexScreenerProvider({
      fetchImpl: () => Promise.resolve(new Response('', { status: 429 })),
    });
    await expect(limited.getPoolsForToken('base', '0xtoken')).rejects.toThrow(/rate limit/i);
  });
});

describe('GeckoTerminal mapping', () => {
  function provider(payload: unknown): GeckoTerminalProvider {
    return new GeckoTerminalProvider({
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    });
  }

  it('reads a token price from the dedicated endpoint', async () => {
    const price = await provider({
      data: {
        attributes: {
          token_prices: { '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913': '1.00064674710845' },
        },
      },
    }).getTokenPriceUsd('base', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');

    expect(price).toBe('1.00064674710845');
  });

  it('maps a pool with its dex and liquidity', async () => {
    const [pool] = await provider({
      data: [
        {
          id: 'base_0xpool',
          type: 'pool',
          attributes: {
            name: 'WETH / USDC',
            address: '0xpool',
            base_token_price_usd: '2643.71',
            reserve_in_usd: '5000000',
            volume_usd: { h24: '1000' },
            price_change_percentage: { h24: '-1.5' },
          },
          relationships: {
            base_token: { data: { id: 'base_0xweth' } },
            quote_token: { data: { id: 'base_0xusdc' } },
            dex: { data: { id: 'uniswap_v3' } },
          },
        },
      ],
    }).getPoolsForToken('base', '0xweth');

    expect(pool?.priceUsd).toBe('2643.71');
    expect(pool?.liquidityUsd).toBe('5000000');
    expect(pool?.dexId).toBe('uniswap_v3');
    expect(pool?.base.address).toBe('0xweth');
    expect(pool?.change.h24).toBe(-150);
  });

  it('returns candles oldest first', async () => {
    const series: OhlcvSeries | null = await provider({
      data: {
        attributes: {
          ohlcv_list: [
            [1_700_000_600, 4, 5, 3, 4.5, 100],
            [1_700_000_000, 1, 2, 0.5, 1.5, 50],
          ],
        },
      },
    }).getOhlcv('base', '0xpool', '1h', 2);

    expect(series?.candles).toHaveLength(2);
    expect(series?.candles[0]?.open).toBe('1');
    expect(series?.candles[1]?.open).toBe('4');
  });

  it('returns null for an unexpected payload rather than throwing', async () => {
    const series = await provider({ unexpected: true }).getOhlcv('base', '0xpool', '1h', 2);
    expect(series).toBeNull();
  });
});
