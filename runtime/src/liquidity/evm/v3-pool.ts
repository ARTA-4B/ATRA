import { createPublicClient, defineChain, http, isAddress, parseAbi } from 'viem';
import type { PublicClient } from 'viem';
import { CHAINS } from '../../chains/registry.js';
import type { ChainId } from '../../chains/registry.js';
import { AppError, ErrorCode, errorMessage } from '../../util/errors.js';
import { childLogger } from '../../logging/logger.js';
import { assertInspectOnly, V3_INSPECT_UNIMPLEMENTED } from '../protocols.js';
import type { V3Dialect, V3ProtocolInfo } from '../protocols.js';
import type { LpTokenInfo } from '../types.js';
import {
  getAmountsForLiquidity,
  isTickInRange,
  MAX_TICK,
  MIN_TICK,
  priceFromSqrtPriceX96,
} from './tick-math.js';

/**
 * Uniswap-v3-style concentrated liquidity: Uniswap v3 on Base and PancakeSwap
 * v3 on BNB Smart Chain. Reads only.
 *
 * The v2 adapter next door is the sibling this one is shaped after — the same
 * client, the same `#call` wrapper, the same rule that the protocol's factory
 * must own up to a pool before anything is read out of it. What it does not
 * have is the other half: no quotes, no builds, no approvals, no signing.
 *
 * That is deliberate. A v2 LP position is a fungible ERC-20 balance; a v3
 * position is an ERC-721 holding a tick range, and its value moves from all
 * token0 to all token1 as the price crosses it. The ledger, the risk checks,
 * the executor and the reconciler are all written against the fungible
 * assumption, so a v3 money path built on top of them would book positions it
 * cannot value and reconcile balances that do not exist. Half a money path is
 * worse than none, so every build, approve and sign entry point here throws
 * and says why.
 *
 * What it buys today: the interface can state what a pool actually is on chain
 * — its fee tier, its tick spacing, its price, and whether a position is
 * earning — instead of repeating whatever a data provider labelled it, and the
 * tick arithmetic a later management path needs is written and tested.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Uniswap's widest tick spacing; anything above it is not a v3 pool reply. */
const MAX_TICK_SPACING = 16_384;
/** A fee is hundredths of a basis point, so 100% is a million of them. */
const MAX_FEE_PIPS = 1_000_000;

const V3_POOL_ABI = parseAbi([
  'function liquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

/**
 * `slot0` differs between the two dialects: Uniswap packs `feeProtocol` into a
 * uint8, PancakeSwap widened it to a uint32 holding two 16-bit halves — the
 * live BNB Chain pools return values well past 255 there. The decoder does not
 * range-check, so the wrong width would be believed rather than caught, and
 * each ABI is declared as the contract actually returns it.
 */
const UNISWAP_SLOT0_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

const PANCAKE_SLOT0_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
]);

const V3_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);

const POSITION_MANAGER_ABI = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** A v3 pool as the chain reports it. Never a transaction input. */
export interface V3PoolReading {
  chain: ChainId;
  protocol: string;
  kind: 'v3';
  poolId: string;
  token0: LpTokenInfo;
  token1: LpTokenInfo;
  /** The raw uint24 fee, in hundredths of a basis point (500 = 0.05%). */
  feePips: number;
  feeBps: number;
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  /** In-range liquidity at the current tick, not the pool's whole depth. */
  liquidity: string;
  /** One whole token0 priced in whole token1, 18 fractional digits. */
  price: string;
  inspectOnly: true;
  observedAt: number;
  source: string;
}

/** One position NFT as the position manager and its pool report it. */
export interface V3PositionReading {
  chain: ChainId;
  protocol: string;
  tokenId: string;
  owner: string;
  poolId: string;
  token0: LpTokenInfo;
  token1: LpTokenInfo;
  feePips: number;
  feeBps: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  /** What the liquidity is made of at the pool's current price, floored. */
  amount0: string;
  amount1: string;
  /** Fees the position manager already credited, owed on top of the amounts. */
  tokensOwed0: string;
  tokensOwed1: string;
  inRange: boolean;
  poolTick: number;
  poolSqrtPriceX96: string;
  price: string;
  inspectOnly: true;
  observedAt: number;
  source: string;
}

export interface V3PoolInspectorOptions {
  chain: ChainId;
  info: V3ProtocolInfo;
  rpcUrl?: string | undefined;
  timeoutMs?: number;
}

export class V3PoolInspector {
  readonly chain: ChainId;
  readonly protocol: string;
  readonly kind = 'v3' as const;
  readonly inspectOnly = true as const;
  /**
   * Empty, and that is the claim: there is no address this object can send a
   * transaction to, because it has no code that sends one.
   */
  readonly contracts: readonly string[] = [];

  readonly #dialect: V3Dialect;
  readonly #factory: `0x${string}`;
  readonly #positionManager: `0x${string}`;
  readonly #client: PublicClient;
  readonly #log;

  constructor(options: V3PoolInspectorOptions) {
    const info = CHAINS[options.chain];
    if (info.family !== 'evm' || info.evmChainId === undefined) {
      throw new AppError(ErrorCode.CHAIN_UNSUPPORTED, `${options.chain} is not an EVM chain`);
    }
    if (
      !isAddress(options.info.factory) ||
      !isAddress(options.info.positionManager) ||
      !isAddress(options.info.quoter)
    ) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed v3 contract address');
    }
    if (options.info.inspectOnly !== true) {
      throw new AppError(
        ErrorCode.ADAPTER_UNAVAILABLE,
        `${options.info.protocol} is not marked inspect-only`,
      );
    }
    // None of these addresses may be a contract the execution registry
    // trusts: an inspect-only deployment that is also executable is one
    // policy edit away from being sent a transaction.
    assertInspectOnly(options.chain, options.info);

    this.chain = options.chain;
    this.protocol = options.info.protocol;
    this.#dialect = options.info.dialect;
    this.#factory = options.info.factory.toLowerCase() as `0x${string}`;
    this.#positionManager = options.info.positionManager.toLowerCase() as `0x${string}`;
    this.#log = childLogger('lp-v3', { chain: options.chain, protocol: options.info.protocol });

    const endpoint = options.rpcUrl ?? info.publicRpcUrls[0]!;
    this.#client = createPublicClient({
      chain: defineChain({
        id: info.evmChainId,
        name: info.displayName,
        nativeCurrency: {
          name: info.nativeSymbol,
          symbol: info.nativeSymbol,
          decimals: info.nativeDecimals,
        },
        rpcUrls: { default: { http: [endpoint] } },
      }),
      transport: http(endpoint, {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retryCount: 1,
      }),
    });
  }

  // --- reads -----------------------------------------------------------------

  async readPool(poolId: string): Promise<V3PoolReading> {
    const pool = this.#poolAddress(poolId);

    const [token0, token1, feePips] = await Promise.all([
      this.#call('token0', () =>
        this.#client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'token0' }),
      ),
      this.#call('token1', () =>
        this.#client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'token1' }),
      ),
      this.#call('fee', () =>
        this.#client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'fee' }),
      ),
    ]);
    this.#assertToken(token0, 'token0');
    this.#assertToken(token1, 'token1');
    this.#assertFee(feePips);

    // The factory must own up to the pool, exactly as on v2: an operator can
    // allowlist any address, but a pool the factory disowns is not a pool of
    // this protocol whatever the policy says.
    const canonical = await this.#call('factory.getPool', () =>
      this.#client.readContract({
        address: this.#factory,
        abi: V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [token0, token1, feePips],
      }),
    );
    if (canonical.toLowerCase() !== pool) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `${poolId} is not a ${this.protocol} pool according to the factory`,
        { details: { chain: this.chain, poolId, feePips, factoryReports: canonical } },
      );
    }

    const [slot0, liquidity, tickSpacing, dec0, dec1, sym0, sym1] = await Promise.all([
      this.#slot0(pool),
      this.#call('liquidity', () =>
        this.#client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'liquidity' }),
      ),
      this.#call('tickSpacing', () =>
        this.#client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'tickSpacing' }),
      ),
      this.#decimals(token0),
      this.#decimals(token1),
      this.#symbol(token0),
      this.#symbol(token1),
    ]);
    this.#assertTickSpacing(tickSpacing);
    this.#assertTick(slot0.tick, 'slot0.tick');

    return {
      chain: this.chain,
      protocol: this.protocol,
      kind: 'v3',
      poolId: pool,
      token0: { address: token0.toLowerCase(), decimals: dec0, symbol: sym0 },
      token1: { address: token1.toLowerCase(), decimals: dec1, symbol: sym1 },
      feePips,
      feeBps: feePips / 100,
      tickSpacing,
      sqrtPriceX96: slot0.sqrtPriceX96.toString(),
      tick: slot0.tick,
      liquidity: liquidity.toString(),
      price: priceFromSqrtPriceX96(slot0.sqrtPriceX96, dec0, dec1),
      inspectOnly: true,
      observedAt: Date.now(),
      source: `${this.protocol}-rpc`,
    };
  }

  /**
   * One position NFT, valued against its own pool.
   *
   * The pool is not taken from the caller: it is derived from the position's
   * own token0/token1/fee through the factory, so a position can never be
   * priced against a pool it is not in.
   */
  async readPosition(tokenId: bigint): Promise<V3PositionReading> {
    if (tokenId < 0n) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Position token id is negative');
    }

    const [position, owner] = await Promise.all([
      this.#call('positions', () =>
        this.#client.readContract({
          address: this.#positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'positions',
          args: [tokenId],
        }),
      ),
      this.#call('ownerOf', () =>
        this.#client.readContract({
          address: this.#positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'ownerOf',
          args: [tokenId],
        }),
      ),
    ]);

    const [, , token0, token1, feePips, tickLower, tickUpper, liquidity] = position;
    const tokensOwed0 = position[10];
    const tokensOwed1 = position[11];
    this.#assertToken(token0, 'position.token0');
    this.#assertToken(token1, 'position.token1');
    this.#assertFee(feePips);
    this.#assertTick(tickLower, 'position.tickLower');
    this.#assertTick(tickUpper, 'position.tickUpper');
    if (tickLower >= tickUpper) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Position range is empty or inverted', {
        details: { tokenId: tokenId.toString(), tickLower, tickUpper },
      });
    }

    const poolAddress = await this.#call('factory.getPool', () =>
      this.#client.readContract({
        address: this.#factory,
        abi: V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [token0, token1, feePips],
      }),
    );
    if (poolAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `${this.protocol} has no pool for the position's tokens and fee tier`,
        { details: { chain: this.chain, tokenId: tokenId.toString(), feePips } },
      );
    }
    const pool = await this.readPool(poolAddress);

    const amounts = getAmountsForLiquidity(
      BigInt(pool.sqrtPriceX96),
      tickLower,
      tickUpper,
      liquidity,
    );

    return {
      chain: this.chain,
      protocol: this.protocol,
      tokenId: tokenId.toString(),
      owner: owner.toLowerCase(),
      poolId: pool.poolId,
      token0: pool.token0,
      token1: pool.token1,
      feePips,
      feeBps: feePips / 100,
      tickLower,
      tickUpper,
      liquidity: liquidity.toString(),
      amount0: amounts.amount0.toString(),
      amount1: amounts.amount1.toString(),
      tokensOwed0: tokensOwed0.toString(),
      tokensOwed1: tokensOwed1.toString(),
      inRange: isTickInRange(pool.tick, tickLower, tickUpper),
      poolTick: pool.tick,
      poolSqrtPriceX96: pool.sqrtPriceX96,
      price: pool.price,
      inspectOnly: true,
      observedAt: Date.now(),
      source: `${this.protocol}-rpc`,
    };
  }

  // --- refusals ----------------------------------------------------------------

  /**
   * Every way in to the money path, and every one of them a loud stop.
   *
   * These exist rather than being left out so that a caller reaching for them
   * gets a named refusal with a reason, not a `TypeError: not a function` that
   * reads like a wiring bug, and not a build that silently returns nothing.
   */
  buildMint(_request: unknown): never {
    this.#refuse('mint a new position');
  }

  buildIncreaseLiquidity(_request: unknown): never {
    this.#refuse('increase a position');
  }

  buildDecreaseLiquidity(_request: unknown): never {
    this.#refuse('decrease a position');
  }

  buildCollect(_request: unknown): never {
    this.#refuse('collect fees from a position');
  }

  buildBurn(_request: unknown): never {
    this.#refuse('burn a position');
  }

  buildApprove(_token: unknown, _owner: unknown, _amount?: unknown): never {
    this.#refuse('approve a token to the position manager');
  }

  prepareSigning(_tx: unknown, _from: unknown): never {
    this.#refuse('prepare a transaction for signing');
  }

  broadcast(_signed: unknown): never {
    this.#refuse('broadcast a transaction');
  }

  // --- internals -------------------------------------------------------------

  #refuse(operation: string): never {
    throw new AppError(
      ErrorCode.ADAPTER_UNAVAILABLE,
      `${this.protocol} on ${this.chain}: refusing to ${operation}. ${V3_INSPECT_UNIMPLEMENTED}`,
      { details: { chain: this.chain, protocol: this.protocol, operation, inspectOnly: true } },
    );
  }

  async #slot0(pool: `0x${string}`): Promise<{ sqrtPriceX96: bigint; tick: number }> {
    const raw =
      this.#dialect === 'pancakeswap-v3'
        ? await this.#call('slot0', () =>
            this.#client.readContract({
              address: pool,
              abi: PANCAKE_SLOT0_ABI,
              functionName: 'slot0',
            }),
          )
        : await this.#call('slot0', () =>
            this.#client.readContract({
              address: pool,
              abi: UNISWAP_SLOT0_ABI,
              functionName: 'slot0',
            }),
          );
    return { sqrtPriceX96: raw[0], tick: raw[1] };
  }

  async #decimals(token: string): Promise<number> {
    return Number(
      await this.#call('decimals', () =>
        this.#client.readContract({
          address: token as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
      ),
    );
  }

  async #symbol(token: string): Promise<string | null> {
    try {
      return await this.#client.readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'symbol',
      });
    } catch {
      return null;
    }
  }

  #poolAddress(poolId: string): `0x${string}` {
    if (!isAddress(poolId) || poolId.toLowerCase() === ZERO_ADDRESS) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed pool address', {
        details: { poolId },
      });
    }
    return poolId.toLowerCase() as `0x${string}`;
  }

  #assertToken(address: string, field: string): void {
    // An empty reply throws in the decoder and is caught by `#call`, but a
    // node or proxy answering a well-formed word of zeroes decodes cleanly to
    // the zero address. That is the case this catches, before the address
    // reaches the factory lookup and quietly matches nothing.
    if (!isAddress(address) || address.toLowerCase() === ZERO_ADDRESS) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, `${this.protocol} returned no ${field}`, {
        details: { chain: this.chain, field, address },
      });
    }
  }

  #assertFee(feePips: number): void {
    if (!Number.isInteger(feePips) || feePips <= 0 || feePips >= MAX_FEE_PIPS) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, `${this.protocol} reported an impossible fee`, {
        details: { chain: this.chain, feePips },
      });
    }
  }

  #assertTickSpacing(tickSpacing: number): void {
    if (!Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > MAX_TICK_SPACING) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        `${this.protocol} reported an impossible tick spacing`,
        { details: { chain: this.chain, tickSpacing } },
      );
    }
  }

  #assertTick(tick: number, field: string): void {
    if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        `${this.protocol} reported ${field} outside the v3 tick range`,
        { details: { chain: this.chain, field, tick } },
      );
    }
  }

  async #call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      this.#log.warn({ operation, err: cause }, 'v3 read failed');
      throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, `${this.protocol} ${operation} failed`, {
        cause,
        details: { chain: this.chain, operation, reason: errorMessage(cause) },
      });
    }
  }
}
