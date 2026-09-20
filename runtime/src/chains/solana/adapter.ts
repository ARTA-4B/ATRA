import { base58 } from '@scure/base';
import { z } from 'zod';
import { CHAINS, SOLANA_MAINNET_GENESIS } from '../registry.js';
import type { ChainId } from '../registry.js';
import { AppError, ErrorCode } from '../../util/errors.js';
import { readJsonBounded } from '../../util/http.js';
import { childLogger } from '../../logging/logger.js';
import type {
  PreparedTransfer,
  SignedTransaction,
  SigningContext,
  TransferCapable,
  TransferRequest,
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
 *
 * Nothing the node says is taken on trust: every reply is parsed against a
 * schema before a value is read out of it.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
/** Base fee per signature, fixed by the protocol. */
const LAMPORTS_PER_SIGNATURE = 5_000n;
/** The largest reply ATRA asks for is a token-account list; 4 MB covers it. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

import {
  TOKEN_ACCOUNT_BYTES,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  associatedTokenAddress,
  compileLegacyMessage,
  createAssociatedTokenAccountIdempotent,
  systemTransfer,
  transferChecked,
  unsignedTransactionBase64,
} from './transfer.js';

interface SolanaTransferPayload {
  feePayer: string;
  transactionBase64: string;
  lastValidBlockHeight: number;
}

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface SolanaAdapterOptions {
  rpcUrl?: string | undefined;
  timeoutMs?: number;
  /** Injected in tests so a reply shape can be chosen rather than hoped for. */
  fetchImpl?: typeof fetch;
}

/**
 * Reply schemas.
 *
 * A JSON-RPC endpoint is an external party, and one that reshapes its answers —
 * by accident, by version drift, or because someone sits in front of it — used
 * to surface as a raw `TypeError` from `BigInt(undefined)` several frames away
 * from the call. Parsing at the boundary turns that into the same typed
 * UPSTREAM_UNAVAILABLE an unreachable node produces.
 *
 * Amounts stay digit strings so no balance is ever rounded through a double,
 * and a blockhash must really decode to 32 bytes: a transaction compiled around
 * a bogus one is unspendable, and the failure would appear at broadcast time
 * with nothing pointing at the endpoint that caused it.
 */
const rpcEnvelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const lamportsSchema = z.number().int().nonnegative();
const slotSchema = z.number().int().nonnegative();
/** SPL decimals are a u8. */
const decimalsSchema = z.number().int().min(0).max(255);
const amountSchema = z.string().regex(/^\d+$/);
/** A 32-byte base58 value: a blockhash, a genesis hash, a pubkey. */
const hash32Schema = z
  .string()
  .min(32)
  .max(64)
  .refine((value) => base58Length(value) === 32, 'not a 32-byte base58 hash');

const balanceSchema = z.object({ value: lamportsSchema });

const tokenAccountsSchema = z.object({
  value: z.array(
    z.object({
      account: z.object({
        data: z.object({
          parsed: z.object({
            info: z.object({
              tokenAmount: z.object({ amount: amountSchema, decimals: decimalsSchema }),
            }),
          }),
        }),
      }),
    }),
  ),
});

const accountInfoSchema = z.object({
  value: z
    .object({
      owner: z.string().min(1),
      // `jsonParsed` yields an object for accounts a program can decode and the
      // `[data, encoding]` tuple for everything else, including every account
      // fetched with `base64`.
      data: z.union([
        z.object({
          parsed: z
            .object({ info: z.object({ decimals: decimalsSchema.optional() }).optional() })
            .optional(),
        }),
        z.tuple([z.string(), z.string()]),
      ]),
    })
    .nullable(),
});

const signatureStatusesSchema = z.object({
  value: z.array(
    z
      .object({
        slot: slotSchema,
        confirmations: z.number().int().nonnegative().nullish(),
        confirmationStatus: z.string().nullish(),
        err: z.unknown(),
      })
      .nullable(),
  ),
});

const latestBlockhashSchema = z.object({
  value: z.object({ blockhash: hash32Schema, lastValidBlockHeight: slotSchema }),
});

type AccountInfo = z.infer<typeof accountInfoSchema>;

export class SolanaChainAdapter implements ChainAdapter, TransferCapable {
  readonly chain: ChainId = 'solana';
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #log = childLogger('solana-adapter');
  #nextId = 1;

  constructor(options: SolanaAdapterOptions = {}) {
    const endpoint = options.rpcUrl ?? CHAINS.solana.publicRpcUrls[0];
    if (!endpoint) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, 'No Solana RPC endpoint configured');
    }
    this.#endpoint = endpoint;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async health(): Promise<ChainHealth> {
    const started = Date.now();
    try {
      const [genesis, slot] = await Promise.all([
        this.#rpc('getGenesisHash', [], hash32Schema),
        this.#rpc('getSlot', [{ commitment: 'confirmed' }], slotSchema),
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
      // The cause is logged, where the scrubber sees it, and never returned:
      // this string is rendered in the dashboard, stored and sent to Telegram,
      // and a BYOK endpoint carries the provider's key in its URL.
      this.#log.warn({ err: cause }, 'Solana health check failed');
      return {
        chain: this.chain,
        healthy: false,
        height: null,
        latencyMs: Date.now() - started,
        endpoint: this.#endpoint,
        error: `${this.chain} RPC health check failed: ${failureName(cause)}`,
        identity: null,
        identityMatches: false,
      };
    }
  }

  async getNativeBalance(address: string): Promise<Observation<NativeBalance>> {
    assertPubkey(address);
    const result = await this.#rpc(
      'getBalance',
      [address, { commitment: 'confirmed' }],
      balanceSchema,
    );

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
        this.#rpc(
          'getTokenAccountsByOwner',
          [owner, { mint, programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
          tokenAccountsSchema,
        ),
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
    const result = await this.#rpc(
      'getAccountInfo',
      [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      accountInfoSchema,
    );

    const decimals = parsedDecimals(result);

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
    const result = await this.#rpc(
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: true }],
      signatureStatusesSchema,
    );

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
      confirmations: status.confirmations ?? null,
      error: status.err ? JSON.stringify(status.err).slice(0, 200) : null,
    });
  }

  // --- transfers (operator withdrawals) --------------------------------------

  /**
   * Build a SOL or SPL transfer.
   *
   * A token transfer creates the destination's associated token account if it
   * does not exist (idempotently), which costs rent; that rent is read from
   * the chain and included in the fee. The token program is taken from the
   * mint's owner so Token-2022 mints are handled with the right program.
   */
  async prepareTransfer(request: TransferRequest): Promise<PreparedTransfer> {
    assertPubkey(request.from);
    assertPubkey(request.to);
    if (request.amount <= 0n) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Transfer amount must be positive');
    }
    if (request.from === request.to) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Destination is the agent wallet itself');
    }

    const warnings: string[] = [];
    const blockhash = await this.#rpc(
      'getLatestBlockhash',
      [{ commitment: 'confirmed' }],
      latestBlockhashSchema,
    );

    let fee = BigInt(LAMPORTS_PER_SIGNATURE);
    let message: Uint8Array;
    let summary: string;

    if (request.token === null) {
      message = compileLegacyMessage(request.from, blockhash.value.blockhash, [
        systemTransfer(request.from, request.to, request.amount),
      ]);
      summary = `send ${request.amount.toString()} lamports to ${request.to}`;
    } else {
      assertPubkey(request.token);
      const mintInfo = await this.#rpc(
        'getAccountInfo',
        [request.token, { encoding: 'jsonParsed', commitment: 'confirmed' }],
        accountInfoSchema,
      );
      if (!mintInfo.value) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Token mint does not exist');
      }
      const tokenProgram = mintInfo.value.owner;
      if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) {
        throw new AppError(ErrorCode.SCHEMA_INVALID, 'Mint is not owned by a token program');
      }
      const mintDecimals = parsedDecimals(mintInfo);
      if (mintDecimals !== null && mintDecimals !== request.decimals) {
        throw new AppError(ErrorCode.CONFLICT, 'Token decimals disagree with the mint');
      }

      const sourceAta = associatedTokenAddress(request.from, request.token, tokenProgram);
      const destinationAta = associatedTokenAddress(request.to, request.token, tokenProgram);

      const destinationInfo = await this.#rpc(
        'getAccountInfo',
        [destinationAta, { encoding: 'base64', commitment: 'confirmed' }],
        accountInfoSchema,
      );
      if (!destinationInfo.value) {
        const rent = await this.getRentExemptMinimum(TOKEN_ACCOUNT_BYTES);
        fee += rent;
        warnings.push(
          `Destination has no token account; creating one costs ${rent.toString()} lamports of rent.`,
        );
      }

      message = compileLegacyMessage(request.from, blockhash.value.blockhash, [
        createAssociatedTokenAccountIdempotent(
          request.from,
          destinationAta,
          request.to,
          request.token,
          tokenProgram,
        ),
        transferChecked(
          sourceAta,
          request.token,
          destinationAta,
          request.from,
          request.amount,
          request.decimals,
          tokenProgram,
        ),
      ]);
      summary = `transfer ${request.amount.toString()} of ${request.token} to ${request.to}`;
    }

    const payload: SolanaTransferPayload = {
      feePayer: request.from,
      transactionBase64: unsignedTransactionBase64(message),
      lastValidBlockHeight: blockhash.value.lastValidBlockHeight,
    };

    return {
      chain: this.chain,
      payload,
      feeNative: fee.toString(),
      feeSource: 'chain-rpc',
      summary,
      warnings,
    };
  }

  async transferSigningContext(prepared: PreparedTransfer): Promise<SigningContext> {
    const payload = prepared.payload as SolanaTransferPayload;
    return Promise.resolve({
      family: 'solana',
      feePayer: payload.feePayer,
      transactionBase64: payload.transactionBase64,
      lastValidBlockHeight: payload.lastValidBlockHeight,
    });
  }

  async broadcastSigned(signed: SignedTransaction): Promise<void> {
    const reported = await this.#rpc(
      'sendTransaction',
      [
        signed.raw,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        },
      ],
      z.string(),
    );
    if (reported !== signed.hash) {
      throw new AppError(ErrorCode.CONFLICT, 'Node reported a different transaction signature', {
        details: { recorded: signed.hash, reported },
      });
    }
  }

  /** Rent-exempt minimum for an account of `bytes`, queried never hard-coded. */
  async getRentExemptMinimum(bytes: number): Promise<bigint> {
    const lamports = await this.#rpc('getMinimumBalanceForRentExemption', [bytes], lamportsSchema);
    return BigInt(lamports);
  }

  async #rpc<T>(method: string, params: unknown[], schema: z.ZodType<T>): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(this.#endpoint, {
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

      const envelope = rpcEnvelopeSchema.safeParse(await readJsonBounded(response, MAX_BODY_BYTES));
      if (!envelope.success) {
        throw new AppError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          'Solana RPC returned a malformed reply',
          {
            details: { method, issue: envelope.error.issues[0]?.message },
          },
        );
      }

      const payload = envelope.data;
      if (payload.error) {
        throw new AppError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          `Solana RPC error: ${payload.error.message}`,
          {
            details: { method, code: payload.error.code },
          },
        );
      }
      if (payload.result === undefined) {
        throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, 'Solana RPC returned no result', {
          details: { method },
        });
      }

      const parsed = schema.safeParse(payload.result);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new AppError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          `Solana RPC returned an unexpected shape for ${method}`,
          { details: { method, field: issue?.path.join('.'), issue: issue?.message } },
        );
      }

      return parsed.data;
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

/** Decoded byte length of a base58 string, or null when it is not base58. */
function base58Length(value: string): number | null {
  try {
    return base58.decode(value).length;
  } catch {
    return null;
  }
}

/** Mint decimals from a `jsonParsed` account, or null when the node did not say. */
function parsedDecimals(info: AccountInfo): number | null {
  if (!info.value || Array.isArray(info.value.data)) return null;
  return info.value.data.parsed?.info?.decimals ?? null;
}

/**
 * Name a failure without quoting its message.
 *
 * Health results are shown, stored and forwarded, and a library message can
 * carry the endpoint URL — which on a BYOK endpoint is key material.
 */
function failureName(cause: unknown): string {
  if (cause instanceof AppError) return cause.code;
  if (cause instanceof Error) return cause.name;
  return 'unknown error';
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
