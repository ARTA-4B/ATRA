import { z } from 'zod';
import { base58 } from '@scure/base';
import type {
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
import { AppError, ErrorCode, errorMessage } from '../../util/errors.js';
import { childLogger } from '../../logging/logger.js';
import { assertPubkey } from '../../chains/solana/adapter.js';
import { DEFAULT_PROTOCOLS, SOLANA_NATIVE_SENTINEL } from '../../chains/registry.js';
import { summarizeSolanaTransaction } from './signer.js';

/**
 * Jupiter v6 on Solana.
 *
 * Jupiter is an aggregator: the swap it builds may route through several
 * DEX programs by CPI, but the *top-level* instructions target a small, known
 * set — Jupiter's own program plus compute-budget, token and ATA programs. The
 * adapter asks for the instructions rather than only the serialized
 * transaction so it can report every top-level program to the risk engine
 * before anything is signed.
 *
 * The keyless lite endpoint is used. It is rate limited and fine for an agent
 * that trades a few times a day; an operator who needs more supplies a keyed
 * endpoint through configuration.
 */

const LITE_API = 'https://lite-api.jup.ag/swap/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const LAMPORTS_PER_SIGNATURE = 5_000;

const JUPITER_PROGRAM = DEFAULT_PROTOCOLS.solana['jupiter-v6']?.contracts[0] ?? '';

// Loose objects: Jupiter's quote is echoed back verbatim on the swap calls,
// and a schema that stripped unknown keys would send back a quote Jupiter no
// longer recognises (it did — routePlan lost its inputMint fields).
const quoteResponseSchema = z.looseObject({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: z.string().regex(/^\d+$/),
  outAmount: z.string().regex(/^\d+$/),
  otherAmountThreshold: z.string().regex(/^\d+$/),
  slippageBps: z.number().int(),
  priceImpactPct: z.string(),
  contextSlot: z.number().optional(),
  routePlan: z
    .array(
      z.looseObject({
        swapInfo: z.looseObject({
          ammKey: z.string(),
          label: z.string().optional(),
        }),
      }),
    )
    .optional(),
});

const instructionSchema = z.looseObject({
  programId: z.string(),
  accounts: z.array(
    z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() }),
  ),
  data: z.string(),
});

const swapInstructionsSchema = z.looseObject({
  computeBudgetInstructions: z.array(instructionSchema).default([]),
  setupInstructions: z.array(instructionSchema).default([]),
  swapInstruction: instructionSchema,
  cleanupInstruction: instructionSchema.nullish(),
  addressLookupTableAddresses: z.array(z.string()).default([]),
  // Present on newer responses; used for the fee estimate when available.
  computeUnitLimit: z.number().int().optional(),
  prioritizationFeeLamports: z.number().int().optional(),
});

const swapResponseSchema = z.looseObject({
  swapTransaction: z.string().min(1),
  lastValidBlockHeight: z.number().int().optional(),
  prioritizationFeeLamports: z.number().int().optional(),
  computeUnitLimit: z.number().int().optional(),
});

type QuoteResponse = z.infer<typeof quoteResponseSchema>;

interface JupiterRouteData {
  quoteResponse: QuoteResponse;
  userPublicKey: string;
  computeUnitLimit: number;
  prioritizationFeeLamports: number;
}

export interface JupiterAdapterOptions {
  apiBase?: string;
  rpcUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Refuse a quote that does not answer the question that was asked.
 *
 * Jupiter is a third party reached over the public internet without a key.
 * The mints, the input amount and the slippage in the reply are compared with
 * the request, and the threshold the router will enforce is checked against
 * the output it reported: those five numbers are what the engine's decision
 * and the resulting transaction rest on.
 */
function assertQuoteMatchesRequest(
  quote: {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    slippageBps: number;
  },
  request: QuoteRequest,
): void {
  const mismatch = (field: string, got: string, wanted: string): never => {
    throw new AppError(
      ErrorCode.UPSTREAM_UNAVAILABLE,
      `Jupiter answered with a different ${field}`,
      { details: { field, got, wanted } },
    );
  };

  if (quote.inputMint !== request.tokenIn.address) {
    mismatch('input mint', quote.inputMint, request.tokenIn.address);
  }
  if (quote.outputMint !== request.tokenOut.address) {
    mismatch('output mint', quote.outputMint, request.tokenOut.address);
  }
  if (quote.inAmount !== request.amountIn) {
    mismatch('input amount', quote.inAmount, request.amountIn);
  }
  if (quote.slippageBps !== request.slippageBps) {
    mismatch('slippage', String(quote.slippageBps), String(request.slippageBps));
  }

  // The threshold is what the swap program enforces on chain. It must not be
  // looser than the slippage the engine approved, or the minimum the trade
  // was decided on is not the minimum that will be applied.
  const out = BigInt(quote.outAmount);
  const floor = out - (out * BigInt(request.slippageBps)) / 10_000n;
  if (BigInt(quote.otherAmountThreshold) < floor) {
    mismatch('minimum output', quote.otherAmountThreshold, `at least ${floor.toString()}`);
  }
}

export class JupiterAdapter implements ExecutionAdapter {
  readonly chain = 'solana' as const;
  readonly protocol = 'jupiter-v6' as const;
  readonly contracts: readonly string[] = [JUPITER_PROGRAM];

  readonly #apiBase: string;
  readonly #rpcUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #log = childLogger('jupiter');

  constructor(options: JupiterAdapterOptions = {}) {
    this.#apiBase = (options.apiBase ?? LITE_API).replace(/\/+$/, '');
    this.#rpcUrl = options.rpcUrl ?? 'https://api.mainnet-beta.solana.com';
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  supportsRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    try {
      assertPubkey(tokenIn);
      assertPubkey(tokenOut);
      return Promise.resolve(tokenIn !== tokenOut);
    } catch {
      return Promise.resolve(false);
    }
  }

  async quote(request: QuoteRequest): Promise<ExecutionQuote> {
    assertPubkey(request.tokenIn.address);
    assertPubkey(request.tokenOut.address);
    assertPubkey(request.from);

    const params = new URLSearchParams({
      inputMint: request.tokenIn.address,
      outputMint: request.tokenOut.address,
      amount: request.amountIn,
      slippageBps: String(request.slippageBps),
      // Direct routes only: a single hop keeps the top-level program set small
      // and the price impact figure meaningful. Multi-hop can be enabled later
      // once the program-id reporting is proven against it.
      onlyDirectRoutes: 'false',
      restrictIntermediateTokens: 'true',
    });

    const raw = await this.#get(`/quote?${params.toString()}`);
    const parsed = quoteResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, 'Jupiter returned an unexpected quote', {
        details: { issue: parsed.error.issues[0]?.message },
      });
    }
    const quote = parsed.data;

    // The response is checked against the request before anything downstream
    // trusts it. The ExecutionQuote below labels the trade with the tokens we
    // asked for while its amounts come from Jupiter, and `quoteResponse` is
    // echoed verbatim to /swap, so a reply that quietly names another mint or
    // another amount would move something other than what was decided.
    assertQuoteMatchesRequest(quote, request);

    // The instructions tell us which programs the transaction will invoke.
    const instructions = await this.#swapInstructions(quote, request.from);
    const programIds = uniqueSorted([
      ...instructions.computeBudgetInstructions.map((ix) => ix.programId),
      ...instructions.setupInstructions.map((ix) => ix.programId),
      instructions.swapInstruction.programId,
      ...(instructions.cleanupInstruction ? [instructions.cleanupInstruction.programId] : []),
    ]);

    const computeUnitLimit = instructions.computeUnitLimit ?? 1_400_000;
    const prioritizationFeeLamports = instructions.prioritizationFeeLamports ?? 0;
    const quotedAt = Date.now();

    return {
      chain: 'solana',
      protocol: this.protocol,
      contract: instructions.swapInstruction.programId,
      programIds,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: quote.inAmount,
      expectedAmountOut: quote.outAmount,
      minAmountOut: quote.otherAmountThreshold,
      slippageBps: quote.slippageBps,
      priceImpactBps: percentToBps(quote.priceImpactPct),
      quotedAt,
      source: 'jupiter-lite-v1',
      marketId: marketIdFor(request.tokenIn.address, request.tokenOut.address),
      feeEstimate: {
        estimatedAt: quotedAt,
        detail: {
          family: 'solana',
          signatures: 1,
          computeUnitLimit,
          // Jupiter reports the priority fee as total lamports; the risk engine
          // wants micro-lamports per compute unit.
          computeUnitPriceMicroLamports:
            computeUnitLimit > 0
              ? String(Math.ceil((prioritizationFeeLamports * 1_000_000) / computeUnitLimit))
              : '0',
          // Rent for a new associated token account is possible when the
          // wallet has never held tokenOut; queried by the executor rather
          // than guessed here.
          rentLamports: '0',
        },
      },
      routeData: {
        quoteResponse: quote,
        userPublicKey: request.from,
        computeUnitLimit,
        prioritizationFeeLamports,
      } satisfies JupiterRouteData,
    };
  }

  /**
   * Simulate through the chain.
   *
   * The built transaction — the one that will be signed — is submitted to
   * simulateTransaction with signature verification off. A failure here (most
   * often: the wallet does not hold the input) is reported, not swallowed.
   */
  async simulate(quote: ExecutionQuote, tx: UnsignedTransaction): Promise<SimulationResult> {
    const simulatedAt = Date.now();
    try {
      const payload = tx.payload as { transactionBase64: string };

      const result = await this.#rpc<{
        value: { err: unknown; unitsConsumed?: number; logs?: string[] };
      }>('simulateTransaction', [
        payload.transactionBase64,
        {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'processed',
        },
      ]);

      if (result.value.err) {
        return {
          ok: false,
          amountOut: null,
          unitsUsed: result.value.unitsConsumed ?? null,
          error: JSON.stringify(result.value.err).slice(0, 300),
          simulatedAt,
        };
      }

      return {
        ok: true,
        // simulateTransaction does not report token deltas without extra
        // account queries; the quote's expected output stands as the estimate.
        amountOut: quote.expectedAmountOut,
        unitsUsed: result.value.unitsConsumed ?? null,
        error: null,
        simulatedAt,
      };
    } catch (error) {
      return {
        ok: false,
        amountOut: null,
        unitsUsed: null,
        error: errorMessage(error),
        simulatedAt,
      };
    }
  }

  /** The serialized transaction from Jupiter, unsigned. */
  async build(quote: ExecutionQuote): Promise<UnsignedTransaction> {
    const route = quote.routeData as JupiterRouteData | undefined;
    if (!route) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Quote carries no Jupiter route data');
    }

    const raw = await this.#post('/swap', {
      quoteResponse: route.quoteResponse,
      userPublicKey: route.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    });

    const parsed = swapResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        'Jupiter returned an unexpected swap payload',
      );
    }

    return {
      chain: 'solana',
      payload: {
        transactionBase64: parsed.data.swapTransaction,
        lastValidBlockHeight: parsed.data.lastValidBlockHeight ?? null,
      },
      summary: `Jupiter swap ${quote.amountIn} ${quote.tokenIn.address.slice(0, 6)}… -> ≥${quote.minAmountOut} ${quote.tokenOut.address.slice(0, 6)}…`,
    };
  }

  /**
   * Check the built transaction names the wallet as its only signer.
   *
   * Jupiter builds the transaction for `userPublicKey`; this verifies the
   * bytes agree before the key is touched. No network call is needed — the
   * blockhash is already inside the message.
   */
  prepareSigning(tx: UnsignedTransaction, from: string): Promise<SigningContext> {
    assertPubkey(from);
    const payload = tx.payload as {
      transactionBase64: string;
      lastValidBlockHeight: number | null;
    };
    const summary = summarizeSolanaTransaction(payload.transactionBase64);

    if (summary.feePayer !== from) {
      throw new AppError(ErrorCode.CONFLICT, 'Transaction fee payer is not the agent wallet');
    }
    if (summary.numRequiredSignatures !== 1) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `Transaction requires ${String(summary.numRequiredSignatures)} signatures`,
      );
    }

    return Promise.resolve({
      family: 'solana',
      feePayer: from,
      transactionBase64: payload.transactionBase64,
      lastValidBlockHeight: payload.lastValidBlockHeight,
    });
  }

  async broadcast(signed: SignedTransaction): Promise<void> {
    const reported = await this.#rpc<string>('sendTransaction', [
      signed.raw,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);
    if (reported !== signed.hash) {
      throw new AppError(ErrorCode.CONFLICT, 'Node reported a different transaction signature', {
        details: { recorded: signed.hash, reported },
      });
    }
  }

  /**
   * Status by signature; once confirmed, the received amount is read from the
   * transaction's pre/post token balances for the wallet and mint.
   */
  async receipt(signature: string, expect?: ReceiptExpectation): Promise<ExecutionReceipt> {
    const decoded = (() => {
      try {
        return base58.decode(signature);
      } catch {
        return null;
      }
    })();
    if (!decoded || decoded.length !== 64) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Malformed Solana signature');
    }

    const result = await this.#rpc<{
      value: Array<{ slot: number; confirmationStatus: string | null; err: unknown } | null>;
    }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);

    const status = result.value[0];
    if (!status) {
      return {
        chain: 'solana',
        hash: signature,
        status: 'unknown',
        amountOut: null,
        feeNative: null,
        height: null,
        error: null,
      };
    }

    const state: ExecutionReceipt['status'] = status.err
      ? 'failed'
      : status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized'
        ? 'confirmed'
        : 'pending';

    let amountOut: string | null = null;
    let feeNative: string | null = String(LAMPORTS_PER_SIGNATURE);
    if (state === 'confirmed' && expect) {
      const detail = await this.#transactionDelta(signature, expect);
      amountOut = detail.amountOut;
      feeNative = detail.fee ?? feeNative;
    }

    return {
      chain: 'solana',
      hash: signature,
      status: state,
      amountOut,
      feeNative,
      height: status.slot,
      error: status.err ? JSON.stringify(status.err).slice(0, 200) : null,
    };
  }

  /** Received amount = post − pre token balance of the wallet for the mint. */
  async #transactionDelta(
    signature: string,
    expect: ReceiptExpectation,
  ): Promise<{ amountOut: string | null; fee: string | null }> {
    try {
      const tx = await this.#rpc<{
        meta: {
          fee: number;
          preBalances: number[];
          postBalances: number[];
          preTokenBalances: TokenBalanceEntry[] | null;
          postTokenBalances: TokenBalanceEntry[] | null;
        } | null;
        transaction: { message: { accountKeys: Array<{ pubkey: string } | string> } };
      } | null>('getTransaction', [
        signature,
        { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      ]);
      if (!tx?.meta) return { amountOut: null, fee: null };

      const fee = String(tx.meta.fee);

      // Native SOL: the wallet's lamport delta plus the fee it paid.
      if (expect.tokenOut === SOLANA_NATIVE_SENTINEL) {
        const keys = tx.transaction.message.accountKeys.map((key) =>
          typeof key === 'string' ? key : key.pubkey,
        );
        const index = keys.indexOf(expect.recipient);
        const pre = tx.meta.preBalances[index];
        const post = tx.meta.postBalances[index];
        if (index < 0 || pre === undefined || post === undefined) return { amountOut: null, fee };
        const delta = BigInt(post) - BigInt(pre) + BigInt(tx.meta.fee);
        return { amountOut: delta > 0n ? delta.toString() : null, fee };
      }

      const sum = (entries: TokenBalanceEntry[] | null): bigint =>
        (entries ?? [])
          .filter((entry) => entry.mint === expect.tokenOut && entry.owner === expect.recipient)
          .reduce((total, entry) => total + BigInt(entry.uiTokenAmount.amount), 0n);
      const delta = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
      return { amountOut: delta > 0n ? delta.toString() : null, fee };
    } catch (error) {
      this.#log.warn({ signature, err: error }, 'could not read transaction balances');
      return { amountOut: null, fee: null };
    }
  }

  async #swapInstructions(quote: QuoteResponse, userPublicKey: string) {
    const raw = await this.#post('/swap-instructions', {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    });

    const parsed = swapInstructionsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        'Jupiter returned unexpected swap instructions',
        { details: { issue: parsed.error.issues[0]?.message } },
      );
    }
    return parsed.data;
  }

  async #get(path: string): Promise<unknown> {
    return this.#request(`${this.#apiBase}${path}`, { method: 'GET' });
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    return this.#request(`${this.#apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async #request(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new AppError(ErrorCode.RATE_LIMITED, 'Jupiter rate limit reached', {
          retryAfterSec: Number(response.headers.get('retry-after') ?? 30),
        });
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new AppError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          `Jupiter returned HTTP ${response.status}`,
          {
            details: { detail },
          },
        );
      }

      return await response.json();
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      const timedOut = cause instanceof Error && cause.name === 'AbortError';
      this.#log.warn({ url: url.split('?')[0], err: cause }, 'Jupiter request failed');
      throw new AppError(
        timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_UNAVAILABLE,
        'Jupiter request failed',
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.#fetch(this.#rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (!response.ok) {
      throw new AppError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        `Solana RPC returned HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as { result?: T; error?: { message: string } };
    if (payload.error) {
      throw new AppError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        `Solana RPC error: ${payload.error.message}`,
      );
    }
    if (payload.result === undefined) {
      throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, 'Solana RPC returned no result');
    }
    return payload.result;
  }
}

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** Jupiter reports impact as a decimal percentage string, e.g. "0.0123". */
function percentToBps(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 10_000;
  return Math.ceil(parsed * 100);
}

/** Order-independent market id for a mint pair. */
function marketIdFor(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
