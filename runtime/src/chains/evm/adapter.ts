import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
} from 'viem';
import type { PublicClient } from 'viem';
import { CHAINS } from '../registry.js';
import type { ChainId } from '../registry.js';
import { AppError, ErrorCode, errorMessage } from '../../util/errors.js';
import { childLogger } from '../../logging/logger.js';
import type {
  ChainAdapter,
  ChainHealth,
  FeeEstimate,
  NativeBalance,
  Observation,
  PreparedTransfer,
  SignedTransaction,
  SigningContext,
  TokenBalance,
  TokenMetadata,
  TransactionStatus,
  TransferCapable,
  TransferRequest,
} from '../types.js';

/**
 * Adapter for the three EVM chains ATRA supports.
 *
 * One implementation serves Base, BNB Smart Chain and Robinhood Chain because
 * they speak the same JSON-RPC. What differs — chain id, native symbol,
 * endpoints, token addresses — comes from the registry, and {@link health}
 * verifies the endpoint really reports the chain id we expect before any
 * balance is trusted. Pointing ATRA at the wrong RPC is a realistic
 * misconfiguration, and reading BNB balances while believing they are Base
 * balances would be worse than an outright failure.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
/** Gas a plain native transfer costs on every EVM chain. */
const NATIVE_TRANSFER_GAS = 21_000;
/** Ceiling for an ERC-20 transfer when the node cannot estimate. */
const TOKEN_TRANSFER_GAS_FALLBACK = 90_000;

interface EvmTransferPayload {
  from: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  gas: string;
}

export interface EvmAdapterOptions {
  /** Overrides the registry endpoints; supplied by an operator using BYOK. */
  rpcUrl?: string | undefined;
  timeoutMs?: number;
}

export class EvmChainAdapter implements ChainAdapter, TransferCapable {
  readonly chain: ChainId;
  readonly #client: PublicClient;
  readonly #endpoint: string;
  readonly #log;

  constructor(chain: ChainId, options: EvmAdapterOptions = {}) {
    const info = CHAINS[chain];
    if (info.family !== 'evm' || info.evmChainId === undefined) {
      throw new AppError(ErrorCode.CHAIN_UNSUPPORTED, `${chain} is not an EVM chain`);
    }

    const endpoint = options.rpcUrl ?? info.publicRpcUrls[0];
    if (!endpoint) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, `No RPC endpoint configured for ${chain}`);
    }

    this.chain = chain;
    this.#endpoint = endpoint;
    this.#log = childLogger('evm-adapter', { chain });

    const viemChain = defineChain({
      id: info.evmChainId,
      name: info.displayName,
      nativeCurrency: {
        name: info.nativeSymbol,
        symbol: info.nativeSymbol,
        decimals: info.nativeDecimals,
      },
      rpcUrls: { default: { http: [endpoint] } },
    });

    this.#client = createPublicClient({
      chain: viemChain,
      transport: http(endpoint, {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retryCount: 1,
      }),
    });
  }

  async health(): Promise<ChainHealth> {
    const expected = CHAINS[this.chain].evmChainId!;
    const started = Date.now();

    try {
      const [chainId, blockNumber] = await Promise.all([
        this.#client.getChainId(),
        this.#client.getBlockNumber(),
      ]);

      const matches = chainId === expected;
      if (!matches) {
        this.#log.error({ expected, chainId }, 'RPC endpoint serves a different chain');
      }

      return {
        chain: this.chain,
        healthy: matches,
        height: Number(blockNumber),
        latencyMs: Date.now() - started,
        endpoint: this.#endpoint,
        error: matches ? null : `endpoint reports chain id ${chainId}, expected ${expected}`,
        identity: String(chainId),
        identityMatches: matches,
      };
    } catch (cause) {
      return {
        chain: this.chain,
        healthy: false,
        height: null,
        latencyMs: Date.now() - started,
        endpoint: this.#endpoint,
        error: errorMessage(cause),
        identity: null,
        identityMatches: false,
      };
    }
  }

  async getNativeBalance(address: string): Promise<Observation<NativeBalance>> {
    this.#assertAddress(address);
    const info = CHAINS[this.chain];

    const amount = await this.#call('getBalance', () =>
      this.#client.getBalance({ address: address as `0x${string}` }),
    );

    return this.#observe({
      chain: this.chain,
      address,
      amount: amount.toString(),
      symbol: info.nativeSymbol,
      decimals: info.nativeDecimals,
    });
  }

  async getTokenBalance(owner: string, token: string): Promise<Observation<TokenBalance>> {
    this.#assertAddress(owner);
    this.#assertAddress(token);

    // decimals() is read from the contract rather than taken from the caller:
    // a wrong decimals value silently rescales every downstream USD figure.
    const [amount, decimals, symbol] = await this.#call('readToken', async () => {
      const contract = { address: token as `0x${string}`, abi: erc20Abi } as const;
      return Promise.all([
        this.#client.readContract({
          ...contract,
          functionName: 'balanceOf',
          args: [owner as `0x${string}`],
        }),
        this.#client.readContract({ ...contract, functionName: 'decimals' }),
        this.#client.readContract({ ...contract, functionName: 'symbol' }).catch(() => null),
      ]);
    });

    return this.#observe({
      chain: this.chain,
      owner,
      token,
      amount: amount.toString(),
      symbol,
      decimals,
    });
  }

  async getTokenMetadata(token: string): Promise<Observation<TokenMetadata>> {
    this.#assertAddress(token);

    const [symbol, name, decimals] = await this.#call('tokenMetadata', async () => {
      const contract = { address: token as `0x${string}`, abi: erc20Abi } as const;
      return Promise.all([
        this.#client.readContract({ ...contract, functionName: 'symbol' }).catch(() => null),
        this.#client.readContract({ ...contract, functionName: 'name' }).catch(() => null),
        this.#client.readContract({ ...contract, functionName: 'decimals' }).catch(() => null),
      ]);
    });

    return this.#observe({ chain: this.chain, address: token, symbol, name, decimals });
  }

  async estimateTransferFee(): Promise<Observation<FeeEstimate>> {
    const gasPrice = await this.#call('gasPrice', () => this.#client.getGasPrice());

    return this.#observe({
      chain: this.chain,
      nativeAmount: (gasPrice * BigInt(NATIVE_TRANSFER_GAS)).toString(),
      unitPrice: gasPrice.toString(),
      units: NATIVE_TRANSFER_GAS,
    });
  }

  async getTransactionStatus(hash: string): Promise<Observation<TransactionStatus>> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed transaction hash');
    }

    const status = await this.#call('txStatus', async () => {
      try {
        const receipt = await this.#client.getTransactionReceipt({ hash: hash as `0x${string}` });
        const head = await this.#client.getBlockNumber();
        return {
          chain: this.chain,
          hash,
          state: receipt.status === 'success' ? ('confirmed' as const) : ('failed' as const),
          height: Number(receipt.blockNumber),
          confirmations: Number(head - receipt.blockNumber) + 1,
          error: receipt.status === 'success' ? null : 'transaction reverted',
        };
      } catch {
        // No receipt yet means pending or unknown; the caller distinguishes
        // those by whether it has seen the hash before.
        return {
          chain: this.chain,
          hash,
          state: 'pending' as const,
          height: null,
          confirmations: null,
          error: null,
        };
      }
    });

    return this.#observe(status);
  }

  // --- transfers (operator withdrawals) --------------------------------------

  /**
   * Build a native or ERC-20 transfer and estimate its fee.
   *
   * The fee is estimated with `eth_estimateGas` from the wallet; when that
   * fails (most often because the wallet cannot cover the transfer) the
   * transfer is returned with a null fee and a warning, and the withdrawal
   * service refuses to submit it. There is no fallback fee for a transaction
   * the node says will not run.
   */
  async prepareTransfer(request: TransferRequest): Promise<PreparedTransfer> {
    this.#assertAddress(request.from);
    this.#assertAddress(request.to);
    if (request.amount <= 0n) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Transfer amount must be positive');
    }

    const warnings: string[] = [];
    const from = request.from as `0x${string}`;
    const to = request.to as `0x${string}`;

    const payload: EvmTransferPayload = request.token
      ? {
          from,
          to: request.token as `0x${string}`,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [to, request.amount],
          }),
          value: '0',
          gas: String(TOKEN_TRANSFER_GAS_FALLBACK),
        }
      : {
          from,
          to,
          data: '0x',
          value: request.amount.toString(),
          gas: String(NATIVE_TRANSFER_GAS),
        };

    if (request.token) this.#assertAddress(request.token);

    // Sending to a contract is allowed but worth a warning: many contracts
    // cannot move what they receive.
    try {
      const code = await this.#client.getCode({ address: to });
      if (code && code !== '0x') warnings.push('Destination is a contract address.');
    } catch {
      warnings.push('Could not check whether the destination is a contract.');
    }

    let feeNative: string | null = null;
    let feeSource = 'none';
    try {
      const [gas, gasPrice] = await Promise.all([
        request.token
          ? this.#client.estimateGas({ account: from, to: payload.to, data: payload.data })
          : Promise.resolve(BigInt(NATIVE_TRANSFER_GAS)),
        this.#client.getGasPrice(),
      ]);
      const gasWithBuffer = request.token ? (gas * 120n) / 100n : gas;
      payload.gas = gasWithBuffer.toString();
      feeNative = (gasWithBuffer * ((gasPrice * 125n) / 100n)).toString();
      feeSource = 'chain-rpc';
    } catch (cause) {
      this.#log.warn({ err: cause }, 'transfer fee estimate failed');
      warnings.push(`Fee could not be estimated: ${errorMessage(cause)}`);
    }

    return {
      chain: this.chain,
      payload,
      feeNative,
      feeSource,
      summary: request.token
        ? `transfer ${request.amount.toString()} of ${request.token} to ${request.to}`
        : `send ${request.amount.toString()} wei to ${request.to}`,
      warnings,
    };
  }

  async transferSigningContext(prepared: PreparedTransfer): Promise<SigningContext> {
    const payload = prepared.payload as EvmTransferPayload;
    const [nonce, fees] = await Promise.all([
      this.#call('getTransactionCount', () =>
        this.#client.getTransactionCount({ address: payload.from, blockTag: 'pending' }),
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
      gas: payload.gas,
      nonce,
      maxFeePerGas: ((fees.maxFeePerGas * 125n) / 100n).toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    };
  }

  async broadcastSigned(signed: SignedTransaction): Promise<void> {
    const reported = await this.#call('sendRawTransaction', () =>
      this.#client.sendRawTransaction({ serializedTransaction: signed.raw as `0x${string}` }),
    );
    if (reported.toLowerCase() !== signed.hash.toLowerCase()) {
      throw new AppError(ErrorCode.CONFLICT, 'Node reported a different transaction hash', {
        details: { recorded: signed.hash, reported },
      });
    }
  }

  #assertAddress(address: string): void {
    if (!isAddress(address)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed EVM address', {
        details: { address },
      });
    }
  }

  /**
   * Wrap an RPC call so a network failure surfaces as UPSTREAM_UNAVAILABLE
   * rather than a viem-specific error. Failures are never swallowed: there is
   * no "return zero balance on error" path, because a zero balance looks like
   * a legitimate reading to everything downstream.
   */
  async #call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (cause) {
      this.#log.warn({ operation, err: cause }, 'RPC call failed');
      throw new AppError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        `${this.chain} RPC call ${operation} failed`,
        { cause, details: { endpoint: this.#endpoint, operation } },
      );
    }
  }

  #observe<T>(value: T): Observation<T> {
    return { value, observedAt: Date.now(), source: this.#endpoint };
  }
}
