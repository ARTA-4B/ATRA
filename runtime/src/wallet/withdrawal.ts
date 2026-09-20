import { randomUUID } from 'node:crypto';
import { isAddress } from 'viem';
import type { Db } from '../db/database.js';
import type { AuditLog } from '../audit/audit.js';
import type { WalletService } from './service.js';
import type { StateStore } from '../core/state.js';
import type { MarketService } from '../market/service.js';
import type { ChainAdapter, PreparedTransfer, SigningContext } from '../chains/types.js';
import { supportsTransfers } from '../chains/types.js';
import type { ChainId } from '../chains/registry.js';
import { CHAINS, chainFamily, isNativeToken } from '../chains/registry.js';
import { assertPubkey } from '../chains/solana/adapter.js';
import { signEvmTransaction } from '../execution/evm/signer.js';
import { signSolanaTransaction } from '../execution/solana/signer.js';
import { microsToUsd, nativeToUsdMicros, priceToAtto } from '../risk/money.js';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';

/**
 * Operator withdrawals: the owner moving their own funds out of the agent
 * wallet.
 *
 * This is not a trade and does not go through the risk engine — the engine
 * limits what the *agent* may do with the operator's money, not what the
 * operator may do with it. It is gated differently:
 *
 *  - a fresh single-use re-authentication token (checked by the route);
 *  - a quote that expires after 90 seconds and is consumed on use;
 *  - typed confirmation (`WITHDRAW`) on every withdrawal, whatever the amount:
 *    the product promise is that money never leaves on a single click, and a
 *    threshold turns that into a promise about most withdrawals;
 *  - a fee that could actually be estimated — a quote with an unknown fee is
 *    returned so the dashboard can show why, but cannot be submitted;
 *  - address validation at least as strict as the dashboard's, including
 *    EIP-55 checksum on mixed-case EVM addresses and the zero address.
 *
 * Withdrawals work in PAPER mode. PAPER stops the agent from signing, not
 * the operator; an operator who wants their funds back should not have to
 * activate LIVE to get them. They also work under emergency stop, for the
 * same reason.
 *
 * Same signing discipline as trades: the hash is written to the row before
 * broadcast, so an interrupted withdrawal is a row with a hash, never a
 * second transaction.
 */

export const WITHDRAW_QUOTE_TTL_MS = 90_000;
/** Above this, the quote says so in a warning; the typed word is required either way. */
export const TYPED_CONFIRMATION_USD = 1_000;
export const WITHDRAW_ASSETS = ['USDC', 'ETH', 'BNB', 'SOL'] as const;
export type WithdrawAsset = (typeof WITHDRAW_ASSETS)[number];

export interface TokenAmountView {
  raw: string;
  decimals: number;
  formatted: string;
  symbol: string;
}

export interface WithdrawQuoteRequest {
  chainId: ChainId;
  asset: WithdrawAsset;
  destination: string;
  /** A decimal amount, or the literal "all". */
  amount: string;
}

export interface WithdrawQuote {
  quoteId: string;
  expiresAt: string;
  chainId: ChainId;
  asset: WithdrawAsset;
  destination: string;
  amount: TokenAmountView;
  availableBalance: TokenAmountView | null;
  fee: { native: TokenAmountView | null; usd: number | null; source: string };
  remainingBalance: TokenAmountView | null;
  /** Always true. Kept as a field so the dashboard reads the rule, not a constant. */
  requiresTypedConfirmation: boolean;
  warnings: string[];
  mode: 'PAPER' | 'LIVE';
  /** False when the quote cannot be submitted (fee unknown, insufficient). */
  submittable: boolean;
}

export interface WithdrawResult {
  txId: string;
  txHash: string | null;
  status: 'submitted' | 'confirmed' | 'failed';
  explorerUrl: string | null;
  activityId: string;
}

interface PendingQuote {
  quote: WithdrawQuote;
  prepared: PreparedTransfer;
  request: {
    from: string;
    to: string;
    token: string | null;
    amount: bigint;
    decimals: number;
    symbol: string;
  };
  createdAt: number;
}

export interface WithdrawalServiceDeps {
  db: Db;
  audit: AuditLog;
  wallets: WalletService;
  state: StateStore;
  market: MarketService;
  adapters: Map<ChainId, ChainAdapter>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const CONFIRM_POLL_MS = 3_000;
const CONFIRM_TIMEOUT_MS = 30_000;

export class WithdrawalService {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #wallets: WalletService;
  readonly #state: StateStore;
  readonly #market: MarketService;
  readonly #adapters: Map<ChainId, ChainAdapter>;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #quotes = new Map<string, PendingQuote>();
  readonly #log = childLogger('withdrawal');

  constructor(deps: WithdrawalServiceDeps) {
    this.#db = deps.db;
    this.#audit = deps.audit;
    this.#wallets = deps.wallets;
    this.#state = deps.state;
    this.#market = deps.market;
    this.#adapters = deps.adapters;
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async quote(input: WithdrawQuoteRequest): Promise<WithdrawQuote> {
    this.#pruneQuotes();
    const chain = input.chainId;
    const info = CHAINS[chain];
    const warnings: string[] = [];

    const destination = validateDestination(chain, input.destination);
    if (chainFamily(chain) === 'evm' && !hasChecksumCase(input.destination)) {
      // A single-case address satisfies every checksum vacuously, so a typo in
      // it cannot be caught. Refusing it would reject what most explorers and
      // wallets copy out; saying so is the honest middle.
      warnings.push('This address has no EIP-55 checksum; verify every character.');
    }
    const token = resolveAsset(chain, input.asset);
    const from = this.#wallets.depositAddress(chain);
    if (destination.toLowerCase() === from.toLowerCase()) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Destination is the agent wallet itself', {
        errors: [{ path: 'destination', message: 'cannot withdraw to the same wallet' }],
      });
    }

    const adapter = this.#adapters.get(chain);
    if (!adapter || !supportsTransfers(adapter)) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, `No transfer adapter for ${chain}`);
    }

    // Balance, read now. A read failure is reported, not zeroed.
    const reading = await this.#wallets.readBalances(chain, token.native ? [] : [token.address]);
    let available: bigint | null = null;
    if (reading.error) {
      warnings.push(`Balance could not be read: ${reading.error}`);
    } else if (token.native) {
      available = reading.native ? BigInt(reading.native.amount) : null;
    } else {
      const entry = reading.tokens.find((row) => row.address === token.address);
      available = entry ? BigInt(entry.amount) : 0n;
    }

    // Amount: explicit, or everything (minus the fee for a native withdrawal).
    let amount: bigint;
    if (input.amount === 'all') {
      if (available === null) {
        throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, 'Cannot withdraw all: balance unknown');
      }
      amount = available;
    } else {
      amount = parseDecimalAmount(input.amount, token.decimals);
    }
    if (amount <= 0n && input.amount !== 'all') {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Amount must be greater than zero', {
        errors: [{ path: 'amount', message: 'must be greater than zero' }],
      });
    }

    // Prepare with a provisional amount so the fee can be estimated; for a
    // native "all" the amount is then reduced by that fee.
    let prepared: PreparedTransfer;
    try {
      prepared = await adapter.prepareTransfer({
        from,
        to: destination,
        token: token.native ? null : token.address,
        amount: amount > 0n ? amount : 1n,
        decimals: token.decimals,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCode.SCHEMA_INVALID) throw error;
      throw new AppError(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        `Could not prepare the transfer: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    warnings.push(...prepared.warnings);

    const feeNative = prepared.feeNative === null ? null : BigInt(prepared.feeNative);
    if (input.amount === 'all' && token.native) {
      if (feeNative === null) {
        throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, 'Cannot withdraw all: fee unknown');
      }
      amount = amount - feeNative;
      if (amount <= 0n) {
        throw new AppError(ErrorCode.CONFLICT, 'Balance does not cover the network fee');
      }
      prepared = await adapter.prepareTransfer({
        from,
        to: destination,
        token: null,
        amount,
        decimals: token.decimals,
      });
    }

    // USD valuation, for the typed-confirmation threshold and the fee line.
    const assetUsd = await this.#priceUsd(
      chain,
      token.native ? info.nativeSentinel : token.address,
    );
    const nativeUsd = token.native ? assetUsd : await this.#priceUsd(chain, info.nativeSentinel);

    const amountUsd = assetUsd
      ? Number(
          microsToUsd(nativeToUsdMicros(amount, token.decimals, priceToAtto(assetUsd), 'ceil')),
        )
      : null;
    const feeUsd =
      feeNative !== null && nativeUsd
        ? Number(
            microsToUsd(
              nativeToUsdMicros(feeNative, info.nativeDecimals, priceToAtto(nativeUsd), 'ceil'),
            ),
          )
        : null;

    // Every withdrawal is typed out in full; the cases that used to decide
    // this now only decide what the operator is warned about.
    if (amountUsd === null) {
      warnings.push('USD value unknown; this withdrawal cannot be checked against a limit.');
    } else if (amountUsd >= TYPED_CONFIRMATION_USD) {
      warnings.push(`This is a large withdrawal: about ${amountUsd.toFixed(2)} USD.`);
    }

    // Sufficiency: token amount, plus gas in native for both cases.
    let submittable = feeNative !== null;
    if (available !== null) {
      const needed = token.native && feeNative !== null ? amount + feeNative : amount;
      if (available < needed) {
        submittable = false;
        warnings.push(
          `Insufficient ${token.symbol} balance: ${formatUnits(available, token.decimals)} available.`,
        );
      }
    } else {
      submittable = false;
    }
    if (!token.native && feeNative !== null && reading.native) {
      if (BigInt(reading.native.amount) < feeNative) {
        submittable = false;
        warnings.push(`Insufficient ${info.nativeSymbol} for the network fee.`);
      }
    }
    if (feeNative === null)
      warnings.push('Network fee unknown; the withdrawal cannot be submitted.');

    const remaining =
      available === null
        ? null
        : token.native && feeNative !== null
          ? available - amount - feeNative
          : available - amount;

    const quoteId = randomUUID();
    const createdAt = this.#now();
    const quote: WithdrawQuote = {
      quoteId,
      expiresAt: new Date(createdAt + WITHDRAW_QUOTE_TTL_MS).toISOString(),
      chainId: chain,
      asset: input.asset,
      destination,
      amount: view(amount, token.decimals, token.symbol),
      availableBalance: available === null ? null : view(available, token.decimals, token.symbol),
      fee: {
        native: feeNative === null ? null : view(feeNative, info.nativeDecimals, info.nativeSymbol),
        usd: feeUsd,
        source: feeNative === null ? 'none' : prepared.feeSource,
      },
      remainingBalance:
        remaining === null || remaining < 0n ? null : view(remaining, token.decimals, token.symbol),
      requiresTypedConfirmation: true,
      warnings,
      mode: this.#state.getMode(),
      submittable,
    };

    this.#quotes.set(quoteId, {
      quote,
      prepared,
      request: {
        from,
        to: destination,
        token: token.native ? null : token.address,
        amount,
        decimals: token.decimals,
        symbol: token.symbol,
      },
      createdAt,
    });

    return quote;
  }

  /**
   * Sign and send a quoted withdrawal.
   *
   * The route has already consumed the re-auth token. `idempotencyKey` is the
   * client's `Idempotency-Key`; a repeat returns the original result.
   */
  async execute(
    input: { quoteId: string; ack: true; confirmation?: string | undefined },
    idempotencyKey: string | undefined,
  ): Promise<WithdrawResult> {
    this.#pruneQuotes();

    if (idempotencyKey) {
      const existing = this.#findByIdempotencyKey(idempotencyKey);
      if (existing) return existing;
    }

    const pending = this.#quotes.get(input.quoteId);
    if (!pending) {
      throw new AppError(ErrorCode.CONFLICT, 'Quote expired or unknown; request a new quote', {
        status: 409,
      });
    }
    if (!pending.quote.submittable) {
      throw new AppError(ErrorCode.CONFLICT, 'This quote cannot be submitted', {
        status: 409,
        details: { warnings: pending.quote.warnings },
      });
    }
    if (input.confirmation !== 'WITHDRAW') {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Type WITHDRAW to confirm this withdrawal', {
        errors: [{ path: 'confirmation', message: 'CONFIRMATION_REQUIRED' }],
      });
    }
    if (!this.#wallets.get(chainFamily(pending.quote.chainId))) {
      throw new AppError(ErrorCode.NOT_FOUND, 'No wallet exists for this chain');
    }

    // Consume the quote before anything is signed: a retry gets a fresh one.
    this.#quotes.delete(input.quoteId);

    const chain = pending.quote.chainId;
    const adapter = this.#adapters.get(chain);
    if (!adapter || !supportsTransfers(adapter)) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, `No transfer adapter for ${chain}`);
    }

    const txId = randomUUID();
    const now = new Date(this.#now()).toISOString();
    const mode = this.#state.getMode();
    this.#db
      .prepare(
        'INSERT INTO wallet_transactions (id, chain, direction, kind, token_address, token_symbol, decimals,' +
          ' amount_base, to_address, from_address, fee_base, fee_usd, status, mode, idempotency_key, created_at, updated_at)' +
          " VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)",
      )
      .run(
        txId,
        chain,
        pending.request.token ? 'token' : 'native',
        pending.request.token,
        pending.request.symbol,
        pending.request.decimals,
        pending.request.amount.toString(),
        pending.request.to,
        pending.request.from,
        pending.prepared.feeNative,
        pending.quote.fee.usd === null ? null : pending.quote.fee.usd.toFixed(6),
        mode,
        idempotencyKey ?? null,
        now,
        now,
      );

    let context: SigningContext;
    try {
      context = await adapter.transferSigningContext(pending.prepared);
    } catch (error) {
      return this.#fail(txId, chain, `prepare failed: ${errorMessage(error)}`, null);
    }

    let signed: { raw: string; hash: string };
    try {
      signed = this.#wallets.useSigningKey(chain, (secret, address) => {
        if (context.family === 'evm') {
          const result = signEvmTransaction(
            secret,
            {
              chainId: context.chainId,
              nonce: context.nonce,
              to: context.to as `0x${string}`,
              data: context.data as `0x${string}`,
              value: BigInt(context.value),
              gas: BigInt(context.gas),
              maxFeePerGas: BigInt(context.maxFeePerGas),
              maxPriorityFeePerGas: BigInt(context.maxPriorityFeePerGas),
            },
            address,
          );
          return { raw: result.raw, hash: result.hash };
        }
        const result = signSolanaTransaction(secret, context.transactionBase64, address);
        return { raw: result.raw, hash: result.signature };
      });
    } catch (error) {
      return this.#fail(txId, chain, `signing failed: ${errorMessage(error)}`, null);
    }

    // Hash on disk before the network sees the transaction.
    this.#db
      .prepare(
        "UPDATE wallet_transactions SET tx_hash = ?, status = 'simulated', updated_at = ? WHERE id = ?",
      )
      .run(signed.hash, new Date(this.#now()).toISOString(), txId);

    try {
      await adapter.broadcastSigned(signed);
    } catch (error) {
      // State unknown: the row keeps its hash, the operator sees the error.
      return this.#fail(txId, chain, `broadcast failed: ${errorMessage(error)}`, signed.hash);
    }

    this.#db
      .prepare("UPDATE wallet_transactions SET status = 'submitted', updated_at = ? WHERE id = ?")
      .run(new Date(this.#now()).toISOString(), txId);

    const activityId = this.#audit.append({
      category: 'wallet',
      action: 'wallet.withdraw',
      status: 'ok',
      summary: `Withdrawal submitted: ${pending.quote.amount.formatted} ${pending.request.symbol} to ${pending.request.to}`,
      chain,
      actor: 'operator',
      mode,
      correlationId: txId,
      detail: {
        txId,
        txHash: signed.hash,
        amount: pending.request.amount.toString(),
        destination: pending.request.to,
        feeNative: pending.prepared.feeNative,
      },
    });

    const status = await this.#awaitConfirmation(adapter, signed.hash);
    if (status !== 'submitted') {
      this.#db
        .prepare('UPDATE wallet_transactions SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, new Date(this.#now()).toISOString(), txId);
    }

    return {
      txId,
      txHash: signed.hash,
      status,
      explorerUrl: explorerUrl(chain, signed.hash),
      activityId,
    };
  }

  list(limit = 50): WithdrawResult[] {
    return this.#db
      .prepare<[number], TxRow>(
        "SELECT * FROM wallet_transactions WHERE direction = 'out' ORDER BY created_at DESC LIMIT ?",
      )
      .all(Math.min(Math.max(limit, 1), 200))
      .map(toResult);
  }

  /** Refresh a submitted withdrawal against the chain. */
  async refresh(txId: string): Promise<WithdrawResult | undefined> {
    const row = this.#db
      .prepare<[string], TxRow>('SELECT * FROM wallet_transactions WHERE id = ?')
      .get(txId);
    if (!row) return undefined;
    if (row.status !== 'submitted' || !row.tx_hash) return toResult(row);
    const adapter = this.#adapters.get(row.chain);
    if (!adapter) return toResult(row);
    try {
      const status = await adapter.getTransactionStatus(row.tx_hash);
      const next =
        status.value.state === 'confirmed'
          ? 'confirmed'
          : status.value.state === 'failed'
            ? 'failed'
            : null;
      if (next) {
        this.#db
          .prepare('UPDATE wallet_transactions SET status = ?, updated_at = ? WHERE id = ?')
          .run(next, new Date(this.#now()).toISOString(), txId);
      }
    } catch (error) {
      this.#log.warn({ txId, err: error }, 'withdrawal refresh failed');
    }
    return toResult(
      this.#db
        .prepare<[string], TxRow>('SELECT * FROM wallet_transactions WHERE id = ?')
        .get(txId)!,
    );
  }

  async #awaitConfirmation(adapter: ChainAdapter, hash: string): Promise<WithdrawResult['status']> {
    const deadline = this.#now() + CONFIRM_TIMEOUT_MS;
    while (this.#now() < deadline) {
      try {
        const status = await adapter.getTransactionStatus(hash);
        if (status.value.state === 'confirmed') return 'confirmed';
        if (status.value.state === 'failed') return 'failed';
      } catch (error) {
        this.#log.warn({ hash, err: error }, 'confirmation poll failed');
      }
      await this.#sleep(CONFIRM_POLL_MS);
    }
    return 'submitted';
  }

  #fail(txId: string, chain: ChainId, reason: string, txHash: string | null): WithdrawResult {
    this.#db
      .prepare(
        "UPDATE wallet_transactions SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
      )
      .run(reason.slice(0, 500), new Date(this.#now()).toISOString(), txId);
    const activityId = this.#audit.append({
      category: 'wallet',
      action: 'wallet.withdraw',
      status: 'failed',
      summary: `Withdrawal failed: ${reason}`,
      chain,
      actor: 'operator',
      mode: this.#state.getMode(),
      correlationId: txId,
      detail: { txId, ...(txHash ? { txHash, unresolved: true } : {}) },
    });
    return {
      txId,
      txHash,
      status: 'failed',
      explorerUrl: txHash ? explorerUrl(chain, txHash) : null,
      activityId,
    };
  }

  #findByIdempotencyKey(key: string): WithdrawResult | undefined {
    const row = this.#db
      .prepare<[string], TxRow>('SELECT * FROM wallet_transactions WHERE idempotency_key = ?')
      .get(key);
    return row ? toResult(row) : undefined;
  }

  #priceUsd(chain: ChainId, token: string): Promise<string | null> {
    return this.#market
      .getCrossCheckedPrice(chain, token)
      .then((result) => (result.priceUsd !== null && !result.disputed ? result.priceUsd : null))
      .catch(() => null);
  }

  #pruneQuotes(): void {
    const now = this.#now();
    for (const [id, pending] of this.#quotes) {
      if (now - pending.createdAt > WITHDRAW_QUOTE_TTL_MS) this.#quotes.delete(id);
    }
  }
}

interface TxRow {
  id: string;
  chain: ChainId;
  tx_hash: string | null;
  status: 'prepared' | 'simulated' | 'submitted' | 'confirmed' | 'failed' | 'cancelled';
  created_at: string;
}

function toResult(row: TxRow): WithdrawResult {
  const status: WithdrawResult['status'] =
    row.status === 'confirmed'
      ? 'confirmed'
      : row.status === 'failed' || row.status === 'cancelled'
        ? 'failed'
        : 'submitted';
  return {
    txId: row.id,
    txHash: row.tx_hash,
    status,
    explorerUrl: row.tx_hash ? explorerUrl(row.chain, row.tx_hash) : null,
    activityId: row.id,
  };
}

function explorerUrl(chain: ChainId, hash: string): string {
  return `${CHAINS[chain].explorerUrl}/tx/${hash}`;
}

/**
 * Destination validation. EVM: 40 hex, not the zero address, and when the
 * address is mixed-case it must be a valid EIP-55 checksum. Solana: a base58
 * 32-byte key.
 */
export function validateDestination(chain: ChainId, destination: string): string {
  const family = chainFamily(chain);
  if (family === 'evm') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) {
      throw invalidAddress('must be a 0x-prefixed 40-hex address');
    }
    if (/^0x0{40}$/.test(destination)) {
      throw invalidAddress('the zero address burns funds');
    }
    if (hasChecksumCase(destination) && !isAddress(destination, { strict: true })) {
      throw invalidAddress('EIP-55 checksum does not match');
    }
    return destination.toLowerCase();
  }
  try {
    assertPubkey(destination);
  } catch {
    throw invalidAddress('must be a base58 Solana public key');
  }
  return destination;
}

/**
 * True when an EVM address carries the case information EIP-55 encodes. An
 * all-lowercase or all-uppercase address has no checksum to verify.
 */
function hasChecksumCase(address: string): boolean {
  const body = address.slice(2);
  return body !== body.toLowerCase() && body !== body.toUpperCase();
}

function invalidAddress(message: string): AppError {
  return new AppError(ErrorCode.SCHEMA_INVALID, `Invalid destination: ${message}`, {
    errors: [{ path: 'destination', message: 'INVALID_ADDRESS' }],
  });
}

function resolveAsset(
  chain: ChainId,
  asset: WithdrawAsset,
): { address: string; decimals: number; symbol: string; native: boolean } {
  const info = CHAINS[chain];
  if (asset === info.nativeSymbol) {
    return {
      address: info.nativeSentinel,
      decimals: info.nativeDecimals,
      symbol: info.nativeSymbol,
      native: true,
    };
  }
  const token = info.tokens.find(
    (entry) => entry.symbol === asset && !isNativeToken(chain, entry.address),
  );
  if (!token) {
    throw new AppError(
      ErrorCode.SCHEMA_INVALID,
      `${asset} is not available on ${info.displayName}`,
      {
        errors: [{ path: 'asset', message: 'unsupported on this chain' }],
      },
    );
  }
  return { address: token.address, decimals: token.decimals, symbol: token.symbol, native: false };
}

/** "25", "0.5" → base units. Refuses more decimals than the token has. */
export function parseDecimalAmount(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Amount must be a decimal number', {
      errors: [{ path: 'amount', message: 'must be a decimal number' }],
    });
  }
  const whole = match[1]!;
  const frac = match[2] ?? '';
  if (frac.length > decimals) {
    throw new AppError(
      ErrorCode.SCHEMA_INVALID,
      `Amount has more than ${String(decimals)} decimals`,
      {
        errors: [{ path: 'amount', message: 'too many decimals' }],
      },
    );
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

function view(amount: bigint, decimals: number, symbol: string): TokenAmountView {
  return { raw: amount.toString(), decimals, formatted: formatUnits(amount, decimals), symbol };
}
