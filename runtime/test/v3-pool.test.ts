import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { V3PoolInspector } from '../src/liquidity/evm/v3-pool.js';
import {
  LP_PROTOCOLS,
  V3_INSPECT_PROTOCOLS,
  V3_INSPECT_UNIMPLEMENTED,
} from '../src/liquidity/protocols.js';
import type { V3ProtocolInfo } from '../src/liquidity/protocols.js';
import {
  getAmount0ForLiquidity,
  getAmount1ForLiquidity,
  getSqrtRatioAtTick,
} from '../src/liquidity/evm/tick-math.js';
import { AppError, ErrorCode } from '../src/util/errors.js';

/**
 * The read-only Uniswap-v3 adapter, against a JSON-RPC node under test control.
 *
 * viem's client cannot be swapped out from the outside, so — as in
 * `chain-adapters.test.ts` — the node is the thing that is faked: a real HTTP
 * server answering `eth_call` from a table keyed by contract address and
 * selector. Every reply is assembled word by word here rather than by the same
 * ABI the adapter decodes with, so an offset the adapter reads wrongly shows up
 * as a wrong value instead of cancelling out.
 *
 * Two things are on trial. What the adapter reads has to be right, down to the
 * side of the range a position sits on; and what it refuses has to be a named,
 * thrown refusal that no caller could mistake for a build that quietly did
 * nothing.
 */

const UNISWAP = V3_INSPECT_PROTOCOLS.base!;
const PANCAKE = V3_INSPECT_PROTOCOLS.bsc!;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Base: WETH is token0, USDC token1 (0x42… sorts below 0x83…). */
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_POOL_ID = '0xd0b53d9277642d899df5c87a3966a349a798f224';

/** BNB Chain: USDT is token0, WBNB token1. */
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const BSC_POOL_ID = '0x36696169c63e42cd08ce11f5deebbcebae652050';

/** Mixed case on the wire, so the adapter's lowercasing is actually exercised. */
const POSITION_OWNER = '0xabcdef0123456789abcdef0123456789abcdef01';

/**
 * `slot0` of Uniswap v3 WETH/USDC 0.05% on Base at block 51569133, and of
 * PancakeSwap v3 USDT/WBNB 0.05% on BNB Chain at block 123034328 — the same
 * live readings `tick-math.test.ts` pins its conversions to.
 */
const BASE_SQRT = 4057719202767049541567034n;
const BASE_TICK = -197600;
const BASE_PRICE = '2623.039393432768894858';
const BSC_SQRT = 2865720859012294761465802390n;
const BSC_TICK = -66394;
const BSC_PRICE = '0.001308303798149651';

// --- a node under test control -----------------------------------------------

/** Sentinel result: this call reverts. Never confusable with hex data. */
const REVERT = 'revert';

interface NodeState {
  /** `address:selector` → the `eth_call` result, or {@link REVERT}. */
  table: Map<string, string>;
  down: boolean;
}

const node: NodeState = { table: new Map(), down: false };

/** The 4-byte selectors the adapter's ABIs produce, fixed by the signatures. */
const SELECTORS = {
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  fee: '0xddca3f43',
  tickSpacing: '0xd0c93a7c',
  liquidity: '0x1a686502',
  slot0: '0x3850c7bd',
  getPool: '0x1698ee82',
  positions: '0x99fbab88',
  ownerOf: '0x6352211e',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
} as const;

type Selector = keyof typeof SELECTORS;

function answer(address: string, selector: Selector, result: string): void {
  node.table.set(`${address.toLowerCase()}:${SELECTORS[selector]}`, result);
}

/**
 * One 32-byte ABI word. Negative values are two's complement, which is how the
 * ABI sign-extends an `intN`, so a tick below zero is encoded exactly as a pool
 * would encode it.
 */
function word(value: bigint | number | boolean | string): string {
  const asBigint =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number'
        ? BigInt(value)
        : typeof value === 'boolean'
          ? value
            ? 1n
            : 0n
          : BigInt(value);
  const twos = asBigint < 0n ? asBigint + (1n << 256n) : asBigint;
  return twos.toString(16).padStart(64, '0');
}

/** A reply of static words, in the order the ABI declares them. */
function words(...values: Array<bigint | number | boolean | string>): string {
  return `0x${values.map(word).join('')}`;
}

function stringReply(value: string): string {
  return encodeAbiParameters(parseAbiParameters('string'), [value]);
}

interface TokenFixture {
  address: string;
  decimals: number;
  symbol: string;
}

interface PoolFixture {
  address: string;
  token0: TokenFixture;
  token1: TokenFixture;
  feePips: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** uint8 on Uniswap, uint32 on PancakeSwap; the word is the same width. */
  feeProtocol: number;
}

const BASE_POOL: PoolFixture = {
  address: BASE_POOL_ID,
  token0: { address: WETH, decimals: 18, symbol: 'WETH' },
  token1: { address: USDC, decimals: 6, symbol: 'USDC' },
  feePips: 500,
  tickSpacing: 10,
  sqrtPriceX96: BASE_SQRT,
  tick: BASE_TICK,
  liquidity: 3_141_592_653_589_793_238n,
  feeProtocol: 0,
};

const BSC_POOL: PoolFixture = {
  address: BSC_POOL_ID,
  token0: { address: USDT, decimals: 18, symbol: 'USDT' },
  token1: { address: WBNB, decimals: 18, symbol: 'WBNB' },
  feePips: 500,
  tickSpacing: 10,
  sqrtPriceX96: BSC_SQRT,
  tick: BSC_TICK,
  liquidity: 271_828_182_845_904_523n,
  // Two 16-bit halves, as the live BNB Chain pools report: past a uint8.
  feeProtocol: 0x0032_0032,
};

function installToken(token: TokenFixture): void {
  answer(token.address, 'decimals', words(token.decimals));
  answer(token.address, 'symbol', stringReply(token.symbol));
}

function installPool(info: V3ProtocolInfo, pool: PoolFixture): void {
  answer(pool.address, 'token0', words(pool.token0.address));
  answer(pool.address, 'token1', words(pool.token1.address));
  answer(pool.address, 'fee', words(pool.feePips));
  answer(pool.address, 'tickSpacing', words(pool.tickSpacing));
  answer(pool.address, 'liquidity', words(pool.liquidity));
  answer(
    pool.address,
    'slot0',
    words(pool.sqrtPriceX96, pool.tick, 0, 1, 1, pool.feeProtocol, true),
  );
  answer(info.factory, 'getPool', words(pool.address));
  installToken(pool.token0);
  installToken(pool.token1);
}

interface PositionFixture {
  tokenId: bigint;
  owner: string;
  token0: string;
  token1: string;
  feePips: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

function installPosition(info: V3ProtocolInfo, position: PositionFixture): void {
  // The twelve words of `positions(uint256)`, in the contract's order: an
  // adapter reading the wrong slot picks up a fee-growth accumulator here.
  answer(
    info.positionManager,
    'positions',
    words(
      7n,
      ZERO_ADDRESS,
      position.token0,
      position.token1,
      position.feePips,
      position.tickLower,
      position.tickUpper,
      position.liquidity,
      123_456_789n,
      987_654_321n,
      position.tokensOwed0,
      position.tokensOwed1,
    ),
  );
  answer(info.positionManager, 'ownerOf', words(position.owner));
}

function basePosition(overrides: Partial<PositionFixture> = {}): PositionFixture {
  return {
    tokenId: 42n,
    owner: POSITION_OWNER,
    token0: WETH,
    token1: USDC,
    feePips: 500,
    tickLower: -197700,
    tickUpper: -197500,
    liquidity: 1_078_571_510_367_106_173n,
    tokensOwed0: 12_345n,
    tokensOwed1: 678_900n,
    ...overrides,
  };
}

let url = '';

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  request.on('end', () => {
    if (node.down) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('upstream is down');
      return;
    }
    const call = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...replyTo(call) }));
  });
});

function replyTo(call: { method: string; params?: unknown[] }): Record<string, unknown> {
  if (call.method !== 'eth_call') return { result: null };
  const target = (call.params ?? [])[0] as { to: string; data: string };
  const result = node.table.get(`${target.to.toLowerCase()}:${target.data.slice(0, 10)}`);
  // An address with nothing at that selector answers with zero data, which is
  // what a node returns for a call to a contract that does not implement it.
  if (result === undefined) return { result: '0x' };
  if (result === REVERT) return { error: { code: 3, message: 'execution reverted' } };
  return { result };
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  node.table.clear();
  node.down = false;
  installPool(UNISWAP, BASE_POOL);
});

function uniswap(): V3PoolInspector {
  return new V3PoolInspector({ chain: 'base', info: UNISWAP, rpcUrl: url, timeoutMs: 2_000 });
}

function pancake(): V3PoolInspector {
  return new V3PoolInspector({ chain: 'bsc', info: PANCAKE, rpcUrl: url, timeoutMs: 2_000 });
}

/** Assert a rejection is ATRA's typed error, not a raw TypeError from a cast. */
async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );

  expect(caught).toBeInstanceOf(AppError);
  expect(caught).not.toBeInstanceOf(TypeError);
  return caught as AppError;
}

const DID_NOT_RETURN = Symbol('did not return');

/** A refusal must throw. A refusal that returns anything is a silent no-op. */
function expectRefusal(call: () => unknown): AppError {
  let returned: unknown = DID_NOT_RETURN;
  let caught: unknown = null;
  try {
    returned = call();
  } catch (error) {
    caught = error;
  }

  expect(returned).toBe(DID_NOT_RETURN);
  expect(caught).toBeInstanceOf(AppError);
  return caught as AppError;
}

// --- pool reads --------------------------------------------------------------

describe('V3PoolInspector.readPool', () => {
  it('decodes the pool the chain reports, field for field', async () => {
    const pool = await uniswap().readPool(BASE_POOL_ID);

    expect(pool.chain).toBe('base');
    expect(pool.protocol).toBe('uniswap-v3');
    expect(pool.kind).toBe('v3');
    expect(pool.poolId).toBe(BASE_POOL_ID);
    expect(pool.token0).toEqual({ address: WETH, decimals: 18, symbol: 'WETH' });
    expect(pool.token1).toEqual({ address: USDC, decimals: 6, symbol: 'USDC' });
    expect(pool.feePips).toBe(500);
    expect(pool.feeBps).toBe(5);
    expect(pool.tickSpacing).toBe(10);
    expect(pool.sqrtPriceX96).toBe(BASE_SQRT.toString());
    expect(pool.tick).toBe(BASE_TICK);
    expect(pool.liquidity).toBe('3141592653589793238');
    // One whole WETH in whole USDC at that block, floored to 18 digits.
    expect(pool.price).toBe(BASE_PRICE);
    expect(pool.inspectOnly).toBe(true);
    expect(pool.source).toBe('uniswap-v3-rpc');
    expect(pool.observedAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it('reads a PancakeSwap pool whose feeProtocol overflows a uint8', async () => {
    node.table.clear();
    installPool(PANCAKE, BSC_POOL);

    const pool = await pancake().readPool(BSC_POOL_ID);

    // The wider slot0 must not shift the two fields that matter.
    expect(pool.sqrtPriceX96).toBe(BSC_SQRT.toString());
    expect(pool.tick).toBe(BSC_TICK);
    expect(pool.protocol).toBe('pancakeswap-v3-lp');
    expect(pool.token0.symbol).toBe('USDT');
    expect(pool.price).toBe(BSC_PRICE);
  });

  it('keeps reading a token that has no symbol', async () => {
    answer(USDC, 'symbol', REVERT);

    const pool = await uniswap().readPool(BASE_POOL_ID);

    // A missing symbol is cosmetic; a missing decimals would not be.
    expect(pool.token1.symbol).toBeNull();
    expect(pool.token1.decimals).toBe(6);
  });

  it('refuses a pool the factory disowns', async () => {
    answer(UNISWAP.factory, 'getPool', words('0x1111111111111111111111111111111111111111'));

    const error = await expectAppError(uniswap().readPool(BASE_POOL_ID));

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(error.message).toContain('according to the factory');
    expect(error.details?.['factoryReports']).toBeDefined();
  });

  it('refuses a pool the factory has never heard of', async () => {
    answer(UNISWAP.factory, 'getPool', words(ZERO_ADDRESS));

    expect((await expectAppError(uniswap().readPool(BASE_POOL_ID))).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses a malformed pool id before it reaches the node', async () => {
    node.down = true;

    for (const poolId of ['', 'not-an-address', '0xdeadbeef', ZERO_ADDRESS]) {
      const error = await expectAppError(uniswap().readPool(poolId));
      expect(error.code).toBe(ErrorCode.SCHEMA_INVALID);
      expect(error.message).toBe('Malformed pool address');
    }
  });
});

describe('V3PoolInspector reply validation', () => {
  interface BadReply {
    name: string;
    install: () => void;
    code: ErrorCode;
    message: RegExp;
  }

  const BAD_REPLIES: readonly BadReply[] = [
    {
      name: 'an empty slot0',
      install: () => answer(BASE_POOL_ID, 'slot0', '0x'),
      code: ErrorCode.UPSTREAM_UNAVAILABLE,
      message: /slot0 failed/,
    },
    {
      name: 'a slot0 truncated to six words',
      install: () => answer(BASE_POOL_ID, 'slot0', words(BASE_SQRT, BASE_TICK, 0, 1, 1, 0)),
      code: ErrorCode.UPSTREAM_UNAVAILABLE,
      message: /slot0 failed/,
    },
    {
      name: 'half a word of liquidity',
      install: () => answer(BASE_POOL_ID, 'liquidity', `0x${'ff'.repeat(16)}`),
      code: ErrorCode.UPSTREAM_UNAVAILABLE,
      message: /liquidity failed/,
    },
    {
      name: 'no code at the pool address',
      install: () => node.table.delete(`${BASE_POOL_ID}:${SELECTORS.token0}`),
      code: ErrorCode.UPSTREAM_UNAVAILABLE,
      message: /token0 failed/,
    },
    {
      name: 'a well-formed word of zeroes for token0',
      install: () => answer(BASE_POOL_ID, 'token0', words(ZERO_ADDRESS)),
      code: ErrorCode.SCHEMA_INVALID,
      message: /returned no token0/,
    },
    {
      name: 'a zero fee',
      install: () => answer(BASE_POOL_ID, 'fee', words(0)),
      code: ErrorCode.SCHEMA_INVALID,
      message: /impossible fee/,
    },
    {
      name: 'a fee of one hundred percent',
      install: () => answer(BASE_POOL_ID, 'fee', words(1_000_000)),
      code: ErrorCode.SCHEMA_INVALID,
      message: /impossible fee/,
    },
    {
      name: 'a zero tick spacing',
      install: () => answer(BASE_POOL_ID, 'tickSpacing', words(0)),
      code: ErrorCode.SCHEMA_INVALID,
      message: /impossible tick spacing/,
    },
    {
      name: 'a negative tick spacing',
      install: () => answer(BASE_POOL_ID, 'tickSpacing', words(-10)),
      code: ErrorCode.SCHEMA_INVALID,
      message: /impossible tick spacing/,
    },
    {
      name: 'a tick spacing wider than any v3 pool',
      install: () => answer(BASE_POOL_ID, 'tickSpacing', words(16_385)),
      code: ErrorCode.SCHEMA_INVALID,
      message: /impossible tick spacing/,
    },
    {
      name: 'a tick that fits an int24 but not the v3 range',
      install: () => answer(BASE_POOL_ID, 'slot0', words(BASE_SQRT, 8_000_000, 0, 1, 1, 0, true)),
      code: ErrorCode.SCHEMA_INVALID,
      message: /slot0\.tick outside the v3 tick range/,
    },
    {
      name: 'a price no pool could hold',
      install: () => answer(BASE_POOL_ID, 'slot0', words(0n, BASE_TICK, 0, 1, 1, 0, true)),
      code: ErrorCode.SCHEMA_INVALID,
      message: /sqrtPriceX96 is outside the v3 price range/,
    },
    {
      name: 'a token claiming more decimals than any token has',
      install: () => answer(USDC, 'decimals', words(77)),
      code: ErrorCode.SCHEMA_INVALID,
      message: /Unsupported token decimals/,
    },
  ];

  for (const bad of BAD_REPLIES) {
    it(`turns ${bad.name} into a typed error`, async () => {
      bad.install();

      const error = await expectAppError(uniswap().readPool(BASE_POOL_ID));

      expect(error.code).toBe(bad.code);
      expect(error.message).toMatch(bad.message);
    });
  }

  it('surfaces an unreachable node as the adapter’s own upstream error', async () => {
    node.down = true;

    const error = await expectAppError(uniswap().readPool(BASE_POOL_ID));

    expect(error.code).toBe(ErrorCode.UPSTREAM_UNAVAILABLE);
    expect(error.message).toMatch(/^uniswap-v3 .+ failed$/);
    expect(error.details?.['chain']).toBe('base');
  });

  it('names the call that reverted rather than the whole read', async () => {
    answer(BASE_POOL_ID, 'liquidity', REVERT);

    const error = await expectAppError(uniswap().readPool(BASE_POOL_ID));

    expect(error.code).toBe(ErrorCode.UPSTREAM_UNAVAILABLE);
    expect(error.message).toBe('uniswap-v3 liquidity failed');
    expect(error.details?.['operation']).toBe('liquidity');
  });
});

// --- position reads ----------------------------------------------------------

describe('V3PoolInspector.readPosition', () => {
  it('decodes a position and values it against its own pool', async () => {
    const fixture = basePosition();
    installPosition(UNISWAP, fixture);

    const position = await uniswap().readPosition(fixture.tokenId);

    expect(position.tokenId).toBe('42');
    expect(position.owner).toBe(POSITION_OWNER);
    expect(position.poolId).toBe(BASE_POOL_ID);
    expect(position.token0).toEqual({ address: WETH, decimals: 18, symbol: 'WETH' });
    expect(position.token1).toEqual({ address: USDC, decimals: 6, symbol: 'USDC' });
    expect(position.feePips).toBe(500);
    expect(position.feeBps).toBe(5);
    expect(position.tickLower).toBe(-197700);
    expect(position.tickUpper).toBe(-197500);
    expect(position.liquidity).toBe('1078571510367106173');
    expect(position.poolTick).toBe(BASE_TICK);
    expect(position.poolSqrtPriceX96).toBe(BASE_SQRT.toString());
    expect(position.price).toBe(BASE_PRICE);
    expect(position.inspectOnly).toBe(true);
    expect(position.source).toBe('uniswap-v3-rpc');

    // The pool's tick sits inside [lower, upper), so the position is earning
    // and holds both legs: token0 from the price up to its top, token1 from
    // its bottom up to the price. Spelled out rather than taken from the
    // adapter's own helper, so a swapped bound would not cancel out.
    expect(position.inRange).toBe(true);
    expect(position.amount0).toBe(
      getAmount0ForLiquidity(BASE_SQRT, getSqrtRatioAtTick(-197500), fixture.liquidity).toString(),
    );
    expect(position.amount1).toBe(
      getAmount1ForLiquidity(getSqrtRatioAtTick(-197700), BASE_SQRT, fixture.liquidity).toString(),
    );
    expect(BigInt(position.amount0)).toBeGreaterThan(0n);
    expect(BigInt(position.amount1)).toBeGreaterThan(0n);

    // Fees already credited are a separate balance, not part of the legs.
    expect(position.tokensOwed0).toBe('12345');
    expect(position.tokensOwed1).toBe('678900');
  });

  it('holds only token0 when the price is below the range', async () => {
    const fixture = basePosition({ tickLower: -197000, tickUpper: -196000 });
    installPosition(UNISWAP, fixture);

    const position = await uniswap().readPosition(fixture.tokenId);

    expect(position.inRange).toBe(false);
    expect(position.amount1).toBe('0');
    expect(position.amount0).toBe(
      getAmount0ForLiquidity(
        getSqrtRatioAtTick(-197000),
        getSqrtRatioAtTick(-196000),
        fixture.liquidity,
      ).toString(),
    );
    expect(BigInt(position.amount0)).toBeGreaterThan(0n);
    // Out of range still owes whatever it earned on the way there.
    expect(position.tokensOwed1).toBe('678900');
  });

  it('holds only token1 when the price is above the range', async () => {
    const fixture = basePosition({ tickLower: -198500, tickUpper: -198200 });
    installPosition(UNISWAP, fixture);

    const position = await uniswap().readPosition(fixture.tokenId);

    expect(position.inRange).toBe(false);
    expect(position.amount0).toBe('0');
    expect(position.amount1).toBe(
      getAmount1ForLiquidity(
        getSqrtRatioAtTick(-198500),
        getSqrtRatioAtTick(-198200),
        fixture.liquidity,
      ).toString(),
    );
    expect(BigInt(position.amount1)).toBeGreaterThan(0n);
  });

  it('values the position at the pool the factory names', async () => {
    // Nothing outside the factory chooses the pool: `readPosition` takes only a
    // token id, so a second pool for the same pair and fee tier is where the
    // price has to come from, whatever the first one said.
    const elsewhere: PoolFixture = {
      ...BASE_POOL,
      address: '0xfeed000000000000000000000000000000000abc',
      sqrtPriceX96: getSqrtRatioAtTick(-190000),
      tick: -190000,
    };
    installPool(UNISWAP, elsewhere);
    installPosition(UNISWAP, basePosition());

    const position = await uniswap().readPosition(42n);

    expect(position.poolId).toBe(elsewhere.address);
    expect(position.poolTick).toBe(-190000);
    expect(position.poolSqrtPriceX96).toBe(elsewhere.sqrtPriceX96.toString());
    // That pool's price sits above the position's range, so it is all token1.
    expect(position.inRange).toBe(false);
    expect(position.amount0).toBe('0');
  });

  it('treats the upper bound as out of range, as the pool does', async () => {
    // A position whose top is exactly the pool's tick earns nothing there.
    const fixture = basePosition({ tickLower: -197700, tickUpper: BASE_TICK });
    installPosition(UNISWAP, fixture);

    const position = await uniswap().readPosition(fixture.tokenId);

    expect(position.inRange).toBe(false);
    expect(position.amount0).toBe('0');
  });

  it('reports an empty position as empty rather than failing', async () => {
    const fixture = basePosition({ liquidity: 0n, tokensOwed0: 0n, tokensOwed1: 0n });
    installPosition(UNISWAP, fixture);

    const position = await uniswap().readPosition(fixture.tokenId);

    expect(position.liquidity).toBe('0');
    expect(position.amount0).toBe('0');
    expect(position.amount1).toBe('0');
    expect(position.inRange).toBe(true);
  });

  it('refuses a negative token id before it reaches the node', async () => {
    node.down = true;

    const error = await expectAppError(uniswap().readPosition(-1n));

    expect(error.code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(error.message).toMatch(/negative/);
  });

  it('refuses a position whose tokens and fee tier have no pool', async () => {
    installPosition(UNISWAP, basePosition());
    answer(UNISWAP.factory, 'getPool', words(ZERO_ADDRESS));

    const error = await expectAppError(uniswap().readPosition(42n));

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(error.message).toMatch(/no pool for the position/);
  });

  it('refuses an inverted or empty range', async () => {
    for (const range of [
      { tickLower: -197500, tickUpper: -197700 },
      { tickLower: -197600, tickUpper: -197600 },
    ]) {
      installPosition(UNISWAP, basePosition(range));

      const error = await expectAppError(uniswap().readPosition(42n));

      expect(error.code).toBe(ErrorCode.SCHEMA_INVALID);
      expect(error.message).toMatch(/empty or inverted/);
    }
  });

  it('refuses a range bound outside the v3 tick range', async () => {
    // -8,000,000 is a legal int24, so only the adapter's own check catches it.
    installPosition(UNISWAP, basePosition({ tickLower: -8_000_000 }));

    const error = await expectAppError(uniswap().readPosition(42n));

    expect(error.code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(error.message).toMatch(/position\.tickLower outside the v3 tick range/);
  });

  it('refuses a position with no token0', async () => {
    installPosition(UNISWAP, basePosition({ token0: ZERO_ADDRESS }));

    const error = await expectAppError(uniswap().readPosition(42n));

    expect(error.code).toBe(ErrorCode.SCHEMA_INVALID);
    expect(error.message).toMatch(/no position\.token0/);
  });

  it('turns a truncated positions reply into a typed error', async () => {
    const fixture = basePosition();
    installPosition(UNISWAP, fixture);
    // The eight words up to `liquidity`, without the fee growth or the owed
    // fees: a decoder that believed it would read tokensOwed off the end.
    answer(
      UNISWAP.positionManager,
      'positions',
      words(
        7n,
        ZERO_ADDRESS,
        fixture.token0,
        fixture.token1,
        fixture.feePips,
        fixture.tickLower,
        fixture.tickUpper,
        fixture.liquidity,
      ),
    );

    const error = await expectAppError(uniswap().readPosition(42n));

    expect(error.code).toBe(ErrorCode.UPSTREAM_UNAVAILABLE);
    expect(error.message).toBe('uniswap-v3 positions failed');
  });

  it('surfaces an unreachable node as the adapter’s own upstream error', async () => {
    node.down = true;

    const error = await expectAppError(uniswap().readPosition(42n));

    expect(error.code).toBe(ErrorCode.UPSTREAM_UNAVAILABLE);
    expect(error.message).toMatch(/^uniswap-v3 .+ failed$/);
  });
});

// --- refusals ----------------------------------------------------------------

describe('V3PoolInspector refuses the whole money path', () => {
  /** Every non-read method on the class, and the call that reaches it. */
  const ENTRY_POINTS: ReadonlyArray<{
    method: string;
    operation: string;
    call: (inspector: V3PoolInspector) => unknown;
  }> = [
    { method: 'buildMint', operation: 'mint a new position', call: (i) => i.buildMint({}) },
    {
      method: 'buildIncreaseLiquidity',
      operation: 'increase a position',
      call: (i) => i.buildIncreaseLiquidity({}),
    },
    {
      method: 'buildDecreaseLiquidity',
      operation: 'decrease a position',
      call: (i) => i.buildDecreaseLiquidity({}),
    },
    {
      method: 'buildCollect',
      operation: 'collect fees from a position',
      call: (i) => i.buildCollect({}),
    },
    { method: 'buildBurn', operation: 'burn a position', call: (i) => i.buildBurn({}) },
    {
      method: 'buildApprove',
      operation: 'approve a token to the position manager',
      call: (i) => i.buildApprove(USDC, POSITION_OWNER, 1n),
    },
    {
      method: 'prepareSigning',
      operation: 'prepare a transaction for signing',
      call: (i) => i.prepareSigning({}, POSITION_OWNER),
    },
    { method: 'broadcast', operation: 'broadcast a transaction', call: (i) => i.broadcast('0x') },
  ];

  for (const entry of ENTRY_POINTS) {
    it(`refuses to ${entry.operation}`, () => {
      const error = expectRefusal(() => entry.call(uniswap()));

      expect(error.code).toBe(ErrorCode.ADAPTER_UNAVAILABLE);
      expect(error.message).toContain(`refusing to ${entry.operation}`);
      expect(error.message).toContain('uniswap-v3 on base');
      // The reason has to name v3 management, not just say "unavailable".
      expect(error.message).toContain(V3_INSPECT_UNIMPLEMENTED);
      expect(error.message).toMatch(/not implemented in this build/);
      expect(error.details?.['inspectOnly']).toBe(true);
      expect(error.details?.['operation']).toBe(entry.operation);
    });
  }

  it('has no entry point this file has not enumerated', () => {
    // A later agent adding a build path without a refusal test fails here.
    const methods = Object.getOwnPropertyNames(V3PoolInspector.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(methods).toEqual(
      ['readPool', 'readPosition', ...ENTRY_POINTS.map((entry) => entry.method)].sort(),
    );
  });

  it('claims no address it could send a transaction to', () => {
    const inspector = uniswap();

    expect(inspector.contracts).toEqual([]);
    expect(inspector.inspectOnly).toBe(true);
    expect(inspector.kind).toBe('v3');
  });

  it('refuses without touching the node', () => {
    node.down = true;

    expect(expectRefusal(() => uniswap().buildMint({})).code).toBe(ErrorCode.ADAPTER_UNAVAILABLE);
  });
});

// --- construction ------------------------------------------------------------

describe('V3PoolInspector construction', () => {
  function build(chain: 'base' | 'bsc' | 'solana', info: V3ProtocolInfo): () => V3PoolInspector {
    return () => new V3PoolInspector({ chain, info, rpcUrl: url, timeoutMs: 2_000 });
  }

  it('refuses a chain that is not EVM', () => {
    expect(expectRefusal(build('solana', UNISWAP)).code).toBe(ErrorCode.CHAIN_UNSUPPORTED);
  });

  it('refuses a malformed contract address', () => {
    for (const broken of [
      { ...UNISWAP, factory: '0xdeadbeef' },
      { ...UNISWAP, positionManager: 'not-an-address' },
      { ...UNISWAP, quoter: '' },
    ]) {
      expect(expectRefusal(build('base', broken)).code).toBe(ErrorCode.SCHEMA_INVALID);
    }
  });

  it('refuses a deployment that is not marked inspect-only', () => {
    const executable = { ...UNISWAP, inspectOnly: false } as unknown as V3ProtocolInfo;

    expect(expectRefusal(build('base', executable)).code).toBe(ErrorCode.ADAPTER_UNAVAILABLE);
  });

  it('refuses to inspect through a contract execution already trusts', () => {
    // The mirror of `assertRegisteredRouter`: an address the executor can send
    // to must never be reachable as an inspect-only contract.
    const router = { ...UNISWAP, factory: LP_PROTOCOLS.base!.router };

    expect(build('base', router)).toThrow(/refusing to treat/);
  });
});
