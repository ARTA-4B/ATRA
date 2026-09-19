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
import type {
  Erc20ApprovalCapable,
  ExecutionAdapter,
  ExecutionQuote,
  ExecutionReceipt,
  QuoteRequest,
  ReceiptExpectation,
  SignedTransaction,
  SigningContext,
  SimulationResult,
  UnsignedTransaction,
} from '../types.js';
import { CHAINS, DEFAULT_PROTOCOLS, EVM_NATIVE_SENTINEL } from '../../chains/registry.js';
import type { ChainId } from '../../chains/registry.js';
import { AppError, ErrorCode, errorMessage } from '../../util/errors.js';
import { childLogger } from '../../logging/logger.js';
import { amountToBigint, bpsOf } from '../../risk/money.js';

/**
 * Uniswap-v2-style routers: PancakeSwap v2 on BNB Smart Chain and Aerodrome on
 * Base.
 *
 * These are the simplest audited swap paths on their chains: one call,
 * `getAmountsOut` to quote and `swapExactTokensForTokens` to execute, no
 * position NFTs, no hook contracts. That simplicity is the point for a first
 * live adapter — every byte of calldata is produced by code in this file, and
 * the risk engine can see exactly which contract it targets.
 *
 * Aerodrome speaks a slightly different dialect (routes carry a `stable` flag
 * and a factory), so the two are separate ABIs behind one class.
 *
 * Uniswap v4 (the only DEX on Robinhood Chain today) is not covered: its
 * Universal Router encoding is intricate enough that shipping it without a
 * live test would be a guess dressed as a feature. Robinhood Chain therefore
 * has no execution adapter in this build, and the runtime says so.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
/** A generous gas ceiling for a single-hop v2 swap. */
const SWAP_GAS_LIMIT = 250_000n;
const APPROVE_GAS_LIMIT = 60_000n;

const UNISWAP_V2_ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

const AERODROME_ROUTER_ABI = parseAbi([
  'struct Route { address from; address to; bool stable; address factory; }',
  'function getAmountsOut(uint256 amountIn, Route[] routes) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
  'function defaultFactory() view returns (address)',
]);

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

interface EvmPayload {
  to: `0x${string}`;
  data: `0x${string}`;
  from: `0x${string}`;
  value: string;
  gasLimit: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type V2Dialect = 'uniswap-v2' | 'aerodrome';

export interface V2RouterAdapterOptions {
  chain: ChainId;
  protocol: string;
  dialect: V2Dialect;
  router: string;
  rpcUrl?: string | undefined;
  timeoutMs?: number;
}

interface V2RouteData {
  path: string[];
  stable: boolean;
  deadlineSeconds: number;
  /** The wallet that sends the swap and receives the output. */
  recipient: string;
}

export class V2RouterAdapter implements ExecutionAdapter, Erc20ApprovalCapable {
  readonly chain: ChainId;
  readonly protocol: string;
  readonly contracts: readonly string[];

  readonly #dialect: V2Dialect;
  readonly #router: `0x${string}`;
  readonly #client: PublicClient;
  readonly #log;

  constructor(options: V2RouterAdapterOptions) {
    const info = CHAINS[options.chain];
    if (info.family !== 'evm' || info.evmChainId === undefined) {
      throw new AppError(ErrorCode.CHAIN_UNSUPPORTED, `${options.chain} is not an EVM chain`);
    }
    if (!isAddress(options.router)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed router address');
    }

    // The router must be one the registry knows for this protocol. An adapter
    // pointed at an arbitrary address would be exactly the generic call path
    // this project refuses to have.
    const registered = DEFAULT_PROTOCOLS[options.chain][options.protocol]?.contracts ?? [];
    if (!registered.includes(options.router.toLowerCase())) {
      throw new AppError(
        ErrorCode.CHAIN_UNSUPPORTED,
        `${options.router} is not a registered ${options.protocol} contract on ${options.chain}`,
      );
    }

    this.chain = options.chain;
    this.protocol = options.protocol;
    this.contracts = [options.router.toLowerCase()];
    this.#dialect = options.dialect;
    this.#router = options.router;
    this.#log = childLogger('v2-router', { chain: options.chain, protocol: options.protocol });

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

  async supportsRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    if (!isAddress(tokenIn) || !isAddress(tokenOut)) return false;
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return false;
    // The native sentinel is not a token the router can move; callers wrap
    // first. Phase 3 trades ERC-20 pairs only.
    if (tokenIn === EVM_NATIVE_SENTINEL || tokenOut === EVM_NATIVE_SENTINEL) return false;

    try {
      await this.#amountsOut(1n, [tokenIn, tokenOut]);
      return true;
    } catch {
      return false;
    }
  }

  async quote(request: QuoteRequest): Promise<ExecutionQuote> {
    const tokenIn = request.tokenIn.address;
    const tokenOut = request.tokenOut.address;
    if (!isAddress(request.from) || request.from.toLowerCase() === ZERO_ADDRESS) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'A quote needs the sending wallet address');
    }
    if (!(await this.supportsRoute(tokenIn, tokenOut))) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, 'No route between these tokens', {
        details: { chain: this.chain, protocol: this.protocol, tokenIn, tokenOut },
      });
    }

    const amountIn = amountToBigint(request.amountIn);
    const [amounts, gasPrice] = await Promise.all([
      this.#amountsOut(amountIn, [tokenIn, tokenOut]),
      this.#call('gasPrice', () => this.#client.getGasPrice()),
    ]);

    const expectedOut = amounts.at(-1) ?? 0n;
    if (expectedOut <= 0n) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, 'Router quoted zero output');
    }

    const minOut = expectedOut - bpsOf(expectedOut, request.slippageBps);
    const quotedAt = Date.now();

    // Price impact from a v2 quote: compare the marginal price of a tiny trade
    // with the realised price of this one. Rounded up.
    const probe = await this.#amountsOut(amountIn / 1000n > 0n ? amountIn / 1000n : 1n, [
      tokenIn,
      tokenOut,
    ]);
    const probeOut = probe.at(-1) ?? 0n;
    const probeIn = amountIn / 1000n > 0n ? amountIn / 1000n : 1n;
    const priceImpactBps =
      probeOut > 0n
        ? Number(
            ((probeOut * amountIn - expectedOut * probeIn) * 10_000n + probeOut * amountIn - 1n) /
              (probeOut * amountIn),
          )
        : 10_000;

    return {
      chain: this.chain,
      protocol: this.protocol,
      contract: this.#router.toLowerCase(),
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: amountIn.toString(),
      expectedAmountOut: expectedOut.toString(),
      minAmountOut: minOut.toString(),
      slippageBps: request.slippageBps,
      priceImpactBps: Math.max(0, Math.min(10_000, priceImpactBps)),
      quotedAt,
      source: `${this.protocol}-getAmountsOut`,
      marketId: `${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`,
      feeEstimate: {
        estimatedAt: quotedAt,
        detail: {
          family: 'evm',
          gasLimit: SWAP_GAS_LIMIT.toString(),
          // A 25% buffer over the current price so a fill during a small fee
          // spike still lands; the risk engine caps the worst case in USD.
          maxFeePerGas: ((gasPrice * 125n) / 100n).toString(),
        },
      },
      routeData: {
        path: [tokenIn, tokenOut],
        stable: false,
        deadlineSeconds: 300,
        recipient: request.from,
      } satisfies V2RouteData,
    };
  }

  /**
   * Simulate with eth_call from the wallet's address.
   *
   * A revert here is reported verbatim. The common causes — no balance, no
   * allowance — are exactly the things that would fail on-chain, which is why
   * simulation exists.
   */
  async simulate(quote: ExecutionQuote): Promise<SimulationResult> {
    const simulatedAt = Date.now();
    try {
      const built = await this.build(quote);
      const payload = built.payload as EvmPayload;

      const gas = await this.#client.estimateGas({
        account: payload.from,
        to: payload.to,
        data: payload.data,
      });

      return {
        ok: true,
        amountOut: quote.expectedAmountOut,
        unitsUsed: Number(gas),
        error: null,
        simulatedAt,
      };
    } catch (error) {
      return {
        ok: false,
        amountOut: null,
        unitsUsed: null,
        error: errorMessage(error).slice(0, 300),
        simulatedAt,
      };
    }
  }

  build(quote: ExecutionQuote): Promise<UnsignedTransaction> {
    const route = quote.routeData as V2RouteData | undefined;
    if (!route || route.path.length < 2) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Quote carries no v2 route data');
    }
    // The recipient is the wallet the quote was requested for. Anything else
    // — and in particular the zero address — would send the output away.
    if (!isAddress(route.recipient) || route.recipient.toLowerCase() === ZERO_ADDRESS) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Quote carries no recipient');
    }
    const recipient = route.recipient;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + route.deadlineSeconds);
    const amountIn = amountToBigint(quote.amountIn);
    const minOut = amountToBigint(quote.minAmountOut);

    const data =
      this.#dialect === 'aerodrome'
        ? encodeFunctionData({
            abi: AERODROME_ROUTER_ABI,
            functionName: 'swapExactTokensForTokens',
            args: [
              amountIn,
              minOut,
              [
                {
                  from: route.path[0] as `0x${string}`,
                  to: route.path[1] as `0x${string}`,
                  stable: route.stable,
                  factory: ZERO_ADDRESS,
                },
              ],
              recipient,
              deadline,
            ],
          })
        : encodeFunctionData({
            abi: UNISWAP_V2_ROUTER_ABI,
            functionName: 'swapExactTokensForTokens',
            args: [amountIn, minOut, route.path as `0x${string}`[], recipient, deadline],
          });

    return Promise.resolve({
      chain: this.chain,
      payload: {
        to: this.#router,
        data,
        from: recipient,
        value: '0',
        gasLimit: SWAP_GAS_LIMIT.toString(),
      },
      summary: `${this.protocol} swapExactTokensForTokens ${quote.amountIn} -> ≥${quote.minAmountOut} via ${this.#router}`,
    });
  }

  /** Calldata for an ERC-20 approval to this router. */
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
      payload: {
        to: token,
        data,
        from: owner,
        value: '0',
        gasLimit: APPROVE_GAS_LIMIT.toString(),
      },
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

  /** Nonce and fee caps for signing. Reads only. */
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
      nonce,
      // Same 25% headroom the quote's fee estimate assumed.
      maxFeePerGas: ((fees.maxFeePerGas * 125n) / 100n).toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
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
      // The node accepted something whose hash differs from what was recorded;
      // that must never pass silently.
      throw new AppError(ErrorCode.CONFLICT, 'Node reported a different transaction hash', {
        details: { recorded: signed.hash, reported },
      });
    }
  }

  async approveFeeEstimate(): Promise<ExecutionQuote['feeEstimate']> {
    const gasPrice = await this.#call('gasPrice', () => this.#client.getGasPrice());
    return {
      estimatedAt: Date.now(),
      detail: {
        family: 'evm',
        gasLimit: APPROVE_GAS_LIMIT.toString(),
        maxFeePerGas: ((gasPrice * 125n) / 100n).toString(),
      },
    };
  }

  /**
   * The receipt, with the received amount read from the chain.
   *
   * `amountOut` is the sum of ERC-20 `Transfer` events of `tokenOut` whose
   * recipient is the wallet, in that transaction. It is what the wallet got,
   * not what was quoted.
   */
  async receipt(hash: string, expect?: ReceiptExpectation): Promise<ExecutionReceipt> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed transaction hash');
    }
    try {
      const receipt = await this.#client.getTransactionReceipt({ hash: hash as `0x${string}` });

      let amountOut: string | null = null;
      if (expect && receipt.status === 'success') {
        const transfers = parseEventLogs({
          abi: ERC20_ABI,
          eventName: 'Transfer',
          logs: receipt.logs,
          strict: true,
        });
        const received = transfers
          .filter(
            (log) =>
              log.address.toLowerCase() === expect.tokenOut.toLowerCase() &&
              log.args.to.toLowerCase() === expect.recipient.toLowerCase(),
          )
          .reduce((sum, log) => sum + log.args.value, 0n);
        amountOut = received > 0n ? received.toString() : null;
      }

      return {
        chain: this.chain,
        hash,
        status: receipt.status === 'success' ? 'confirmed' : 'failed',
        amountOut,
        feeNative: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
        height: Number(receipt.blockNumber),
        error: receipt.status === 'success' ? null : 'transaction reverted',
      };
    } catch {
      return {
        chain: this.chain,
        hash,
        status: 'pending',
        amountOut: null,
        feeNative: null,
        height: null,
        error: null,
      };
    }
  }

  async #amountsOut(amountIn: bigint, path: string[]): Promise<readonly bigint[]> {
    if (this.#dialect === 'aerodrome') {
      return this.#call('getAmountsOut', () =>
        this.#client.readContract({
          address: this.#router,
          abi: AERODROME_ROUTER_ABI,
          functionName: 'getAmountsOut',
          args: [
            amountIn,
            [
              {
                from: path[0] as `0x${string}`,
                to: path[1] as `0x${string}`,
                stable: false,
                factory: ZERO_ADDRESS,
              },
            ],
          ],
        }),
      );
    }

    return this.#call('getAmountsOut', () =>
      this.#client.readContract({
        address: this.#router,
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: 'getAmountsOut',
        args: [amountIn, path as `0x${string}`[]],
      }),
    );
  }

  async #call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      this.#log.warn({ operation, err: cause }, 'router call failed');
      throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, `${this.protocol} ${operation} failed`, {
        cause,
        details: { chain: this.chain, operation },
      });
    }
  }
}
