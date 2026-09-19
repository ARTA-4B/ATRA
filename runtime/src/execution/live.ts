import type {
  ExecutionAdapter,
  ExecutionOutcome,
  ExecutionQuote,
  ExecutionReceipt,
  SignedTransaction,
  SigningContext,
  UnsignedTransaction,
} from './types.js';
import type { ProposedAction } from '../risk/types.js';
import type { LedgerService } from '../trading/ledger.js';
import type { TradeRecord, TradeStore } from '../trading/trades.js';
import type { RiskGate } from '../risk/gate.js';
import type { AuditLog } from '../audit/audit.js';
import type { WalletService } from '../wallet/service.js';
import type { StateStore } from '../core/state.js';
import type { ExecutionRegistry } from './registry.js';
import { signEvmTransaction } from './evm/signer.js';
import { signSolanaTransaction } from './solana/signer.js';
import { microsToUsd, nativeToUsdMicros, priceToAtto } from '../risk/money.js';
import { CHAINS } from '../chains/registry.js';
import { childLogger } from '../logging/logger.js';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';

/**
 * The LIVE executor: the only code in the runtime that signs and broadcasts.
 *
 * Order of operations, and why it is this order:
 *
 *  1. **Refuse** unless the runtime is LIVE, not paused, not stopped, and the
 *     vault is unlocked — checked here again, after the risk engine, because
 *     the state can change between the decision and this call.
 *  2. **Simulate** on the chain. A revert here costs nothing; on-chain it
 *     costs gas and a cooldown.
 *  3. **Build** the transaction and fetch nonce and fee caps.
 *  4. **Sign** inside the vault's synchronous callback. The key exists in
 *     memory for the duration of one ECDSA/ed25519 operation.
 *  5. **Record the hash** in the trade row, `signed` state, before anything is
 *     sent. A crash after this point leaves a row that names its transaction;
 *     the next start asks the chain whether it landed instead of signing
 *     again.
 *  6. **Broadcast**, then poll the receipt for a bounded time.
 *  7. **Book** the fill from what the chain reports — the received amount is
 *     read from transfer logs or balance deltas, never taken from the quote.
 *
 * Nothing in this file consults a model, and there is no parameter by which a
 * caller can supply calldata: the transaction comes from the adapter that
 * produced the quote the engine approved.
 */

const RECEIPT_POLL_MS = 3_000;
const RECEIPT_TIMEOUT_MS = 90_000;

export interface LiveExecutorDeps {
  ledger: LedgerService;
  trades: TradeStore;
  gate: RiskGate;
  audit: AuditLog;
  wallets: WalletService;
  state: StateStore;
  registry: ExecutionRegistry;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LivePrices {
  tokenInUsd: string;
  tokenOutUsd: string;
  nativeUsd: string;
}

export interface ReconcileReport {
  checked: number;
  filled: number;
  failed: number;
  stillPending: number;
  cancelled: number;
}

export class LiveExecutor {
  readonly #ledger: LedgerService;
  readonly #trades: TradeStore;
  readonly #gate: RiskGate;
  readonly #audit: AuditLog;
  readonly #wallets: WalletService;
  readonly #state: StateStore;
  readonly #registry: ExecutionRegistry;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log = childLogger('live-executor');

  constructor(deps: LiveExecutorDeps) {
    this.#ledger = deps.ledger;
    this.#trades = deps.trades;
    this.#gate = deps.gate;
    this.#audit = deps.audit;
    this.#wallets = deps.wallets;
    this.#state = deps.state;
    this.#registry = deps.registry;
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Execute an allowed swap. */
  async execute(
    tradeId: string,
    action: ProposedAction,
    quote: ExecutionQuote,
    prices: LivePrices,
  ): Promise<ExecutionOutcome> {
    const startedAt = this.#now();
    const adapter = this.#registry.get(action.chain);
    if (!adapter) {
      return this.#fail(tradeId, action, `no execution adapter for ${action.chain}`, startedAt);
    }

    const refusal = this.#refusal(action);
    if (refusal) return this.#fail(tradeId, action, refusal, startedAt);

    // Dispatch: cooldowns start now, for a live trade exactly as for paper.
    this.#trades.markDispatched(tradeId);
    this.#gate.markDispatched(action);

    const simulation = await adapter.simulate(quote);
    if (!simulation.ok) {
      return this.#fail(
        tradeId,
        action,
        `simulation failed: ${simulation.error ?? 'unknown'}`,
        startedAt,
      );
    }

    let tx: UnsignedTransaction;
    try {
      tx = await adapter.build(quote);
    } catch (error) {
      return this.#fail(tradeId, action, `build failed: ${errorMessage(error)}`, startedAt);
    }

    return this.#signAndSend(tradeId, action, adapter, tx, {
      tokenOut: action.tokenOut.address,
      prices,
    });
  }

  /** Execute an allowed ERC-20 approval. Nothing is booked in the ledger. */
  async executeApprove(
    tradeId: string,
    action: ProposedAction,
    tx: UnsignedTransaction,
    nativeUsd: string,
  ): Promise<ExecutionOutcome> {
    const startedAt = this.#now();
    const adapter = this.#registry.get(action.chain);
    if (!adapter) {
      return this.#fail(tradeId, action, `no execution adapter for ${action.chain}`, startedAt);
    }
    const refusal = this.#refusal(action);
    if (refusal) return this.#fail(tradeId, action, refusal, startedAt);

    this.#trades.markDispatched(tradeId);
    this.#gate.markDispatched(action);

    return this.#signAndSend(tradeId, action, adapter, tx, {
      tokenOut: null,
      prices: { tokenInUsd: '0', tokenOutUsd: '0', nativeUsd },
    });
  }

  /**
   * Resolve rows left in flight by a previous process.
   *
   * `dispatched` rows never reached the signer: failed. `signed` and
   * `broadcast` rows name a hash: the chain decides. A row whose transaction
   * is still unknown to the chain after the poll stays as it is, and the
   * report says so; nothing is re-signed.
   */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      checked: 0,
      filled: 0,
      failed: 0,
      stillPending: 0,
      cancelled: 0,
    };

    for (const trade of this.#trades.listInFlight()) {
      report.checked += 1;

      if (trade.status === 'dispatched') {
        this.#trades.markFailed(trade.id, 'runtime restarted before the transaction was signed');
        report.failed += 1;
        continue;
      }

      if (!trade.txHash) {
        this.#trades.markFailed(trade.id, `row in ${trade.status} without a transaction hash`);
        report.failed += 1;
        continue;
      }

      const adapter = this.#registry.get(trade.chain);
      if (!adapter) {
        report.stillPending += 1;
        continue;
      }

      const receipt = await adapter
        .receipt(trade.txHash, {
          tokenOut: trade.tokenOut,
          recipient: this.#walletFor(trade.chain),
        })
        .catch((error: unknown) => {
          this.#log.warn({ tradeId: trade.id, err: error }, 'reconcile receipt failed');
          return null;
        });

      if (!receipt || receipt.status === 'pending' || receipt.status === 'unknown') {
        report.stillPending += 1;
        continue;
      }

      // The chain has it, so it was broadcast, whatever the row says.
      if (trade.status === 'signed') this.#trades.markBroadcast(trade.id);

      if (receipt.status === 'failed') {
        this.#trades.markFailed(trade.id, receipt.error ?? 'transaction failed on chain');
        report.failed += 1;
        this.#audit.append({
          category: 'trade',
          action: 'trade.reconciled',
          status: 'failed',
          summary: `Reconciled ${trade.txHash.slice(0, 12)}… after restart: failed on chain`,
          chain: trade.chain,
          actor: 'system',
          mode: 'LIVE',
          correlationId: trade.decisionCycleId,
          detail: { tradeId: trade.id, txHash: trade.txHash },
        });
        continue;
      }

      // Confirmed. Prices at fill time are unknown after a restart, so the
      // fill is booked with what the chain reports and zero USD prices, and
      // the audit row says the valuation is missing rather than inventing one.
      this.#bookFill(
        trade,
        receipt,
        {
          tokenInUsd: '0',
          tokenOutUsd: '0',
          nativeUsd: '0',
        },
        'reconciled after restart; fill-time prices unavailable',
      );
      report.filled += 1;
    }

    return report;
  }

  #refusal(action: ProposedAction): string | null {
    if (action.mode !== 'LIVE') return `action mode ${action.mode} is not LIVE`;
    if (this.#state.getMode() !== 'LIVE') return 'runtime is not in LIVE mode';
    const switches = this.#state.getSwitches();
    if (switches.emergencyStop) return 'emergency stop is active';
    if (switches.globalPause) return 'runtime is paused';
    return null;
  }

  async #signAndSend(
    tradeId: string,
    action: ProposedAction,
    adapter: ExecutionAdapter,
    tx: UnsignedTransaction,
    booking: { tokenOut: string | null; prices: LivePrices },
  ): Promise<ExecutionOutcome> {
    const startedAt = this.#now();
    const from = this.#walletFor(action.chain);

    let context: SigningContext;
    try {
      context = await adapter.prepareSigning(tx, from);
    } catch (error) {
      return this.#fail(tradeId, action, `prepare failed: ${errorMessage(error)}`, startedAt);
    }

    // The adapter must be sending to the contract the engine approved.
    if (context.family === 'evm' && context.to.toLowerCase() !== action.contract.toLowerCase()) {
      const isApprove =
        action.kind === 'approve' && context.to.toLowerCase() === action.tokenIn.address;
      if (!isApprove) {
        return this.#fail(
          tradeId,
          action,
          `built transaction targets ${context.to}, engine approved ${action.contract}`,
          startedAt,
        );
      }
    }

    let signed: SignedTransaction;
    try {
      signed = this.#wallets.useSigningKey(action.chain, (secret, address) =>
        context.family === 'evm'
          ? (() => {
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
            })()
          : (() => {
              const result = signSolanaTransaction(secret, context.transactionBase64, address);
              return { raw: result.raw, hash: result.signature };
            })(),
      );
    } catch (error) {
      return this.#fail(tradeId, action, `signing failed: ${errorMessage(error)}`, startedAt);
    }

    // The hash is on disk before the network sees the transaction.
    this.#trades.markSigned(tradeId, signed.hash);
    this.#audit.append({
      category: 'trade',
      action: 'trade.signed',
      status: 'ok',
      summary: `Signed ${tx.summary}`,
      chain: action.chain,
      actor: `agent:${action.source}`,
      mode: 'LIVE',
      correlationId: action.decisionCycleId,
      detail: { tradeId, actionId: action.actionId, txHash: signed.hash },
    });

    try {
      await adapter.broadcast(signed);
    } catch (error) {
      // The node may have accepted it before answering with an error. The row
      // keeps its hash and `signed` state; reconciliation resolves it.
      this.#log.error({ tradeId, txHash: signed.hash, err: error }, 'broadcast failed');
      this.#audit.append({
        category: 'trade',
        action: 'trade.broadcast',
        status: 'failed',
        summary: `Broadcast failed for ${signed.hash.slice(0, 12)}…: ${errorMessage(error)}`,
        chain: action.chain,
        actor: `agent:${action.source}`,
        mode: 'LIVE',
        correlationId: action.decisionCycleId,
        detail: { tradeId, txHash: signed.hash, unresolved: true },
      });
      return {
        actionId: action.actionId,
        mode: 'LIVE',
        status: 'failed',
        amountOut: null,
        feeUsd: '0.000000',
        txHash: signed.hash,
        error: `broadcast failed; transaction state unknown until reconciled: ${errorMessage(error)}`,
        filledAt: this.#now(),
      };
    }

    this.#trades.markBroadcast(tradeId);

    const receipt = await this.#awaitReceipt(adapter, signed.hash, booking.tokenOut, from);

    if (!receipt || receipt.status === 'pending' || receipt.status === 'unknown') {
      // Left in `broadcast`; the next cycle or restart reconciles it.
      this.#audit.append({
        category: 'trade',
        action: 'trade.broadcast',
        status: 'ok',
        summary: `Broadcast ${signed.hash.slice(0, 12)}…; confirmation not seen within ${String(RECEIPT_TIMEOUT_MS / 1000)}s`,
        chain: action.chain,
        actor: `agent:${action.source}`,
        mode: 'LIVE',
        correlationId: action.decisionCycleId,
        detail: { tradeId, txHash: signed.hash, unresolved: true },
      });
      return {
        actionId: action.actionId,
        mode: 'LIVE',
        status: 'failed',
        amountOut: null,
        feeUsd: '0.000000',
        txHash: signed.hash,
        error: 'confirmation pending; the trade row stays open until reconciled',
        filledAt: this.#now(),
      };
    }

    if (receipt.status === 'failed') {
      return this.#fail(
        tradeId,
        action,
        receipt.error ?? 'transaction failed on chain',
        startedAt,
        signed.hash,
      );
    }

    const trade = this.#trades.get(tradeId)!;
    const feeUsd = this.#bookFill(trade, receipt, booking.prices, null);

    return {
      actionId: action.actionId,
      mode: 'LIVE',
      status: 'filled',
      amountOut: receipt.amountOut,
      feeUsd,
      txHash: signed.hash,
      error: null,
      filledAt: this.#now(),
    };
  }

  async #awaitReceipt(
    adapter: ExecutionAdapter,
    hash: string,
    tokenOut: string | null,
    recipient: string,
  ): Promise<ExecutionReceipt | null> {
    const deadline = this.#now() + RECEIPT_TIMEOUT_MS;
    let last: ExecutionReceipt | null = null;
    while (this.#now() < deadline) {
      try {
        last = await adapter.receipt(hash, tokenOut ? { tokenOut, recipient } : undefined);
        if (last.status === 'confirmed' || last.status === 'failed') return last;
      } catch (error) {
        this.#log.warn({ hash, err: error }, 'receipt poll failed');
      }
      await this.#sleep(RECEIPT_POLL_MS);
    }
    return last;
  }

  /**
   * Book a confirmed transaction.
   *
   * Approvals move nothing and are recorded as filled with a zero output.
   * Swaps are booked with the amount the chain reported; when the receipt
   * could not expose it the fill is recorded as *unquantified* — filled with
   * `minAmountOut` as the lower bound the contract enforced, and the audit
   * row says so explicitly.
   */
  #bookFill(
    trade: TradeRecord,
    receipt: ExecutionReceipt,
    prices: LivePrices,
    note: string | null,
  ): string {
    const chain = trade.chain;
    const feeNative = receipt.feeNative ? BigInt(receipt.feeNative) : 0n;
    let feeUsdMicros: bigint;
    try {
      feeUsdMicros = nativeToUsdMicros(
        feeNative,
        CHAINS[chain].nativeDecimals,
        priceToAtto(prices.nativeUsd),
        'ceil',
      );
    } catch {
      feeUsdMicros = 0n;
    }
    const feeUsd = microsToUsd(feeUsdMicros);

    if (trade.kind === 'approve') {
      this.#trades.markFilled(trade.id, {
        filledOut: '0',
        feeNative: feeNative.toString(),
        feeUsd,
      });
      this.#audit.append({
        category: 'trade',
        action: 'trade.filled',
        status: 'ok',
        summary: `LIVE approval confirmed ${trade.txHash?.slice(0, 12) ?? ''}…`,
        chain,
        actor: 'system',
        mode: 'LIVE',
        correlationId: trade.decisionCycleId,
        detail: { tradeId: trade.id, txHash: trade.txHash, feeUsd, note },
      });
      return feeUsd;
    }

    const quantified = receipt.amountOut !== null;
    const amountOut = receipt.amountOut ?? trade.minOut ?? '0';

    const tokenIn = tokenRef(chain, trade.tokenIn);
    const tokenOut = tokenRef(chain, trade.tokenOut);
    const filledAt = this.#now();

    if (prices.tokenInUsd !== '0' && prices.tokenOutUsd !== '0') {
      this.#ledger.recordFill({
        tradeId: trade.id,
        mode: 'LIVE',
        chain,
        tokenIn,
        tokenOut,
        amountIn: trade.amountIn,
        amountOut,
        priceInUsd: prices.tokenInUsd,
        priceOutUsd: prices.tokenOutUsd,
        feeUsd,
        filledAt,
        simulated: false,
      });
    }

    this.#trades.markFilled(trade.id, {
      filledOut: amountOut,
      feeNative: feeNative.toString(),
      feeUsd,
      txHash: receipt.hash,
    });

    this.#audit.append({
      category: 'trade',
      action: 'trade.filled',
      status: 'ok',
      summary: `LIVE fill ${receipt.hash.slice(0, 12)}…: ${trade.amountIn} -> ${amountOut}${quantified ? '' : ' (lower bound; receipt did not expose the transfer)'}`,
      chain,
      actor: 'system',
      mode: 'LIVE',
      correlationId: trade.decisionCycleId,
      detail: {
        tradeId: trade.id,
        txHash: receipt.hash,
        amountOut,
        amountOutSource: quantified ? 'chain' : 'min-out-lower-bound',
        feeUsd,
        height: receipt.height,
        ...(note ? { note } : {}),
        ...(prices.tokenInUsd === '0'
          ? { ledger: 'not booked: fill-time prices unavailable' }
          : {}),
      },
    });

    return feeUsd;
  }

  #walletFor(chain: ProposedAction['chain']): string {
    return this.#wallets.depositAddress(chain);
  }

  #fail(
    tradeId: string,
    action: ProposedAction,
    reason: string,
    at: number,
    txHash: string | null = null,
  ): ExecutionOutcome {
    this.#log.warn({ tradeId, reason }, 'live execution failed');
    try {
      this.#trades.markFailed(tradeId, reason);
    } catch (error) {
      if (!(error instanceof AppError && error.code === ErrorCode.CONFLICT)) throw error;
    }
    this.#audit.append({
      category: 'trade',
      action: 'trade.failed',
      status: 'failed',
      summary: `LIVE execution failed: ${reason}`,
      chain: action.chain,
      actor: `agent:${action.source}`,
      mode: 'LIVE',
      correlationId: action.decisionCycleId,
      detail: { tradeId, actionId: action.actionId, ...(txHash ? { txHash } : {}) },
    });
    return {
      actionId: action.actionId,
      mode: 'LIVE',
      status: 'failed',
      amountOut: null,
      feeUsd: '0.000000',
      txHash,
      error: reason,
      filledAt: at,
    };
  }
}

function tokenRef(
  chain: ProposedAction['chain'],
  address: string,
): { address: string; decimals: number } {
  const known = CHAINS[chain].tokens.find((token) => token.address === address);
  return { address, decimals: known?.decimals ?? (chain === 'solana' ? 9 : 18) };
}
