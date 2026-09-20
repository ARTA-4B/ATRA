import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/database.js';
import type { Db } from '../src/db/database.js';
import { LiquidityStore } from '../src/liquidity/store.js';
import type { OpenRangePositionInput, RangeRealizedInput } from '../src/liquidity/store.js';
import { LedgerService } from '../src/trading/ledger.js';
import { lpPoolKey } from '../src/risk/types.js';
import { BASE_USDC, BASE_WETH, DAY_START, NOW } from './helpers/risk-fixtures.js';

/**
 * What a range position costs the operator, as the risk engine sees it.
 *
 * The storage tests next door prove the rows are right. These prove the three
 * places a right row still leaves real money unguarded: capital that no
 * deployed-total check counts, an exit whose loss no daily-loss check sees,
 * and a rebalance that no rebalance limit counts. Each one is asserted against
 * the exact figure a caller would read, because "roughly included" is the same
 * as excluded to a cap.
 *
 * Still nothing here builds or signs anything: the executor that would use any
 * of this does not exist yet, which is the whole reason these numbers have to
 * be right before it does.
 */

const PROTOCOL = 'uniswap-v3';
/** Uniswap v3 WETH/USDC 0.05% on Base, and the 0.3% pool over the same pair. */
const POOL = '0xd0b53d9277642d899df5c87a3966a349a798f224';
const OTHER_POOL = '0x6c561b446416e1a00e8e93e221854d6ea4171372';
const KEY = lpPoolKey('base', POOL);
const OTHER_KEY = lpPoolKey('base', OTHER_POOL);
const TOKEN_ID = '820451';

const LIQUIDITY = 3_000_000_000_000_000_000n;
const CAPITAL = 10_000_000n; // 10 USD

/** A fill that cost nothing and returned nothing, where only the row matters. */
const FREE: RangeRealizedInput = { proceedsUsd: 0n, feeUsd: 0n, simulated: true };

interface PnlRow {
  action: string;
  pool_id: string;
  proceeds_usd: string;
  cost_released_usd: string;
  fee_usd: string;
  realized_pnl_usd: string;
  simulated: number;
  trade_id: string | null;
}

interface RebalanceRow {
  mode: string;
  chain: string;
  pool_id: string;
  closed_token_id: string;
  opened_token_id: string;
  closed_position_id: string;
  opened_position_id: string;
  day_start_utc_ms: number;
  at: string;
}

function openInput(overrides: Partial<OpenRangePositionInput> = {}): OpenRangePositionInput {
  return {
    mode: 'PAPER',
    chain: 'base',
    protocol: PROTOCOL,
    poolId: POOL,
    tokenId: TOKEN_ID,
    token0: { address: BASE_WETH, decimals: 18 },
    token1: { address: BASE_USDC, decimals: 6 },
    feePips: 500,
    tickLower: -201_000,
    tickUpper: -199_000,
    liquidity: LIQUIDITY.toString(),
    capitalUsd: CAPITAL,
    realized: FREE,
    at: NOW,
    ...overrides,
  };
}

describe('range positions in the risk snapshot', () => {
  let db: Db;
  let store: LiquidityStore;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    store = new LiquidityStore(db, () => NOW);
  });

  afterEach(() => closeDatabase(db));

  /** A v2 position in POOL worth 100 USD, so the two families share a key. */
  function bookV2(): void {
    store.bookAdd({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      poolId: POOL,
      token0: { address: BASE_WETH, decimals: 18 },
      token1: { address: BASE_USDC, decimals: 6 },
      lpTokens: '1000000000000000000',
      amount0: '40000000000000000',
      amount1: '100000000',
      capitalUsd: '100',
      at: NOW,
    });
  }

  it('counts range capital as deployed capital', () => {
    bookV2();
    store.openRangePosition(openInput());
    store.openRangePosition(
      openInput({ tokenId: '2', poolId: OTHER_POOL, feePips: 3000, capitalUsd: 25_500_000n }),
    );

    // 100 of v2 plus 10 plus 25.50 of v3. Without the v3 half an operator with
    // a 110 USD cap could stand in 135.50 and nothing would say so.
    expect(store.toRiskSnapshot('PAPER').deployedUsd).toBe('135.500000');
  });

  it('leaves the v2 positions map exactly as it was', () => {
    bookV2();
    store.openRangePosition(openInput());
    store.openRangePosition(openInput({ tokenId: '2', poolId: OTHER_POOL, feePips: 3000 }));

    const snapshot = store.toRiskSnapshot('PAPER');
    // The pool both families sit in reports the v2 row and only the v2 row:
    // the engine judges a burn against `lpTokens`, and a range position has
    // none — its size is liquidity, which no v2 exit is denominated in.
    expect(snapshot.positions).toEqual({
      [KEY]: { lpTokens: '1000000000000000000', capitalUsd: '100.000000' },
    });
    // And a pool that holds nothing but range positions stays absent rather
    // than appearing with an invented zero balance.
    expect(snapshot.positions[OTHER_KEY]).toBeUndefined();
  });

  it('drops a range position out of deployed capital when it closes', () => {
    store.openRangePosition(openInput());
    expect(store.toRiskSnapshot('PAPER').deployedUsd).toBe('10.000000');

    store.adjustRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      liquidityDelta: -1_000_000_000_000_000_000n,
      realized: FREE,
      at: NOW,
    });
    // A third of the basis left with the third of the liquidity, rounded the
    // way the store rounds it.
    expect(store.toRiskSnapshot('PAPER').deployedUsd).toBe('6.666666');

    store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      realized: FREE,
      at: NOW,
    });
    expect(store.toRiskSnapshot('PAPER').deployedUsd).toBe('0.000000');
  });

  it("never lets one mode see the other mode's range capital", () => {
    store.openRangePosition(openInput());
    store.openRangePosition(openInput({ mode: 'LIVE', capitalUsd: 250_000_000n }));

    expect(store.toRiskSnapshot('PAPER').deployedUsd).toBe('10.000000');
    expect(store.toRiskSnapshot('LIVE').deployedUsd).toBe('250.000000');
  });
});

describe('range position realized P&L', () => {
  let db: Db;
  let store: LiquidityStore;
  let ledger: LedgerService;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    store = new LiquidityStore(db, () => NOW);
    ledger = new LedgerService(db, () => NOW);
  });

  afterEach(() => closeDatabase(db));

  function pnl(): PnlRow[] {
    return db.prepare<[], PnlRow>('SELECT * FROM lp_pnl ORDER BY rowid').all();
  }

  it('puts a range exit in front of the daily-loss check', () => {
    store.openRangePosition(
      openInput({ realized: { proceedsUsd: 0n, feeUsd: 650_000n, simulated: true } }),
    );
    // Entering realizes nothing but the gas, so the day is already down 0.65.
    expect(ledger.realizedPnlTodayUsd('PAPER')).toBe(-650_000n);

    const closed = store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      realized: {
        tradeId: 'trade-x',
        proceedsUsd: 9_000_000n,
        feeUsd: 400_000n,
        simulated: true,
      },
      at: NOW,
    });

    // 10 USD went in, 9 came back, 0.40 of gas: one USD of impermanent loss
    // and 0.40 of gas, not the silence the store used to keep about it.
    expect(closed.costReleasedUsd).toBe(CAPITAL);
    expect(closed.realizedPnlUsd).toBe(-1_400_000n);
    expect(ledger.realizedPnlTodayUsd('PAPER')).toBe(-2_050_000n);
    expect(ledger.realizedPnlTodayUsd('LIVE')).toBe(0n);

    expect(pnl()).toEqual([
      expect.objectContaining({
        action: 'ADD',
        pool_id: POOL,
        proceeds_usd: '0.000000',
        cost_released_usd: '0.000000',
        fee_usd: '0.650000',
        realized_pnl_usd: '-0.650000',
        simulated: 1,
        trade_id: null,
      }),
      expect.objectContaining({
        action: 'EXIT',
        pool_id: POOL,
        proceeds_usd: '9.000000',
        cost_released_usd: '10.000000',
        fee_usd: '0.400000',
        realized_pnl_usd: '-1.400000',
        simulated: 1,
        trade_id: 'trade-x',
      }),
    ]);
  });

  it('books a partial burn against the basis that burn released', () => {
    store.openRangePosition(openInput());
    const result = store.adjustRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      liquidityDelta: -1_000_000_000_000_000_000n,
      realized: { proceedsUsd: 3_000_000n, feeUsd: 100_000n, simulated: true },
      at: NOW,
    });

    // 3.000000 back against 3.333334 of basis, less 0.100000 of gas. The
    // released basis is the store's own figure; nobody has to pass it in and
    // so nobody can pass in the wrong one.
    expect(result.costReleasedUsd).toBe(3_333_334n);
    expect(result.realizedPnlUsd).toBe(-433_334n);
    expect(pnl().map((row) => [row.action, row.cost_released_usd, row.realized_pnl_usd])).toEqual([
      ['ADD', '0.000000', '0.000000'],
      ['REMOVE', '3.333334', '-0.433334'],
    ]);
  });

  it('realizes an increase as its gas and nothing else', () => {
    store.openRangePosition(openInput());
    const result = store.adjustRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      liquidityDelta: 1_000_000_000_000_000_000n,
      capitalUsd: 5_000_000n,
      realized: { proceedsUsd: 0n, feeUsd: 250_000n, simulated: true },
      at: NOW,
    });

    expect(result.costReleasedUsd).toBe(0n);
    expect(result.realizedPnlUsd).toBe(-250_000n);
    // The capital paid in is a position, not a loss; only the gas is spent.
    expect(store.toRiskSnapshot('PAPER').deployedUsd).toBe('15.000000');
    expect(ledger.realizedPnlTodayUsd('PAPER')).toBe(-250_000n);
  });

  it('marks a LIVE fill as a LIVE fill', () => {
    store.openRangePosition(
      openInput({
        mode: 'LIVE',
        realized: { proceedsUsd: 0n, feeUsd: 120_000n, simulated: false },
      }),
    );
    expect(pnl()).toEqual([expect.objectContaining({ simulated: 0, fee_usd: '0.120000' })]);
    expect(ledger.realizedPnlTodayUsd('LIVE')).toBe(-120_000n);
    expect(ledger.realizedPnlTodayUsd('PAPER')).toBe(0n);
  });

  it('refuses a realized block that cannot describe a real fill', () => {
    expect(() =>
      store.openRangePosition(
        openInput({ realized: { proceedsUsd: 0n, feeUsd: -1n, simulated: true } }),
      ),
    ).toThrow(/Gas is a cost/);
    expect(() =>
      store.openRangePosition(
        openInput({ realized: { proceedsUsd: -1n, feeUsd: 0n, simulated: true } }),
      ),
    ).toThrow(/negative amount/);
    // Minting takes assets in; anything it claims to have handed back is the
    // caller confusing what it paid with what it got.
    expect(() =>
      store.openRangePosition(
        openInput({ realized: { proceedsUsd: 1n, feeUsd: 0n, simulated: true } }),
      ),
    ).toThrow(/no proceeds/);

    // Refused before anything was written, on every one of them.
    expect(store.listRangePositions('PAPER', { includeClosed: true })).toEqual([]);
    expect(pnl()).toEqual([]);

    store.openRangePosition(openInput());
    expect(() =>
      store.adjustRangePosition({
        mode: 'PAPER',
        chain: 'base',
        protocol: PROTOCOL,
        tokenId: TOKEN_ID,
        liquidityDelta: 1n,
        capitalUsd: 1n,
        realized: { proceedsUsd: 1n, feeUsd: 0n, simulated: true },
        at: NOW,
      }),
    ).toThrow(/no proceeds/);
    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, TOKEN_ID)?.liquidity).toBe(
      LIQUIDITY.toString(),
    );
    expect(pnl()).toHaveLength(1);
  });
});

describe('v3 rebalance counting', () => {
  let db: Db;
  let store: LiquidityStore;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    store = new LiquidityStore(db, () => NOW);
  });

  afterEach(() => closeDatabase(db));

  function rebalanceRows(): RebalanceRow[] {
    return db.prepare<[], RebalanceRow>('SELECT * FROM lp_range_rebalances ORDER BY rowid').all();
  }

  /** Burn the old range out and mint the new one, the way a rebalance goes. */
  function rebalance(from: string, to: string): void {
    store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: from,
      realized: { proceedsUsd: CAPITAL, feeUsd: 0n, simulated: true },
      at: NOW,
    });
    store.openRangePosition(openInput({ tokenId: to, rebalancedFrom: from }));
  }

  it('counts the burn and the mint as one rebalance, at the mint', () => {
    const first = store.openRangePosition(openInput({ tokenId: '1' }));
    // The burn on its own is an exit: nothing about it says a new range is
    // coming, and charging it a rebalance would bill a run that then failed
    // to mint for a rebalance the operator never got.
    store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: '1',
      realized: { proceedsUsd: CAPITAL, feeUsd: 0n, simulated: true },
      at: NOW,
    });
    expect(store.rangeRebalancesToday('PAPER', 'base', POOL)).toBe(0);

    const second = store.openRangePosition(openInput({ tokenId: '2', rebalancedFrom: '1' }));
    expect(store.rangeRebalancesToday('PAPER', 'base', POOL)).toBe(1);
    expect(store.toRiskSnapshot('PAPER').rebalancesToday).toEqual({ [KEY]: 1 });

    // One row, and it says which position replaced which.
    expect(rebalanceRows()).toEqual([
      expect.objectContaining({
        mode: 'PAPER',
        chain: 'base',
        pool_id: POOL,
        closed_token_id: '1',
        opened_token_id: '2',
        closed_position_id: first.id,
        opened_position_id: second.id,
        day_start_utc_ms: DAY_START,
        at: new Date(NOW).toISOString(),
      }),
    ]);
  });

  it('books a rebalance mint as a REBALANCE, and a plain mint as an ADD', () => {
    store.openRangePosition(openInput({ tokenId: '1' }));
    rebalance('1', '2');

    expect(
      db
        .prepare<[], { action: string }>('SELECT action FROM lp_pnl ORDER BY rowid')
        .all()
        .map((row) => row.action),
    ).toEqual(['ADD', 'EXIT', 'REBALANCE']);
  });

  it('adds v2 and v3 rebalances together on the pool they share', () => {
    store.bookAdd({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      poolId: POOL,
      token0: { address: BASE_WETH, decimals: 18 },
      token1: { address: BASE_USDC, decimals: 6 },
      lpTokens: '1000000000000000000',
      amount0: '40000000000000000',
      amount1: '100000000',
      capitalUsd: '100',
      at: NOW,
      rebalance: true,
    });
    store.openRangePosition(openInput({ tokenId: '1' }));
    rebalance('1', '2');

    // Two rebalances happened in this pool today. Taking the larger of the two
    // families would report one and let a mixed book have both.
    expect(store.rebalancesToday('PAPER', 'base', POOL)).toBe(1);
    expect(store.rangeRebalancesToday('PAPER', 'base', POOL)).toBe(1);
    expect(store.toRiskSnapshot('PAPER').rebalancesToday).toEqual({ [KEY]: 2 });
  });

  it('remembers a rebalance whose new position is already gone', () => {
    store.openRangePosition(openInput({ tokenId: '1' }));
    rebalance('1', '2');
    store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: '2',
      realized: { proceedsUsd: CAPITAL, feeUsd: 0n, simulated: true },
      at: NOW,
    });

    // Nothing is open, so a count read off the positions would now say zero —
    // and the day's limit would reset itself every time a range was exited.
    expect(store.listRangePositions('PAPER')).toEqual([]);
    expect(store.toRiskSnapshot('PAPER').rebalancesToday).toEqual({ [KEY]: 1 });
  });

  it('counts a move to another fee tier against the pool it moved into', () => {
    store.openRangePosition(openInput({ tokenId: '1' }));
    store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: '1',
      realized: { proceedsUsd: CAPITAL, feeUsd: 0n, simulated: true },
      at: NOW,
    });
    store.openRangePosition(
      openInput({ tokenId: '2', poolId: OTHER_POOL, feePips: 3000, rebalancedFrom: '1' }),
    );

    expect(store.toRiskSnapshot('PAPER').rebalancesToday).toEqual({ [OTHER_KEY]: 1 });
    expect(store.rangeRebalancesToday('PAPER', 'base', POOL)).toBe(0);
  });

  it('counts a rebalance against the day it happened on', () => {
    const yesterday = DAY_START - 1;
    store.openRangePosition(openInput({ tokenId: '1', at: yesterday }));
    store.openRangePosition(openInput({ tokenId: '2', rebalancedFrom: '1', at: yesterday }));

    expect(store.rangeRebalancesToday('PAPER', 'base', POOL, yesterday)).toBe(1);
    expect(store.rangeRebalancesToday('PAPER', 'base', POOL, NOW)).toBe(0);
    expect(store.toRiskSnapshot('PAPER', NOW).rebalancesToday).toEqual({});
  });

  it("keeps one mode's rebalances out of the other's count", () => {
    store.openRangePosition(openInput({ tokenId: '1' }));
    rebalance('1', '2');

    expect(store.rangeRebalancesToday('LIVE', 'base', POOL)).toBe(0);
    expect(store.toRiskSnapshot('LIVE').rebalancesToday).toEqual({});
  });

  it('refuses a rebalance out of a position it has never booked', () => {
    expect(() =>
      store.openRangePosition(openInput({ tokenId: '2', rebalancedFrom: '999' })),
    ).toThrow(/rebalance out of/);
    // The mint went down with the claim: a position booked without its
    // rebalance is a rebalance the limit would never see.
    expect(store.listRangePositions('PAPER', { includeClosed: true })).toEqual([]);
    expect(rebalanceRows()).toEqual([]);

    expect(() => store.openRangePosition(openInput({ rebalancedFrom: TOKEN_ID }))).toThrow(
      /not with itself/,
    );
    // A LIVE position is not a PAPER one, whatever its token id says.
    store.openRangePosition(openInput({ tokenId: '1', mode: 'LIVE' }));
    expect(() => store.openRangePosition(openInput({ tokenId: '2', rebalancedFrom: '1' }))).toThrow(
      /rebalance out of/,
    );
  });

  it('keeps the rebalance trail beyond the reach of an UPDATE or a DELETE', () => {
    store.openRangePosition(openInput({ tokenId: '1' }));
    rebalance('1', '2');

    expect(() => db.prepare("UPDATE lp_range_rebalances SET closed_token_id = '9'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM lp_range_rebalances').run()).toThrow(/append-only/);
    expect(rebalanceRows()).toHaveLength(1);
  });
});
