import type { SignedTransaction, SigningContext } from '../chains/types.js';
import type { UnsignedTransaction } from '../execution/types.js';
import type { ProposedAction } from '../risk/types.js';
import type { TradeRecord, TradeStore } from '../trading/trades.js';
import type { RiskGate } from '../risk/gate.js';
import type { AuditLog } from '../audit/audit.js';
import type { WalletService } from '../wallet/service.js';
import type { StateStore } from '../core/state.js';
import { signEvmTransaction } from '../execution/evm/signer.js';
import {
  amountToBigint,
  microsToUsd,
  nativeToUsdMicros,
  priceToAtto,
  usdToMicros,
} from '../risk/money.js';
import { CHAINS } from '../chains/registry.js';
import { childLogger } from '../logging/logger.js';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';
import type { LiquidityStore } from './store.js';
import type { LiquidityRegistry } from './registry.js';
import type { LpExecutionOutcome, LpFillPrices } from './paper.js';
import type { LpPlan } from './proposal.js';
import type { LpAdapter, LpPoolState, LpReceipt } from './types.js';
import { feeInNativeUnits } from '../risk/engine.js';

/**
 * The LIVE LP executor: the only liquidity code that signs and broadcasts.
 *
 * Same order as the swap executor, for the same reasons:
 *
 *  1. **Refuse** unless the runtime is LIVE, not paused, not stopped — checked
 *     here again, after the risk engine, because the state can change between
 *     the decision and this call.
 *  2. **Build** the transaction from the plan the engine approved and fetch
 *     nonce and fee caps. The adapter's `to` must equal the contract the engine
 *     approved (the router, or the pool for a claim, or the token for an
 *     approval).
 *  3. **Sign** inside the vault's synchronous callback.
 *  4. **Record the hash** in the trade row, `signed` state, before anything is
 *     sent.
 *  5. **Broadcast**, then poll the receipt for a bounded time.
 *  6. **Book** from what the chain reports: LP tokens minted, assets pulled or
 *     returned, fees claimed — read from the transaction's ERC-20 transfers,
 *     never from the quote.
 *
 * Nothing here consults a model, and there is no parameter by which a caller
 * can supply calldata: the transaction comes from the adapter that produced
 * the quote the engine approved.
 */

const RECEIPT_POLL_MS = 3_000;
const RECEIPT_TIMEOUT_MS = 90_000;

export interface LiveLpExecutorDeps {
  trades: TradeStore;
  gate: RiskGate;
  audit: AuditLog;
  wallets: WalletService;
  state: StateStore;
  store: LiquidityStore;
  registry: LiquidityRegistry;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LpReconcileReport {
  checked: number;
  filled: number;
  failed: number;
  stillPending: number;
}

export class LiveLpExecutor {
  readonly #trades: TradeStore;
  readonly #gate: RiskGate;
  readonly #audit: AuditLog;
  readonly #wallets: WalletService;
  readonly #state: StateStore;
  readonly #store: LiquidityStore;
  readonly #registry: LiquidityRegistry;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log = childLogger('lp-live');

  constructor(deps: LiveLpExecutorDeps) {
    this.#trades = deps.trades;
    this.#gate = deps.gate;
    this.#audit = deps.audit;
    this.#wallets = deps.wallets;
    this.#state = deps.state;
    this.#store = deps.store;
    this.#registry = deps.registry;
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Execute an allowed lp_add / lp_remove / lp_claim. */
  async execute(
    tradeId: string,
    action: ProposedAction,
    plan: LpPlan,
    pool: LpPoolState,
    prices: LpFillPrices,
  ): Promise<LpExecutionOutcome> {
    const startedAt = this.#now();
    const adapter = this.#registry.get(action.chain);
    if (!adapter) {
      return this.#fail(tradeId, action, `no LP adapter for ${action.chain}`, startedAt);
    }
    const refusal = this.#refusal(action);
    if (refusal) return this.#fail(tradeId, action, refusal, startedAt);

    this.#trades.markDispatched(tradeId);
    this.#gate.markDispatched(action);

    let tx: UnsignedTransaction;
    try {
      const wallet = this.#wallets.depositAddress(action.chain);
      tx =
        plan.kind === 'add'
          ? adapter.buildAdd(plan.quote)
          : plan.kind === 'remove'
            ? adapter.buildRemove(plan.quote)
            : adapter.buildClaim(plan.plan, wallet);
    } catch (error) {
      return this.#fail(tradeId, action, `build failed: ${errorMessage(error)}`, startedAt);
    }

    const sent = await this.#signAndSend(tradeId, action, adapter, tx);
    if (!sent.ok) return sent.outcome;

    const trade = this.#trades.get(tradeId)!;
    return this.#book(trade, action, plan, pool, prices, sent.receipt, null);
  }

  /** Execute an allowed exact-amount ERC-20 approval to the router. */
  async executeApprove(
    tradeId: string,
    action: ProposedAction,
    tx: UnsignedTransaction,
    nativeUsd: string,
  ): Promise<LpExecutionOutcome> {
    const startedAt = this.#now();
    const adapter = this.#registry.get(action.chain);
    if (!adapter) {
      return this.#fail(tradeId, action, `no LP adapter for ${action.chain}`, startedAt);
    }
    const refusal = this.#refusal(action);
    if (refusal) return this.#fail(tradeId, action, refusal, startedAt);

    this.#trades.markDispatched(tradeId);
    this.#gate.markDispatched(action);

    const sent = await this.#signAndSend(tradeId, action, adapter, tx);
    if (!sent.ok) return sent.outcome;

    const feeUsd = this.#feeUsd(action.chain, sent.receipt, nativeUsd);
    this.#trades.markFilled(tradeId, {
      filledOut: '0',
      feeNative: sent.receipt.feeNative,
      feeUsd,
      txHash: sent.receipt.hash,
    });
    this.#audit.append({
      category: 'liquidity',
      action: 'liquidity.filled',
      status: 'ok',
      summary: `LIVE LP approval confirmed ${sent.receipt.hash.slice(0, 12)}…`,
      chain: action.chain,
      actor: 'system',
      mode: 'LIVE',
      correlationId: action.decisionCycleId,
      detail: { tradeId, txHash: sent.receipt.hash, feeUsd },
    });
    return {
      actionId: action.actionId,
      mode: 'LIVE',
      status: 'filled',
      lpTokens: null,
      amount0: null,
      amount1: null,
      feeUsd,
      txHash: sent.receipt.hash,
      error: null,
      filledAt: this.#now(),
    };
  }

  /**
   * Settle LP rows left in flight by a previous process. Must run before the
   * swap executor's reconcile, which would otherwise mark these rows without
   * booking the LP position. Nothing is re-signed.
   */
  async reconcile(): Promise<LpReconcileReport> {
    const report: LpReconcileReport = { checked: 0, filled: 0, failed: 0, stillPending: 0 };

    for (const trade of this.#trades.listInFlight()) {
      const isLpRow =
        trade.kind.startsWith('lp_') || (trade.kind === 'approve' && trade.route['lp'] === true);
      if (!isLpRow) continue;
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
        .receipt(trade.txHash, this.#wallets.depositAddress(trade.chain))
        .catch((error: unknown) => {
          this.#log.warn({ tradeId: trade.id, err: error }, 'lp reconcile receipt failed');
          return null;
        });
      if (!receipt || receipt.status === 'pending' || receipt.status === 'unknown') {
        report.stillPending += 1;
        continue;
      }
      if (trade.status === 'signed') this.#trades.markBroadcast(trade.id);

      if (receipt.status === 'failed') {
        this.#trades.markFailed(trade.id, receipt.error ?? 'transaction failed on chain');
        report.failed += 1;
        this.#audit.append({
          category: 'liquidity',
          action: 'liquidity.reconciled',
          status: 'failed',
          summary: `Reconciled LP ${trade.txHash.slice(0, 12)}… after restart: failed on chain`,
          chain: trade.chain,
          actor: 'system',
          mode: 'LIVE',
          correlationId: trade.decisionCycleId,
          detail: { tradeId: trade.id, txHash: trade.txHash },
        });
        continue;
      }

      this.#bookReconciled(trade, receipt);
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
    adapter: LpAdapter,
    tx: UnsignedTransaction,
  ): Promise<{ ok: true; receipt: LpReceipt } | { ok: false; outcome: LpExecutionOutcome }> {
    const startedAt = this.#now();
    const from = this.#wallets.depositAddress(action.chain);

    let context: SigningContext;
    try {
      context = await adapter.prepareSigning(tx, from);
    } catch (error) {
      return {
        ok: false,
        outcome: this.#fail(tradeId, action, `prepare failed: ${errorMessage(error)}`, startedAt),
      };
    }
    if (context.family !== 'evm') {
      return {
        ok: false,
        outcome: this.#fail(tradeId, action, 'LP execution is EVM-only in this build', startedAt),
      };
    }

    // execute() checked the switches before the build; a stop engaged since
    // then must still land before the key is used.
    const refusal = this.#refusal(action);
    if (refusal !== null) {
      return {
        ok: false,
        outcome: this.#fail(tradeId, action, `refused before signing: ${refusal}`, startedAt),
      };
    }

    // The engine approved a fee from the quote's estimate; prepareSigning
    // re-fetched a fresh one. EIP-1559 caps the spend at gas * maxFeePerGas,
    // and that cap must still be the one the engine measured.
    const approvedFee = feeInNativeUnits(action.feeEstimate.detail);
    const signingFee = BigInt(context.gas) * BigInt(context.maxFeePerGas);
    if (signingFee > approvedFee) {
      return {
        ok: false,
        outcome: this.#fail(
          tradeId,
          action,
          `fee at signing ${signingFee.toString()} exceeds the approved ${approvedFee.toString()} ` +
            '(gas moved since the quote); re-quote and decide again',
          startedAt,
        ),
      };
    }

    // The adapter must be sending to the contract the engine approved: the
    // router, the pool for a claim, or the token itself for an approval.
    const to = context.to.toLowerCase();
    const isApprove = action.kind === 'approve' && to === action.tokenIn.address;
    if (to !== action.contract.toLowerCase() && !isApprove) {
      return {
        ok: false,
        outcome: this.#fail(
          tradeId,
          action,
          `built transaction targets ${context.to}, engine approved ${action.contract}`,
          startedAt,
        ),
      };
    }

    let signed: SignedTransaction;
    try {
      signed = this.#wallets.useSigningKey(action.chain, (secret, address) => {
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
      });
    } catch (error) {
      return {
        ok: false,
        outcome: this.#fail(tradeId, action, `signing failed: ${errorMessage(error)}`, startedAt),
      };
    }

    // The hash is on disk before the network sees the transaction.
    this.#trades.markSigned(tradeId, signed.hash);
    this.#audit.append({
      category: 'liquidity',
      action: 'liquidity.signed',
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
      this.#log.error({ tradeId, txHash: signed.hash, err: error }, 'lp broadcast failed');
      this.#audit.append({
        category: 'liquidity',
        action: 'liquidity.broadcast',
        status: 'failed',
        summary: `Broadcast failed for ${signed.hash.slice(0, 12)}…: ${errorMessage(error)}`,
        chain: action.chain,
        actor: `agent:${action.source}`,
        mode: 'LIVE',
        correlationId: action.decisionCycleId,
        detail: { tradeId, txHash: signed.hash, unresolved: true },
      });
      return {
        ok: false,
        outcome: {
          actionId: action.actionId,
          mode: 'LIVE',
          status: 'failed',
          lpTokens: null,
          amount0: null,
          amount1: null,
          feeUsd: '0.000000',
          txHash: signed.hash,
          error: `broadcast failed; transaction state unknown until reconciled: ${errorMessage(error)}`,
          filledAt: this.#now(),
        },
      };
    }
    this.#trades.markBroadcast(tradeId);

    const receipt = await this.#awaitReceipt(adapter, signed.hash, from);
    if (!receipt || receipt.status === 'pending' || receipt.status === 'unknown') {
      this.#audit.append({
        category: 'liquidity',
        action: 'liquidity.broadcast',
        status: 'ok',
        summary: `Broadcast ${signed.hash.slice(0, 12)}…; confirmation not seen within ${String(RECEIPT_TIMEOUT_MS / 1000)}s`,
        chain: action.chain,
        actor: `agent:${action.source}`,
        mode: 'LIVE',
        correlationId: action.decisionCycleId,
        detail: { tradeId, txHash: signed.hash, unresolved: true },
      });
      return {
        ok: false,
        outcome: {
          actionId: action.actionId,
          mode: 'LIVE',
          status: 'failed',
          lpTokens: null,
          amount0: null,
          amount1: null,
          feeUsd: '0.000000',
          txHash: signed.hash,
          error: 'confirmation pending; the trade row stays open until reconciled',
          filledAt: this.#now(),
        },
      };
    }
    if (receipt.status === 'failed') {
      return {
        ok: false,
        outcome: this.#fail(
          tradeId,
          action,
          receipt.error ?? 'transaction failed on chain',
          startedAt,
          signed.hash,
        ),
      };
    }
    return { ok: true, receipt };
  }

  async #awaitReceipt(adapter: LpAdapter, hash: string, wallet: string): Promise<LpReceipt | null> {
    const deadline = this.#now() + RECEIPT_TIMEOUT_MS;
    let last: LpReceipt | null = null;
    while (this.#now() < deadline) {
      try {
        last = await adapter.receipt(hash, wallet);
        if (last.status === 'confirmed' || last.status === 'failed') return last;
      } catch (error) {
        this.#log.warn({ hash, err: error }, 'lp receipt poll failed');
      }
      await this.#sleep(RECEIPT_POLL_MS);
    }
    return last;
  }

  /**
   * Book a confirmed LP transaction from the chain's own transfers.
   *
   * When the receipt does not expose a leg (it always should for ERC-20
   * pools), the quote's minimum is used as the lower bound the contract
   * enforced and the audit row says so explicitly.
   */
  #book(
    trade: TradeRecord,
    action: ProposedAction,
    plan: LpPlan,
    pool: LpPoolState,
    prices: LpFillPrices,
    receipt: LpReceipt,
    note: string | null,
  ): LpExecutionOutcome {
    const feeUsd = this.#feeUsd(action.chain, receipt, prices.nativeUsd);
    const filledAt = this.#now();
    const notes: string[] = note ? [note] : [];
    const chainAmount = (
      side: 'received' | 'sent',
      token: string,
      fallback: string,
      label: string,
    ) => {
      const reported = receipt[side][token.toLowerCase()];
      if (reported !== undefined) return reported;
      notes.push(`${label} not exposed by the receipt; quote minimum used as the lower bound`);
      return fallback;
    };

    let lpTokens: string | null = null;
    let amount0: string;
    let amount1: string;
    let summary: string;

    if (plan.kind === 'add') {
      lpTokens = chainAmount('received', pool.poolId, plan.quote.minLpTokens, 'LP tokens minted');
      amount0 = chainAmount('sent', pool.token0.address, plan.quote.amount0, 'token0 pulled');
      amount1 = chainAmount('sent', pool.token1.address, plan.quote.amount1, 'token1 pulled');
      const capital =
        nativeToUsdMicros(
          amountToBigint(amount0),
          pool.token0.decimals,
          priceToAtto(prices.token0Usd),
          'ceil',
        ) +
        nativeToUsdMicros(
          amountToBigint(amount1),
          pool.token1.decimals,
          priceToAtto(prices.token1Usd),
          'ceil',
        );
      this.#store.bookAdd({
        mode: 'LIVE',
        chain: action.chain,
        protocol: action.protocol,
        poolId: pool.poolId,
        token0: { address: pool.token0.address, decimals: pool.token0.decimals },
        token1: { address: pool.token1.address, decimals: pool.token1.decimals },
        lpTokens,
        amount0,
        amount1,
        capitalUsd: microsToUsd(capital),
        at: filledAt,
        rebalance: action.kind === 'lp_rebalance',
      });
      summary = `LIVE LP add ${receipt.hash.slice(0, 12)}…: ${amount0}/${amount1} -> ${lpTokens} LP`;
    } else if (plan.kind === 'remove') {
      lpTokens = plan.quote.lpTokens;
      amount0 = chainAmount('received', pool.token0.address, plan.quote.min0, 'token0 returned');
      amount1 = chainAmount('received', pool.token1.address, plan.quote.min1, 'token1 returned');
      const stored = this.#store.getPosition('LIVE', action.chain, action.protocol, pool.poolId);
      if (stored && amountToBigint(stored.lpTokens) >= amountToBigint(lpTokens)) {
        this.#store.bookRemove({
          mode: 'LIVE',
          chain: action.chain,
          protocol: action.protocol,
          poolId: pool.poolId,
          lpTokens,
          at: filledAt,
        });
      } else {
        notes.push('ledger held fewer LP tokens than were burned; position row left as is');
      }
      summary = `LIVE LP remove ${receipt.hash.slice(0, 12)}…: ${lpTokens} LP -> ${amount0}/${amount1}`;
    } else {
      amount0 = receipt.received[pool.token0.address.toLowerCase()] ?? '0';
      amount1 = receipt.received[pool.token1.address.toLowerCase()] ?? '0';
      this.#store.touchClaim('LIVE', action.chain, action.protocol, pool.poolId, filledAt);
      summary = `LIVE LP fee claim ${receipt.hash.slice(0, 12)}…: ${amount0}/${amount1} received`;
    }

    this.#trades.markFilled(trade.id, {
      filledOut: plan.kind === 'add' ? (lpTokens ?? '0') : (amount1 ?? '0'),
      feeNative: receipt.feeNative,
      feeUsd,
      txHash: receipt.hash,
    });

    this.#audit.append({
      category: 'liquidity',
      action: 'liquidity.filled',
      status: 'ok',
      summary,
      chain: action.chain,
      actor: 'system',
      mode: 'LIVE',
      correlationId: trade.decisionCycleId,
      detail: {
        tradeId: trade.id,
        txHash: receipt.hash,
        poolId: pool.poolId,
        lpTokens,
        amount0,
        amount1,
        feeUsd,
        height: receipt.height,
        amountsSource: notes.length === 0 ? 'chain' : 'chain-with-fallbacks',
        ...(notes.length > 0 ? { notes } : {}),
      },
    });

    return {
      actionId: action.actionId,
      mode: 'LIVE',
      status: 'filled',
      lpTokens,
      amount0,
      amount1,
      feeUsd,
      txHash: receipt.hash,
      error: null,
      filledAt,
    };
  }

  /**
   * A confirmed row after a restart: the plan and prices are gone, so the
   * ledger is updated from the transfers alone, with a cost basis of zero
   * and an audit row saying the valuation is missing rather than inventing
   * one.
   */
  #bookReconciled(trade: TradeRecord, receipt: LpReceipt): void {
    const at = this.#now();
    const poolId = typeof trade.route['poolId'] === 'string' ? trade.route['poolId'] : null;
    const feeNative = receipt.feeNative ?? '0';
    this.#trades.markFilled(trade.id, {
      filledOut: '0',
      feeNative,
      feeUsd: microsToUsd(usdToMicros('0')),
      txHash: receipt.hash,
    });

    let ledger = 'not booked';
    if (trade.kind === 'lp_add' && poolId) {
      const minted = receipt.received[poolId.toLowerCase()];
      const spent0 = receipt.sent[trade.tokenIn.toLowerCase()] ?? '0';
      const spent1 = receipt.sent[trade.tokenOut.toLowerCase()] ?? '0';
      if (minted && amountToBigint(minted) > 0n) {
        const known0 = CHAINS[trade.chain].tokens.find((t) => t.address === trade.tokenIn);
        const known1 = CHAINS[trade.chain].tokens.find((t) => t.address === trade.tokenOut);
        this.#store.bookAdd({
          mode: 'LIVE',
          chain: trade.chain,
          protocol: trade.protocol,
          poolId,
          token0: { address: trade.tokenIn, decimals: known0?.decimals ?? 18 },
          token1: { address: trade.tokenOut, decimals: known1?.decimals ?? 18 },
          lpTokens: minted,
          amount0: spent0,
          amount1: spent1,
          capitalUsd: '0',
          at,
        });
        ledger = 'booked with a zero cost basis: fill-time prices unavailable';
      }
    } else if (trade.kind === 'lp_remove' && poolId) {
      const burned = trade.route['lpTokens'];
      const stored = this.#store.getPosition('LIVE', trade.chain, trade.protocol, poolId);
      if (
        typeof burned === 'string' &&
        stored &&
        amountToBigint(stored.lpTokens) >= amountToBigint(burned)
      ) {
        this.#store.bookRemove({
          mode: 'LIVE',
          chain: trade.chain,
          protocol: trade.protocol,
          poolId,
          lpTokens: burned,
          at,
        });
        ledger = 'position reduced by the burned amount';
      }
    }

    this.#audit.append({
      category: 'liquidity',
      action: 'liquidity.reconciled',
      status: 'ok',
      summary: `Reconciled LP ${receipt.hash.slice(0, 12)}… after restart: confirmed on chain`,
      chain: trade.chain,
      actor: 'system',
      mode: 'LIVE',
      correlationId: trade.decisionCycleId,
      detail: { tradeId: trade.id, txHash: receipt.hash, kind: trade.kind, ledger },
    });
  }

  #feeUsd(chain: ProposedAction['chain'], receipt: LpReceipt, nativeUsd: string): string {
    try {
      return microsToUsd(
        nativeToUsdMicros(
          receipt.feeNative ? BigInt(receipt.feeNative) : 0n,
          CHAINS[chain].nativeDecimals,
          priceToAtto(nativeUsd),
          'ceil',
        ),
      );
    } catch {
      return microsToUsd(0n);
    }
  }

  #fail(
    tradeId: string,
    action: ProposedAction,
    reason: string,
    at: number,
    txHash: string | null = null,
  ): LpExecutionOutcome {
    this.#log.warn({ tradeId, reason }, 'live LP execution failed');
    try {
      this.#trades.markFailed(tradeId, reason);
    } catch (error) {
      if (!(error instanceof AppError && error.code === ErrorCode.CONFLICT)) throw error;
    }
    this.#audit.append({
      category: 'liquidity',
      action: 'liquidity.failed',
      status: 'failed',
      summary: `LIVE LP execution failed: ${reason}`,
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
      lpTokens: null,
      amount0: null,
      amount1: null,
      feeUsd: '0.000000',
      txHash,
      error: reason,
      filledAt: at,
    };
  }
}
