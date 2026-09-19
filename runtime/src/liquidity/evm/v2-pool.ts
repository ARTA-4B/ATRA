import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddress,
  parseAbi,
  parseEventLogs,
} from 'viem';
import type { PublicClient } from 'viem';
import { CHAINS } from '../../chains/registry.js';
import type { ChainId } from '../../chains/registry.js';
import type { SignedTransaction, SigningContext } from '../../chains/types.js';
import type { UnsignedTransaction } from '../../execution/types.js';
import type { FeeDetail } from '../../risk/types.js';
import { amountToBigint, bpsOf, floorDiv } from '../../risk/money.js';
import { AppError, ErrorCode, errorMessage } from '../../util/errors.js';
import { childLogger } from '../../logging/logger.js';
import { assertRegisteredRouter } from '../protocols.js';
import type { LpDialect, LpProtocolInfo } from '../protocols.js';
import type {
  LpAdapter,
  LpAddQuote,
  LpAddQuoteRequest,
  LpClaimPlan,
  LpPoolState,
  LpPositionState,
  LpReceipt,
  LpRemoveQuote,
  LpRemoveQuoteRequest,
} from '../types.js';

/**
 * Uniswap-v2-style liquidity: Aerodrome v2 on Base and PancakeSwap v2 on BNB
 * Smart Chain.
 *
 * Five operations, all against contracts the registry names:
 *
 *  - read a pool (reserves, supply, tokens) and a wallet's position in it;
 *  - `addLiquidity` on the router, quoted from the reserves (PancakeSwap) or
 *    the router's own `quoteAddLiquidity` (Aerodrome);
 *  - `removeLiquidity` on the router;
 *  - `claimFees` on the pool (Aerodrome only; PancakeSwap fees compound into
 *    the reserves and there is nothing to claim);
 *  - an exact-amount ERC-20 approval to the router.
 *
 * A pool is accepted only if the protocol's factory says it created it
 * (`getPool` / `getPair` returns the same address). That is what keeps the
 * adapter a closed set: an operator could allowlist any address in the
 * policy, but the adapter will not read or touch one the factory disowns.
 *
 * The v2 mint formula the quotes use is the contract's own:
 * `liquidity = min(amount0 * totalSupply / reserve0, amount1 * totalSupply /
 * reserve1)` after the router adjusts the desired amounts to the pool ratio.
 * It was checked against Aerodrome's `quoteAddLiquidity` live (see
 * protocols.ts).
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const ADD_GAS_LIMIT = 260_000n;
const REMOVE_GAS_LIMIT = 220_000n;
const CLAIM_GAS_LIMIT = 150_000n;
const APPROVE_GAS_LIMIT = 60_000n;
const DEADLINE_SECONDS = 300;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const AERODROME_POOL_ABI = parseAbi([
  'function getReserves() view returns (uint256 _reserve0, uint256 _reserve1, uint256 _blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function stable() view returns (bool)',
  'function claimable0(address owner) view returns (uint256)',
  'function claimable1(address owner) view returns (uint256)',
  'function claimFees() returns (uint256 claimed0, uint256 claimed1)',
]);

const UNISWAP_V2_PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

const AERODROME_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
  'function getFee(address pool, bool stable) view returns (uint256)',
]);

const UNISWAP_V2_FACTORY_ABI = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address)',
]);

const AERODROME_ROUTER_ABI = parseAbi([
  'function quoteAddLiquidity(address tokenA, address tokenB, bool stable, address _factory, uint256 amountADesired, uint256 amountBDesired) view returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function quoteRemoveLiquidity(address tokenA, address tokenB, bool stable, address _factory, uint256 liquidity) view returns (uint256 amountA, uint256 amountB)',
  'function addLiquidity(address tokenA, address tokenB, bool stable, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, bool stable, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
]);

const UNISWAP_V2_ROUTER_ABI = parseAbi([
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
]);

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

interface EvmPayload {
  to: `0x${string}`;
  data: `0x${string}`;
  from: `0x${string}`;
  value: string;
  gasLimit: string;
}

interface V2LpRoute {
  token0: string;
  token1: string;
  stable: boolean;
  recipient: string;
  deadlineSeconds: number;
}

export interface V2PoolLpAdapterOptions {
  chain: ChainId;
  info: LpProtocolInfo;
  rpcUrl?: string | undefined;
  timeoutMs?: number;
}

export class V2PoolLpAdapter implements LpAdapter {
  readonly chain: ChainId;
  readonly protocol: string;
  readonly kind = 'v2' as const;
  readonly contracts: readonly string[];
  readonly claimsFees: boolean;

  readonly #dialect: LpDialect;
  readonly #router: `0x${string}`;
  readonly #factory: `0x${string}`;
  readonly #client: PublicClient;
  readonly #log;

  constructor(options: V2PoolLpAdapterOptions) {
    const info = CHAINS[options.chain];
    if (info.family !== 'evm' || info.evmChainId === undefined) {
      throw new AppError(ErrorCode.CHAIN_UNSUPPORTED, `${options.chain} is not an EVM chain`);
    }
    if (!isAddress(options.info.router) || !isAddress(options.info.factory)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed router or factory address');
    }
    // The LP router must be the swap router the execution registry already
    // trusts. An LP adapter pointed at another address would be a second,
    // unreviewed path to a contract.
    assertRegisteredRouter(options.chain, options.info);

    this.chain = options.chain;
    this.protocol = options.info.protocol;
    this.#dialect = options.info.dialect;
    this.#router = options.info.router.toLowerCase() as `0x${string}`;
    this.#factory = options.info.factory.toLowerCase() as `0x${string}`;
    // The pool itself is a target only for claimFees, and only on Aerodrome;
    // which pool is decided per action by the policy allowlist.
    this.contracts = [this.#router];
    this.claimsFees = this.#dialect === 'aerodrome';
    this.#log = childLogger('lp-v2', { chain: options.chain, protocol: options.info.protocol });

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

  async readPool(poolId: string): Promise<LpPoolState> {
    const pool = this.#poolAddress(poolId);
    const poolAbi = this.#dialect === 'aerodrome' ? AERODROME_POOL_ABI : UNISWAP_V2_PAIR_ABI;

    const [token0, token1] = await Promise.all([
      this.#call('token0', () =>
        this.#client.readContract({ address: pool, abi: poolAbi, functionName: 'token0' }),
      ),
      this.#call('token1', () =>
        this.#client.readContract({ address: pool, abi: poolAbi, functionName: 'token1' }),
      ),
    ]);
    const stable =
      this.#dialect === 'aerodrome'
        ? await this.#call('stable', () =>
            this.#client.readContract({
              address: pool,
              abi: AERODROME_POOL_ABI,
              functionName: 'stable',
            }),
          )
        : false;

    // The factory must own up to the pool. Anything else is not a pool of
    // this protocol, whatever the policy says.
    const canonical = await this.#factoryPool(token0, token1, stable);
    if (canonical.toLowerCase() !== pool) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `${poolId} is not a ${this.protocol} pool according to the factory`,
        { details: { chain: this.chain, poolId, factoryReports: canonical } },
      );
    }

    const [reserves, totalSupply, dec0, dec1, sym0, sym1, feeBps] = await Promise.all([
      this.#call('getReserves', () =>
        this.#client.readContract({ address: pool, abi: poolAbi, functionName: 'getReserves' }),
      ),
      this.#call('totalSupply', () =>
        this.#client.readContract({ address: pool, abi: poolAbi, functionName: 'totalSupply' }),
      ),
      this.#decimals(token0),
      this.#decimals(token1),
      this.#symbol(token0),
      this.#symbol(token1),
      this.#feeBps(pool, stable),
    ]);

    return {
      chain: this.chain,
      protocol: this.protocol,
      poolId: pool,
      kind: 'v2',
      stable,
      token0: { address: token0.toLowerCase(), decimals: dec0, symbol: sym0 },
      token1: { address: token1.toLowerCase(), decimals: dec1, symbol: sym1 },
      reserve0: reserves[0].toString(),
      reserve1: reserves[1].toString(),
      totalSupply: totalSupply.toString(),
      lpTokenDecimals: 18,
      feeBps,
      range: null,
      observedAt: Date.now(),
      source: `${this.protocol}-rpc`,
    };
  }

  async readPosition(owner: string, poolId: string): Promise<LpPositionState> {
    if (!isAddress(owner)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed owner address');
    }
    const pool = await this.readPool(poolId);
    const address = pool.poolId as `0x${string}`;
    const poolAbi = this.#dialect === 'aerodrome' ? AERODROME_POOL_ABI : UNISWAP_V2_PAIR_ABI;

    const lpTokens = await this.#call('balanceOf', () =>
      this.#client.readContract({
        address,
        abi: poolAbi,
        functionName: 'balanceOf',
        args: [owner],
      }),
    );

    let claimable0: string | null = null;
    let claimable1: string | null = null;
    let claimNote = 'fees compound into the reserves; there is nothing to claim separately';
    if (this.#dialect === 'aerodrome') {
      const [c0, c1] = await Promise.all([
        this.#call('claimable0', () =>
          this.#client.readContract({
            address,
            abi: AERODROME_POOL_ABI,
            functionName: 'claimable0',
            args: [owner],
          }),
        ),
        this.#call('claimable1', () =>
          this.#client.readContract({
            address,
            abi: AERODROME_POOL_ABI,
            functionName: 'claimable1',
            args: [owner],
          }),
        ),
      ]);
      claimable0 = c0.toString();
      claimable1 = c1.toString();
      claimNote = 'claimable0/claimable1 as the pool reports them for this holder';
    }

    const { amount0, amount1 } = shareOfReserves(pool, lpTokens);
    return {
      chain: this.chain,
      protocol: this.protocol,
      poolId: pool.poolId,
      owner: owner.toLowerCase(),
      lpTokens: lpTokens.toString(),
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      claimable0,
      claimable1,
      claimNote,
      observedAt: Date.now(),
      source: `${this.protocol}-rpc`,
    };
  }

  // --- quotes ----------------------------------------------------------------

  async quoteAdd(request: LpAddQuoteRequest): Promise<LpAddQuote> {
    const from = this.#recipient(request.from);
    const pool = await this.readPool(request.poolId);
    const desired0 = amountToBigint(request.amount0Desired);
    const desired1 = amountToBigint(request.amount1Desired);
    if (desired0 <= 0n || desired1 <= 0n) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'An add needs a positive amount of both assets');
    }

    let amount0: bigint;
    let amount1: bigint;
    let liquidity: bigint;
    let source: string;

    if (this.#dialect === 'aerodrome') {
      const quoted = await this.#call('quoteAddLiquidity', () =>
        this.#client.readContract({
          address: this.#router,
          abi: AERODROME_ROUTER_ABI,
          functionName: 'quoteAddLiquidity',
          args: [
            pool.token0.address as `0x${string}`,
            pool.token1.address as `0x${string}`,
            pool.stable,
            this.#factory,
            desired0,
            desired1,
          ],
        }),
      );
      [amount0, amount1, liquidity] = [quoted[0], quoted[1], quoted[2]];
      source = `${this.protocol}-quoteAddLiquidity`;
    } else {
      const local = v2AddQuote(pool, desired0, desired1);
      ({ amount0, amount1, liquidity } = local);
      source = `${this.protocol}-reserves`;
    }

    if (liquidity <= 0n) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, 'The pool would mint zero LP tokens');
    }

    const [gasPrice] = await Promise.all([
      this.#call('gasPrice', () => this.#client.getGasPrice()),
    ]);
    const quotedAt = Date.now();

    return {
      chain: this.chain,
      protocol: this.protocol,
      poolId: pool.poolId,
      contract: this.#router,
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      min0: (amount0 - bpsOf(amount0, request.slippageBps)).toString(),
      min1: (amount1 - bpsOf(amount1, request.slippageBps)).toString(),
      expectedLpTokens: liquidity.toString(),
      minLpTokens: (liquidity - bpsOf(liquidity, request.slippageBps)).toString(),
      slippageBps: request.slippageBps,
      quotedAt,
      source,
      feeEstimate: feeEstimate(ADD_GAS_LIMIT, gasPrice, quotedAt),
      routeData: {
        token0: pool.token0.address,
        token1: pool.token1.address,
        stable: pool.stable,
        recipient: from,
        deadlineSeconds: DEADLINE_SECONDS,
      } satisfies V2LpRoute,
    };
  }

  async quoteRemove(request: LpRemoveQuoteRequest): Promise<LpRemoveQuote> {
    const from = this.#recipient(request.from);
    const pool = await this.readPool(request.poolId);
    const lpTokens = amountToBigint(request.lpTokens);
    if (lpTokens <= 0n) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'A removal needs a positive LP amount');
    }

    let expected0: bigint;
    let expected1: bigint;
    let source: string;
    if (this.#dialect === 'aerodrome') {
      const quoted = await this.#call('quoteRemoveLiquidity', () =>
        this.#client.readContract({
          address: this.#router,
          abi: AERODROME_ROUTER_ABI,
          functionName: 'quoteRemoveLiquidity',
          args: [
            pool.token0.address as `0x${string}`,
            pool.token1.address as `0x${string}`,
            pool.stable,
            this.#factory,
            lpTokens,
          ],
        }),
      );
      [expected0, expected1] = [quoted[0], quoted[1]];
      source = `${this.protocol}-quoteRemoveLiquidity`;
    } else {
      const share = shareOfReserves(pool, lpTokens);
      expected0 = share.amount0;
      expected1 = share.amount1;
      source = `${this.protocol}-reserves`;
    }

    const gasPrice = await this.#call('gasPrice', () => this.#client.getGasPrice());
    const quotedAt = Date.now();

    return {
      chain: this.chain,
      protocol: this.protocol,
      poolId: pool.poolId,
      contract: this.#router,
      lpTokens: lpTokens.toString(),
      expected0: expected0.toString(),
      expected1: expected1.toString(),
      min0: (expected0 - bpsOf(expected0, request.slippageBps)).toString(),
      min1: (expected1 - bpsOf(expected1, request.slippageBps)).toString(),
      slippageBps: request.slippageBps,
      quotedAt,
      source,
      feeEstimate: feeEstimate(REMOVE_GAS_LIMIT, gasPrice, quotedAt),
      routeData: {
        token0: pool.token0.address,
        token1: pool.token1.address,
        stable: pool.stable,
        recipient: from,
        deadlineSeconds: DEADLINE_SECONDS,
      } satisfies V2LpRoute,
    };
  }

  async claimPlan(owner: string, poolId: string): Promise<LpClaimPlan> {
    if (!this.claimsFees) {
      throw new AppError(
        ErrorCode.ADAPTER_UNAVAILABLE,
        `${this.protocol} fees compound into the reserves; there is nothing to claim`,
      );
    }
    const position = await this.readPosition(owner, poolId);
    const gasPrice = await this.#call('gasPrice', () => this.#client.getGasPrice());
    const quotedAt = Date.now();
    return {
      chain: this.chain,
      protocol: this.protocol,
      poolId: position.poolId,
      contract: position.poolId,
      claimable0: position.claimable0 ?? '0',
      claimable1: position.claimable1 ?? '0',
      quotedAt,
      feeEstimate: feeEstimate(CLAIM_GAS_LIMIT, gasPrice, quotedAt),
    };
  }

  // --- builds ----------------------------------------------------------------

  buildAdd(quote: LpAddQuote): UnsignedTransaction {
    const route = this.#route(quote.routeData);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + route.deadlineSeconds);
    const args = [
      amountToBigint(quote.amount0),
      amountToBigint(quote.amount1),
      amountToBigint(quote.min0),
      amountToBigint(quote.min1),
      route.recipient as `0x${string}`,
      deadline,
    ] as const;
    const data =
      this.#dialect === 'aerodrome'
        ? encodeFunctionData({
            abi: AERODROME_ROUTER_ABI,
            functionName: 'addLiquidity',
            args: [
              route.token0 as `0x${string}`,
              route.token1 as `0x${string}`,
              route.stable,
              ...args,
            ],
          })
        : encodeFunctionData({
            abi: UNISWAP_V2_ROUTER_ABI,
            functionName: 'addLiquidity',
            args: [route.token0 as `0x${string}`, route.token1 as `0x${string}`, ...args],
          });

    return {
      chain: this.chain,
      payload: this.#payload(this.#router, data, route.recipient, ADD_GAS_LIMIT),
      summary: `${this.protocol} addLiquidity ${quote.amount0}/${quote.amount1} -> ≥${quote.minLpTokens} LP of ${quote.poolId} via ${this.#router}`,
    };
  }

  buildRemove(quote: LpRemoveQuote): UnsignedTransaction {
    const route = this.#route(quote.routeData);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + route.deadlineSeconds);
    const args = [
      amountToBigint(quote.lpTokens),
      amountToBigint(quote.min0),
      amountToBigint(quote.min1),
      route.recipient as `0x${string}`,
      deadline,
    ] as const;
    const data =
      this.#dialect === 'aerodrome'
        ? encodeFunctionData({
            abi: AERODROME_ROUTER_ABI,
            functionName: 'removeLiquidity',
            args: [
              route.token0 as `0x${string}`,
              route.token1 as `0x${string}`,
              route.stable,
              ...args,
            ],
          })
        : encodeFunctionData({
            abi: UNISWAP_V2_ROUTER_ABI,
            functionName: 'removeLiquidity',
            args: [route.token0 as `0x${string}`, route.token1 as `0x${string}`, ...args],
          });

    return {
      chain: this.chain,
      payload: this.#payload(this.#router, data, route.recipient, REMOVE_GAS_LIMIT),
      summary: `${this.protocol} removeLiquidity ${quote.lpTokens} LP of ${quote.poolId} -> ≥${quote.min0}/${quote.min1} via ${this.#router}`,
    };
  }

  buildClaim(plan: LpClaimPlan, owner: string): UnsignedTransaction {
    if (!this.claimsFees) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, `${this.protocol} has no fee claim`);
    }
    const recipient = this.#recipient(owner);
    const data = encodeFunctionData({ abi: AERODROME_POOL_ABI, functionName: 'claimFees' });
    return {
      chain: this.chain,
      payload: this.#payload(this.#poolAddress(plan.poolId), data, recipient, CLAIM_GAS_LIMIT),
      summary: `${this.protocol} claimFees on ${plan.poolId} (${plan.claimable0}/${plan.claimable1} claimable)`,
    };
  }

  buildApprove(token: string, owner: string, amount: bigint): UnsignedTransaction {
    if (!isAddress(token) || !isAddress(owner)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed token or owner address');
    }
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [this.#router, amount],
    });
    return {
      chain: this.chain,
      payload: this.#payload(token, data, owner, APPROVE_GAS_LIMIT),
      summary: `approve ${amount.toString()} of ${token} to ${this.#router}`,
    };
  }

  async allowance(token: string, owner: string): Promise<bigint> {
    return this.#call('allowance', () =>
      this.#client.readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [owner as `0x${string}`, this.#router],
      }),
    );
  }

  async approveFeeEstimate(): Promise<{ estimatedAt: number; detail: FeeDetail }> {
    const gasPrice = await this.#call('gasPrice', () => this.#client.getGasPrice());
    return feeEstimate(APPROVE_GAS_LIMIT, gasPrice, Date.now());
  }

  // --- signing support ---------------------------------------------------------

  async prepareSigning(tx: UnsignedTransaction, from: string): Promise<SigningContext> {
    const payload = tx.payload as EvmPayload;
    if (!isAddress(from) || payload.from.toLowerCase() !== from.toLowerCase()) {
      throw new AppError(ErrorCode.CONFLICT, 'Transaction was built for a different sender');
    }
    const [nonce, fees] = await Promise.all([
      this.#call('getTransactionCount', () =>
        this.#client.getTransactionCount({ address: from, blockTag: 'pending' }),
      ),
      this.#call('estimateFeesPerGas', () => this.#client.estimateFeesPerGas()),
    ]);
    return {
      family: 'evm',
      chainId: CHAINS[this.chain].evmChainId!,
      from: payload.from,
      to: payload.to,
      data: payload.data,
      value: payload.value,
      gas: payload.gasLimit,
      maxFeePerGas: ((fees.maxFeePerGas * 125n) / 100n).toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      nonce,
    };
  }

  async broadcast(signed: SignedTransaction): Promise<void> {
    if (!/^0x[0-9a-f]+$/i.test(signed.raw)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Signed transaction is not hex');
    }
    const reported = await this.#call('sendRawTransaction', () =>
      this.#client.sendRawTransaction({ serializedTransaction: signed.raw as `0x${string}` }),
    );
    if (reported.toLowerCase() !== signed.hash.toLowerCase()) {
      throw new AppError(ErrorCode.CONFLICT, 'Node reported a different transaction hash', {
        details: { recorded: signed.hash, reported },
      });
    }
  }

  /** The receipt, with every ERC-20 transfer to or from the wallet summed. */
  async receipt(hash: string, wallet: string): Promise<LpReceipt> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed transaction hash');
    }
    try {
      const receipt = await this.#client.getTransactionReceipt({ hash: hash as `0x${string}` });
      const received: Record<string, string> = {};
      const sent: Record<string, string> = {};
      if (receipt.status === 'success') {
        const transfers = parseEventLogs({
          abi: ERC20_ABI,
          eventName: 'Transfer',
          logs: receipt.logs,
          strict: true,
        });
        const me = wallet.toLowerCase();
        for (const log of transfers) {
          const token = log.address.toLowerCase();
          if (log.args.to.toLowerCase() === me) {
            received[token] = (BigInt(received[token] ?? '0') + log.args.value).toString();
          }
          if (log.args.from.toLowerCase() === me) {
            sent[token] = (BigInt(sent[token] ?? '0') + log.args.value).toString();
          }
        }
      }
      return {
        chain: this.chain,
        hash,
        status: receipt.status === 'success' ? 'confirmed' : 'failed',
        feeNative: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
        height: Number(receipt.blockNumber),
        error: receipt.status === 'success' ? null : 'transaction reverted',
        received,
        sent,
      };
    } catch {
      return {
        chain: this.chain,
        hash,
        status: 'pending',
        feeNative: null,
        height: null,
        error: null,
        received: {},
        sent: {},
      };
    }
  }

  // --- internals -------------------------------------------------------------

  async #factoryPool(token0: string, token1: string, stable: boolean): Promise<string> {
    if (this.#dialect === 'aerodrome') {
      return this.#call('factory.getPool', () =>
        this.#client.readContract({
          address: this.#factory,
          abi: AERODROME_FACTORY_ABI,
          functionName: 'getPool',
          args: [token0 as `0x${string}`, token1 as `0x${string}`, stable],
        }),
      );
    }
    return this.#call('factory.getPair', () =>
      this.#client.readContract({
        address: this.#factory,
        abi: UNISWAP_V2_FACTORY_ABI,
        functionName: 'getPair',
        args: [token0 as `0x${string}`, token1 as `0x${string}`],
      }),
    );
  }

  async #feeBps(pool: `0x${string}`, stable: boolean): Promise<number | null> {
    if (this.#dialect !== 'aerodrome') return null;
    try {
      const fee = await this.#client.readContract({
        address: this.#factory,
        abi: AERODROME_FACTORY_ABI,
        functionName: 'getFee',
        args: [pool, stable],
      });
      // Aerodrome reports the fee in basis points (30 = 0.30%).
      return Number(fee);
    } catch (error) {
      this.#log.warn({ err: error }, 'pool fee read failed');
      return null;
    }
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

  #recipient(from: string): string {
    // The recipient is always the requesting wallet. Anything else — and in
    // particular the zero address — would send LP tokens or assets away.
    if (!isAddress(from) || from.toLowerCase() === ZERO_ADDRESS) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'A quote needs the sending wallet address');
    }
    return from;
  }

  #route(routeData: unknown): V2LpRoute {
    const route = routeData as V2LpRoute | undefined;
    if (!route || !isAddress(route.token0) || !isAddress(route.token1)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Quote carries no v2 LP route data');
    }
    this.#recipient(route.recipient);
    return route;
  }

  #payload(to: `0x${string}`, data: `0x${string}`, from: string, gas: bigint): EvmPayload {
    return { to, data, from: from as `0x${string}`, value: '0', gasLimit: gas.toString() };
  }

  async #call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      this.#log.warn({ operation, err: cause }, 'lp call failed');
      throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, `${this.protocol} ${operation} failed`, {
        cause,
        details: { chain: this.chain, operation, reason: errorMessage(cause) },
      });
    }
  }
}

/** The v2 router's `_addLiquidity` ratio adjustment plus the pair's mint formula. */
export function v2AddQuote(
  pool: Pick<LpPoolState, 'reserve0' | 'reserve1' | 'totalSupply'>,
  desired0: bigint,
  desired1: bigint,
): { amount0: bigint; amount1: bigint; liquidity: bigint } {
  const reserve0 = amountToBigint(pool.reserve0);
  const reserve1 = amountToBigint(pool.reserve1);
  const totalSupply = amountToBigint(pool.totalSupply);
  if (reserve0 <= 0n || reserve1 <= 0n || totalSupply <= 0n) {
    // ATRA never seeds an empty pool: the first depositor sets the price.
    throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, 'The pool has no reserves');
  }

  let amount0: bigint;
  let amount1: bigint;
  const optimal1 = floorDiv(desired0 * reserve1, reserve0);
  if (optimal1 <= desired1) {
    amount0 = desired0;
    amount1 = optimal1;
  } else {
    amount0 = floorDiv(desired1 * reserve0, reserve1);
    amount1 = desired1;
  }

  const byToken0 = floorDiv(amount0 * totalSupply, reserve0);
  const byToken1 = floorDiv(amount1 * totalSupply, reserve1);
  return { amount0, amount1, liquidity: byToken0 < byToken1 ? byToken0 : byToken1 };
}

/** A holder's share of the reserves, floor-rounded (what a burn would return). */
export function shareOfReserves(
  pool: Pick<LpPoolState, 'reserve0' | 'reserve1' | 'totalSupply'>,
  lpTokens: bigint,
): { amount0: bigint; amount1: bigint } {
  const totalSupply = amountToBigint(pool.totalSupply);
  if (totalSupply <= 0n || lpTokens <= 0n) return { amount0: 0n, amount1: 0n };
  return {
    amount0: floorDiv(lpTokens * amountToBigint(pool.reserve0), totalSupply),
    amount1: floorDiv(lpTokens * amountToBigint(pool.reserve1), totalSupply),
  };
}

function feeEstimate(
  gasLimit: bigint,
  gasPrice: bigint,
  at: number,
): { estimatedAt: number; detail: FeeDetail } {
  return {
    estimatedAt: at,
    detail: {
      family: 'evm',
      gasLimit: gasLimit.toString(),
      // Same 25% headroom as the swap adapters; the engine caps the USD worst case.
      maxFeePerGas: ((gasPrice * 125n) / 100n).toString(),
    },
  };
}
