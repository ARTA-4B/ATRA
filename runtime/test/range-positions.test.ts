import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/database.js';
import type { Db } from '../src/db/database.js';
import { LiquidityStore } from '../src/liquidity/store.js';
import type { OpenRangePositionInput, RangeRealizedInput } from '../src/liquidity/store.js';
import { BASE_USDC, BASE_WETH, NOW } from './helpers/risk-fixtures.js';

/**
 * Concentrated-liquidity position storage.
 *
 * The point of these tests is that the v3 shelf holds what a v3 position
 * actually is — several NFTs in one pool, each with a fixed tick range, closed
 * by reaching zero liquidity rather than by disappearing — and that it does so
 * without the v2 ledger noticing. So every arithmetic assertion is exact, and
 * the two families are checked side by side on the same key, where a shared
 * table would show up immediately.
 *
 * Nothing here builds or signs anything, because there is nothing here that
 * could: the store writes rows an executor would hand it, and this increment
 * has no executor.
 */

const PROTOCOL = 'uniswap-v3';
/** Uniswap v3 WETH/USDC 0.05% on Base, and the 0.3% pool over the same pair. */
const POOL = '0xd0b53d9277642d899df5c87a3966a349a798f224';
const OTHER_POOL = '0x6c561b446416e1a00e8e93e221854d6ea4171372';
const TOKEN_ID = '820451';
const AT = new Date(NOW).toISOString();

/** Three whole units of liquidity: a basis that divides by three unevenly. */
const LIQUIDITY = 3_000_000_000_000_000_000n;
const CAPITAL = 10_000_000n; // 10 USD

/**
 * A free fill that returned nothing. The cost-basis assertions below are about
 * what the store computes for itself, so the figures only the executor knows
 * are held at zero here and exercised in range-risk.test.ts instead.
 */
const FREE: RangeRealizedInput = { proceedsUsd: 0n, feeUsd: 0n, simulated: true };

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

describe('LiquidityStore range positions', () => {
  let db: Db;
  let store: LiquidityStore;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    store = new LiquidityStore(db, () => NOW);
  });

  afterEach(() => closeDatabase(db));

  it('books a freshly minted position at what it cost', () => {
    const opened = store.openRangePosition(openInput());

    expect(opened).toMatchObject({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      poolId: POOL,
      tokenId: TOKEN_ID,
      token0: BASE_WETH,
      token1: BASE_USDC,
      decimals0: 18,
      decimals1: 6,
      feePips: 500,
      tickLower: -201_000,
      tickUpper: -199_000,
      liquidity: LIQUIDITY.toString(),
      capitalUsd: CAPITAL,
      openedAt: AT,
      lastAction: 'ADD',
      lastActionAt: AT,
      closedAt: null,
    });
    // Never observed yet, so no value is claimed for it.
    expect(opened.mark).toEqual({
      valueUsd: null,
      feesUsd: null,
      amount0: null,
      amount1: null,
      inRange: null,
      poolTick: null,
      note: null,
      markedAt: null,
    });

    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, TOKEN_ID)).toEqual(opened);
    expect(store.listRangePositions('PAPER').map((p) => p.tokenId)).toEqual([TOKEN_ID]);
    expect(store.listRangePositions('LIVE')).toEqual([]);

    const events = store.listRangeEvents({ tokenId: TOKEN_ID });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      positionId: opened.id,
      action: 'ADD',
      liquidityDelta: LIQUIDITY.toString(),
      liquidityAfter: LIQUIDITY.toString(),
      capitalDeltaUsd: CAPITAL,
      capitalAfterUsd: CAPITAL,
      at: AT,
    });
  });

  it('refuses to book the same token id twice', () => {
    store.openRangePosition(openInput());
    // An ERC-721 is minted once; a second open would be two lots of capital
    // claiming one position. Adding to it is an adjustment.
    expect(() => store.openRangePosition(openInput({ capitalUsd: 1n }))).toThrow(/already booked/);
    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, TOKEN_ID)?.capitalUsd).toBe(CAPITAL);
    expect(store.listRangeEvents({ tokenId: TOKEN_ID })).toHaveLength(1);
  });

  it('refuses a position the chain could not have minted', () => {
    expect(() => store.openRangePosition(openInput({ liquidity: '0' }))).toThrow(
      /positive liquidity/,
    );
    expect(() =>
      store.openRangePosition(openInput({ tickLower: -199_000, tickUpper: -201_000 })),
    ).toThrow(/empty or inverted/);
    expect(() => store.openRangePosition(openInput({ tickLower: -900_000 }))).toThrow(/tick range/);
    expect(() => store.openRangePosition(openInput({ feePips: 0 }))).toThrow(/fee tier/);
    expect(() => store.openRangePosition(openInput({ capitalUsd: -1n }))).toThrow(/negative/);
    // '0820451' and '820451' are one position on chain.
    expect(() => store.openRangePosition(openInput({ tokenId: '0820451' }))).toThrow(/token id/);
    expect(store.listRangePositions('PAPER')).toEqual([]);
  });

  it('adds what an increase paid to the basis', () => {
    store.openRangePosition(openInput());
    const result = store.adjustRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      liquidityDelta: 1_000_000_000_000_000_000n,
      capitalUsd: 5_000_000n,
      realized: FREE,
      at: NOW,
    });

    expect(result.closed).toBe(false);
    expect(result.costReleasedUsd).toBe(0n);
    expect(result.position.liquidity).toBe('4000000000000000000');
    expect(result.position.capitalUsd).toBe(15_000_000n);
    expect(result.position.lastAction).toBe('ADD');
    expect(result.position.closedAt).toBeNull();

    const events = store.listRangeEvents({ tokenId: TOKEN_ID });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      action: 'ADD',
      liquidityDelta: '1000000000000000000',
      liquidityAfter: '4000000000000000000',
      capitalDeltaUsd: 5_000_000n,
      capitalAfterUsd: 15_000_000n,
    });
  });

  it('releases cost basis pro rata, rounded up, on a partial decrease', () => {
    store.openRangePosition(openInput());
    const result = store.adjustRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      liquidityDelta: -1_000_000_000_000_000_000n,
      realized: FREE,
      at: NOW,
    });

    // A third of 10.000000 USD is 3.333333.33; the burn releases the cent-up
    // figure, which is the conservative direction for realized profit.
    expect(result.costReleasedUsd).toBe(3_333_334n);
    expect(result.closed).toBe(false);
    expect(result.position.liquidity).toBe('2000000000000000000');
    expect(result.position.capitalUsd).toBe(6_666_666n);
    expect(result.position.lastAction).toBe('REMOVE');
    expect(result.position.closedAt).toBeNull();
    expect(store.listRangePositions('PAPER')).toHaveLength(1);

    expect(store.listRangeEvents({ tokenId: TOKEN_ID })[0]).toMatchObject({
      action: 'REMOVE',
      liquidityDelta: '-1000000000000000000',
      liquidityAfter: '2000000000000000000',
      capitalDeltaUsd: -3_333_334n,
      capitalAfterUsd: 6_666_666n,
    });
  });

  it('closes at zero liquidity and keeps the row', () => {
    store.openRangePosition(openInput());
    const partial = store.adjustRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      liquidityDelta: -1_000_000_000_000_000_000n,
      realized: FREE,
      at: NOW,
    });
    const closed = store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      realized: FREE,
      at: NOW,
    });

    expect(closed.closed).toBe(true);
    expect(closed.costReleasedUsd).toBe(6_666_666n);
    // Every micro-USD paid in came back out as released basis, once.
    expect(partial.costReleasedUsd + closed.costReleasedUsd).toBe(CAPITAL);
    expect(closed.position.liquidity).toBe('0');
    expect(closed.position.capitalUsd).toBe(0n);
    expect(closed.position.lastAction).toBe('EXIT');
    expect(closed.position.closedAt).toBe(AT);

    // Closed means gone from the working set, not gone.
    expect(store.listRangePositions('PAPER')).toEqual([]);
    expect(store.listRangePositions('PAPER', { includeClosed: true })).toHaveLength(1);
    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, TOKEN_ID)?.liquidity).toBe('0');
    expect(store.listRangeEvents({ tokenId: TOKEN_ID }).map((e) => e.action)).toEqual([
      'EXIT',
      'REMOVE',
      'ADD',
    ]);
  });

  it('refuses an adjustment that is not one', () => {
    store.openRangePosition(openInput());
    const base = {
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      realized: FREE,
      at: NOW,
    } as const;

    expect(() => store.adjustRangePosition({ ...base, liquidityDelta: 0n })).toThrow(
      /must move liquidity/,
    );
    expect(() => store.adjustRangePosition({ ...base, liquidityDelta: -LIQUIDITY - 1n })).toThrow(
      /exceeds the range position/,
    );
    // Proceeds are not cost: a burn releases basis, it never pays any in.
    expect(() =>
      store.adjustRangePosition({ ...base, liquidityDelta: -1n, capitalUsd: 1n }),
    ).toThrow(/releases cost basis/);
    expect(() =>
      store.adjustRangePosition({ ...base, tokenId: '999', liquidityDelta: 1n, capitalUsd: 1n }),
    ).toThrow(/No range position to adjust/);
    expect(() => store.closeRangePosition({ ...base, tokenId: '999' })).toThrow(
      /No range position to close/,
    );

    // The failures left nothing behind.
    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, TOKEN_ID)).toMatchObject({
      liquidity: LIQUIDITY.toString(),
      capitalUsd: CAPITAL,
    });
    expect(store.listRangeEvents({ tokenId: TOKEN_ID })).toHaveLength(1);
  });

  it('refuses to close a position twice', () => {
    store.openRangePosition(openInput());
    const close = () =>
      store.closeRangePosition({
        mode: 'PAPER',
        chain: 'base',
        protocol: PROTOCOL,
        tokenId: TOKEN_ID,
        realized: FREE,
        at: NOW,
      });
    expect(close().costReleasedUsd).toBe(CAPITAL);
    expect(close).toThrow(/already closed/);
    expect(store.listRangeEvents({ tokenId: TOKEN_ID })).toHaveLength(2);
  });

  it('lets a closed position be increased again, because the chain does', () => {
    store.openRangePosition(openInput());
    store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      realized: FREE,
      at: NOW,
    });

    // Decreasing to zero does not burn the NFT, so the same token id can hold
    // liquidity again; the row is re-opened rather than refused or duplicated.
    const reopened = store.adjustRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      liquidityDelta: LIQUIDITY,
      capitalUsd: 4_000_000n,
      realized: FREE,
      at: NOW,
    });

    expect(reopened.position.closedAt).toBeNull();
    expect(reopened.position.liquidity).toBe(LIQUIDITY.toString());
    expect(reopened.position.capitalUsd).toBe(4_000_000n);
    expect(store.listRangePositions('PAPER')).toHaveLength(1);
    expect(store.listRangeEvents({ tokenId: TOKEN_ID })).toHaveLength(3);
  });

  it('holds several positions in one pool at once', () => {
    const wide = store.openRangePosition(
      openInput({ tokenId: '1', tickLower: -210_000, tickUpper: -190_000 }),
    );
    const narrow = store.openRangePosition(
      openInput({ tokenId: '2', tickLower: -201_000, tickUpper: -200_000 }),
    );
    const stale = store.openRangePosition(
      openInput({ tokenId: '3', tickLower: -180_000, tickUpper: -170_000 }),
    );
    const elsewhere = store.openRangePosition(
      openInput({ tokenId: '4', poolId: OTHER_POOL, feePips: 3000 }),
    );

    // Four rows, three of them in the same pool, each with its own range:
    // the case lp_positions cannot represent at all.
    expect(
      store.listPoolRangePositions('PAPER', 'base', PROTOCOL, POOL).map((p) => p.tokenId),
    ).toEqual(['1', '2', '3']);
    expect(
      store.listPoolRangePositions('PAPER', 'base', PROTOCOL, OTHER_POOL).map((p) => p.tokenId),
    ).toEqual(['4']);
    expect(new Set([wide.id, narrow.id, stale.id, elsewhere.id]).size).toBe(4);

    store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: '2',
      realized: FREE,
      at: NOW,
    });

    expect(
      store.listPoolRangePositions('PAPER', 'base', PROTOCOL, POOL).map((p) => p.tokenId),
    ).toEqual(['1', '3']);
    expect(
      store
        .listPoolRangePositions('PAPER', 'base', PROTOCOL, POOL, { includeClosed: true })
        .map((p) => p.tokenId),
    ).toEqual(['1', '2', '3']);
    expect(store.listRangePositions('PAPER').map((p) => p.tokenId)).toEqual(['1', '3', '4']);
    // Closing one left the others' money alone.
    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, '1')?.capitalUsd).toBe(CAPITAL);
    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, '3')?.capitalUsd).toBe(CAPITAL);
  });

  it('never lets PAPER and LIVE share a position row', () => {
    store.openRangePosition(openInput());
    store.openRangePosition(openInput({ mode: 'LIVE', capitalUsd: 250_000_000n }));

    expect(store.listRangePositions('PAPER')).toHaveLength(1);
    expect(store.listRangePositions('LIVE')).toHaveLength(1);
    expect(store.getRangePosition('LIVE', 'base', PROTOCOL, TOKEN_ID)?.capitalUsd).toBe(
      250_000_000n,
    );

    store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      realized: FREE,
      at: NOW,
    });
    expect(store.getRangePosition('LIVE', 'base', PROTOCOL, TOKEN_ID)).toMatchObject({
      liquidity: LIQUIDITY.toString(),
      capitalUsd: 250_000_000n,
      closedAt: null,
    });
    expect(store.listRangeEvents({ mode: 'LIVE' })).toHaveLength(1);
  });

  it('records what a cycle observed, and claims nothing before one has', () => {
    store.openRangePosition(openInput());
    store.markRangePosition('PAPER', 'base', PROTOCOL, TOKEN_ID, {
      valueUsd: 9_500_000n,
      feesUsd: 120_000n,
      amount0: '1200000000000000',
      amount1: '6400000',
      inRange: false,
      poolTick: -202_500,
      note: 'below range: all token0',
      at: NOW,
    });

    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, TOKEN_ID)?.mark).toEqual({
      valueUsd: 9_500_000n,
      feesUsd: 120_000n,
      amount0: '1200000000000000',
      amount1: '6400000',
      inRange: false,
      poolTick: -202_500,
      note: 'below range: all token0',
      markedAt: AT,
    });
    // A mark is an observation, not a change to the position.
    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, TOKEN_ID)?.capitalUsd).toBe(CAPITAL);
    expect(store.listRangeEvents({ tokenId: TOKEN_ID })).toHaveLength(1);
  });

  it('keeps the audit trail beyond the reach of an UPDATE or a DELETE', () => {
    store.openRangePosition(openInput());

    expect(() => db.prepare("UPDATE lp_range_events SET liquidity_delta = '1'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM lp_range_events').run()).toThrow(/append-only/);
    // A closed position is a row that says so; deleting it is how the trail
    // would be lost, so the database refuses rather than trusting the code.
    expect(() => db.prepare('DELETE FROM lp_range_positions').run()).toThrow(/append-only/);
    expect(store.listRangeEvents({})).toHaveLength(1);
  });

  it('holds a position to the range and identity it was minted with', () => {
    store.openRangePosition(openInput());

    expect(() => db.prepare('UPDATE lp_range_positions SET tick_lower = -202000').run()).toThrow(
      /immutable/,
    );
    expect(() => db.prepare("UPDATE lp_range_positions SET token_id = '9'").run()).toThrow(
      /immutable/,
    );
    expect(() => db.prepare('UPDATE lp_range_positions SET fee_pips = 3000').run()).toThrow(
      /immutable/,
    );
    // "Closed" is zero liquidity, not a flag: the two cannot drift apart.
    expect(() =>
      db
        .prepare('UPDATE lp_range_positions SET closed_at = ? WHERE token_id = ?')
        .run(AT, TOKEN_ID),
    ).toThrow(/CHECK constraint failed/);
    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, TOKEN_ID)).toMatchObject({
      tickLower: -201_000,
      feePips: 500,
      closedAt: null,
    });
  });

  it('is invisible to the v2 ledger, and blind to it, on the very same key', () => {
    // Same mode, chain, protocol and pool on both sides: if the two families
    // shared a table or a key, this is where they would collide.
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
    store.openRangePosition(openInput());

    expect(store.listPositions('PAPER').map((p) => p.lpTokens)).toEqual(['1000000000000000000']);
    expect(store.listRangePositions('PAPER').map((p) => p.tokenId)).toEqual([TOKEN_ID]);
    expect(store.getPosition('PAPER', 'base', PROTOCOL, POOL)?.capitalUsd).toBe('100.000000');

    // Two rows, one pool key, one figure: the snapshot adds both families'
    // capital without either row learning about the other.
    expect(store.toRiskSnapshot('PAPER').deployedUsd).toBe('110.000000');
    expect(store.toRiskSnapshot('PAPER').positions[`base:${POOL}`]).toEqual({
      lpTokens: '1000000000000000000',
      capitalUsd: '100.000000',
    });

    // Closing the range position leaves the v2 row exactly as it was.
    store.closeRangePosition({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      tokenId: TOKEN_ID,
      realized: FREE,
      at: NOW,
    });
    expect(store.getPosition('PAPER', 'base', PROTOCOL, POOL)).toMatchObject({
      lpTokens: '1000000000000000000',
      capitalUsd: '100.000000',
      lastAction: 'ADD',
    });
    expect(store.listPositions('PAPER')).toHaveLength(1);
    // The range capital left with the range position; the v2 figure did not move.
    expect(store.toRiskSnapshot('PAPER').deployedUsd).toBe('100.000000');

    // And burning the v2 position out entirely leaves the range row alone.
    const burned = store.bookRemove({
      mode: 'PAPER',
      chain: 'base',
      protocol: PROTOCOL,
      poolId: POOL,
      lpTokens: '1000000000000000000',
      at: NOW,
    });
    expect(burned.closed).toBe(true);
    expect(store.getPosition('PAPER', 'base', PROTOCOL, POOL)).toBeUndefined();
    expect(store.getRangePosition('PAPER', 'base', PROTOCOL, TOKEN_ID)).toMatchObject({
      tokenId: TOKEN_ID,
      liquidity: '0',
      closedAt: AT,
    });
    expect(store.listRangePositions('PAPER', { includeClosed: true })).toHaveLength(1);

    // Nothing open on either side, so nothing deployed on either side.
    expect(store.toRiskSnapshot('PAPER')).toEqual({
      deployedUsd: '0.000000',
      rebalancesToday: {},
      positions: {},
    });
  });
});
