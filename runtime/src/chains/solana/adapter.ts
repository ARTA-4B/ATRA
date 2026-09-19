import { base58 } from '@scure/base';
import { CHAINS, SOLANA_MAINNET_GENESIS } from '../registry.js';
import type { ChainId } from '../registry.js';
import { AppError, ErrorCode, errorMessage } from '../../util/errors.js';
import { childLogger } from '../../logging/logger.js';
import type {
  ChainAdapter,
  ChainHealth,
  FeeEstimate,
  NativeBalance,
  Observation,
  TokenBalance,
  TokenMetadata,
  TransactionStatus,
} from '../types.js';

/**
 * Solana adapter.
 *
 * Talks JSON-RPC over fetch rather than pulling in a client library: the read
 * surface ATRA needs is small, and every extra dependency in a process that
 * holds keys is a supply-chain decision. Signing is handled by the vault's
 * audited ed25519 implementation, not here.
 *
 * {@link health} compares the genesis hash against mainnet-beta, which is the
 * Solana equivalent of checking an EVM chain id: it catches an endpoint that
 * silently serves devnet, where balances are meaningless but look real.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
/** Base fee per signature, fixed by the protocol. */
const LAMPORTS_PER_SIGNATURE = 5_000n;

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface SolanaAdapterOptions {
  rpcUrl?: string | undefined;
  timeoutMs?: number;
}

interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface TokenAccountsResponse {
  value: Array<{
    account: {
      data: {
        parsed: {
          info: {
            tokenAmount: { amount: string; decimals: number };
          };
        };
      };
    };
  }>;
}

interface SignatureStatusResponse {
  value: Array<{
    slot: number;
    confirmations: number | null;
    confirmationStatus: string | null;
    err: unknown;
  } | null>;
}

interface AccountInfoResponse {
  value: {
    data: { parsed?: { info?: { decimals?: number } } } | [string, string];
    owner: string;
  } | null;
}

export class SolanaChainAdapter implements ChainAdapter {
  readonly chain: ChainId = 'solana';
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #log = childLogger('solana-adapter');
  #nextId = 1;

  constructor(options: SolanaAdapterOptions = {}) {
    const endpoint = options.rpcUrl ?? CHAINS.solana.publicRpcUrls[0];
    if (!endpoint) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, 'No Solana RPC endpoint configured');
    }
    this.#endpoint = endpoint;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<ChainHealth> {
    const started = Date.now();
    try {
      const [genesis, slot] = await Promise.all([
        this.#rpc<string>('getGenesisHash', []),
        this.#rpc<number>('getSlot', [{ commitment: 'confirmed' }]),
      ]);

      const matches = genesis === SOLANA_MAINNET_GENESIS;
      if (!matches) {
        this.#log.error({ genesis }, 'RPC endpoint is not Solana mainnet-beta');
      }

      return {
        chain: this.chain,
        healthy: matches,
        height: slot,
        latencyMs: Date.now() - started,
        endpoint: this.#endpoint,
        error: matches ? null : 'endpoint is not serving mainnet-beta',
        identity: genesis,
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
    assertPubkey(address);
    const result = await this.#rpc<{ value: number }>('getBalance', [
      address,
      { commitment: 'confirmed' },
    ]);

    return this.#observe({
      chain: this.chain,
      address,
      amount: BigInt(result.value).toString(),
      symbol: CHAINS.solana.nativeSymbol,
      decimals: CHAINS.solana.nativeDecimals,
    });
  }

  /**
   * Sum every token account the owner holds for a mint.
   *
   * Both the SPL Token and Token-2022 programs are queried: a mint issued under
   * Token-2022 is invisible to a Token-only lookup, which would read as a zero
   * balance rather than an error.
   */
  async getTokenBalance(owner: string, mint: string): Promise<Observation<TokenBalance>> {
    assertPubkey(owner);
    assertPubkey(mint);

    const responses = await Promise.all(
      [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
        this.#rpc<TokenAccountsResponse>('getTokenAccountsByOwner', [
          owner,
          { mint, programId },
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        ]),
      ),
    );

    let total = 0n;
    let decimals = 0;
    for (const response of responses) {
      for (const account of response.value) {
        const amount = account.account.data.parsed.info.tokenAmount;
        total += BigInt(amount.amount);
        decimals = amount.decimals;
      }
    }

    return this.#observe({
      chain: this.chain,
      owner,
      token: mint,
      amount: total.toString(),
      symbol: null,
      decimals,
    });
  }

  /**
   * Mint metadata.
   *
   * Only `decimals` is read on-chain. Symbol and name live in a separate
   * metadata program and are cosmetic, so they are reported as null rather than
   * guessed: the risk engine matches on the mint address, never on a symbol.
   */
  async getTokenMetadata(mint: string): Promise<Observation<TokenMetadata>> {
    assertPubkey(mint);
    const result = await this.#rpc<AccountInfoResponse>('getAccountInfo', [
      mint,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);

    const decimals =
      result.value && !Array.isArray(result.value.data)
        ? (result.value.data.parsed?.info?.decimals ?? null)
        : null;

    return this.#observe({
      chain: this.chain,
      address: mint,
      symbol: null,
      name: null,
      decimals,
    });
  }

  async estimateTransferFee(): Promise<Observation<FeeEstimate>> {
    // A plain transfer carries one signature and no priority fee. Rent for a
    // new associated token account is added by the token-transfer path, which
    // queries getMinimumBalanceForRentExemption rather than hard-coding it.
    return Promise.resolve(
      this.#observe({
        chain: this.chain,
        nativeAmount: LAMPORTS_PER_SIGNATURE.toString(),
        unitPrice: LAMPORTS_PER_SIGNATURE.toString(),
        units: 1,
      }),
    );
  }

  async getTransactionStatus(signature: string): Promise<Observation<TransactionStatus>> {
    assertSignature(signature);
    const result = await this.#rpc<SignatureStatusResponse>('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ]);

    const status = result.value[0];
    if (!status) {
      return this.#observe({
        chain: this.chain,
        hash: signature,
        state: 'unknown',
        height: null,
        confirmations: null,
        error: null,
      });
    }

    return this.#observe({
      chain: this.chain,
      hash: signature,
      state: status.err
        ? 'failed'
        : status.confirmationStatus === 'finalized' || status.confirmationStatus === 'confirmed'
          ? 'confirmed'
          : 'pending',
      height: status.slot,
      confirmations: status.confirmations,
      error: status.err ? JSON.stringify(status.err).slice(0, 200) : null,
    });
  }

  /** Rent-exempt minimum for an account of `bytes`, queried never hard-coded. */
  async getRentExemptMinimum(bytes: number): Promise<bigint> {
    const lamports = await this.#rpc<number>('getMinimumBalanceForRentExemption', [bytes]);
    return BigInt(lamports);
  }

  async #rpc<T>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new AppError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          `Solana RPC returned HTTP ${response.status}`,
          { details: { method, status: response.status } },
        );
      }

      const payload = (await response.json()) as RpcResponse<T>;
      if (payload.error) {
        throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, `Solana RPC error: ${payload.error.message}`, {
          details: { method, code: payload.error.code },
        });
      }
      if (payload.result === undefined) {
        throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, 'Solana RPC returned no result', {
          details: { method },
        });
      }

      return payload.result;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      const timedOut = cause instanceof Error && cause.name === 'AbortError';
      this.#log.warn({ method, err: cause }, 'Solana RPC call failed');
      throw new AppError(
        timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_UNAVAILABLE,
        `Solana RPC call ${method} failed`,
        { cause, details: { endpoint: this.#endpoint, method } },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  #observe<T>(value: T): Observation<T> {
    return { value, observedAt: Date.now(), source: this.#endpoint };
  }
}

export function assertPubkey(value: string): void {
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(value);
  } catch {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed Solana address', {
      details: { address: value },
    });
  }
  if (decoded.length !== 32) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'A Solana address must decode to 32 bytes', {
      details: { address: value, bytes: decoded.length },
    });
  }
}

function assertSignature(value: string): void {
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(value);
  } catch {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed Solana signature');
  }
  if (decoded.length !== 64) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'A Solana signature must decode to 64 bytes');
  }
}
