import { randomUUID } from 'node:crypto';
import type { ChainId } from '../chains/registry.js';
import { CHAINS, chainFamily } from '../chains/registry.js';
import type { ResearchAgent } from '../agents/research/agent.js';
import type { TradeDecision, TraderAgent, TraderOutput } from '../agents/trader/agent.js';
import type { ProposalBuilder, BuiltProposal } from './proposal.js';
import type { TradeStore } from './trades.js';
import type { LedgerService } from './ledger.js';
import type { RiskGate } from '../risk/gate.js';
import type { RiskPolicyStore } from '../risk/store.js';
import type { StateStore } from '../core/state.js';
import type { AuditLog } from '../audit/audit.js';
import type { WalletService } from '../wallet/service.js';
import type { PaperExecutor } from '../execution/paper.js';
import type { LiveExecutor } from '../execution/live.js';
import type { ExecutionRegistry } from '../execution/registry.js';
import type { ExecutionOutcome } from '../execution/types.js';
import type { MarketService } from '../market/service.js';
import { supportsErc20Approval } from '../execution/types.js';
import type { ActionSource, Mode, ProposedAction, RiskDecision } from '../risk/types.js';
import { balanceKey, priceKey, proposedActionSchema } from '../risk/types.js';
import { deriveIdempotencyKey } from '../risk/engine.js';
import { amountToBigint } from '../risk/money.js';
import { childLogger } from '../logging/logger.js';
import { errorMessage } from '../util/errors.js';

/**
 * One auto-trade cycle, end to end.
 *
 *   research ──> trader decides ──> proposal built ──> risk engine ──> executor
 *      │              │                   │                │              │
 *   facts only   NO_ACTION is        deterministic     the only         PAPER sim
 *                the default         sizing/quoting    authority        or LIVE sign
 *
 * The cycle is linear and every stage can end it. Each ending is recorded in
 * the audit log with the stage that ended it and why, so "the agent did
 * nothing" is always explained by a row, not by silence.
 *
 * Nothing here signs. The executors do, and only the LIVE one — and only when
 * the trade row is `allowed`, which only the risk gate can write.
 */

export interface CycleRequest {
  chain: ChainId;
  /** A token address or pool id to research. One of the two is required. */
  token?: string;
  poolId?: string;
  source: ActionSource;
}

export type CycleOutcome = 'blocked' | 'skipped' | 'no_action' | 'rejected' | 'filled' | 'failed';

export interface CycleReport {
  cycleId: string;
  chain: ChainId;
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  outcome: CycleOutcome;
  reason: string;
  research: { id: string; status: string } | null;
  decision: TradeDecision | null;
  modelStatus: TraderOutput['modelStatus'] | null;
  trade: { tradeId: string; actionId: string } | null;
  risk: { allowed: boolean; code: RiskDecision['code']; reason: string } | null;
  execution: ExecutionOutcome | null;
  notes: string[];
}

export interface PipelineDeps {
  research: ResearchAgent;
  trader: TraderAgent;
  builder: ProposalBuilder;
  market: MarketService;
  trades: TradeStore;
  ledger: LedgerService;
  gate: RiskGate;
  policy: RiskPolicyStore;
  state: StateStore;
  audit: AuditLog;
  wallets: WalletService;
  registry: ExecutionRegistry;
  paper: PaperExecutor;
  live: LiveExecutor;
  now?: () => number;
}

export class AutoTradePipeline {
  readonly #deps: PipelineDeps;
  readonly #now: () => number;
  readonly #log = childLogger('pipeline');
  #running = false;

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  get running(): boolean {
    return this.#running;
  }

  async runCycle(request: CycleRequest): Promise<CycleReport> {
    if (this.#running) {
      return this.#report(request, 'blocked', 'a cycle is already running', {});
    }
    this.#running = true;
    try {
      return await this.#run(request);
    } finally {
      this.#running = false;
    }
  }

  async #run(request: CycleRequest): Promise<CycleReport> {
    const d = this.#deps;
    const cycleId = randomUUID();
    const startedAt = this.#now();
    const mode = d.state.getMode();
    const notes: string[] = [];
    const base = { cycleId, startedAt, mode, notes };

    // --- switches ----------------------------------------------------------
    const switches = d.state.getSwitches();
    if (switches.emergencyStop) {
      return this.#end(request, base, 'blocked', 'emergency stop is active', {});
    }
    if (switches.globalPause) {
      return this.#end(request, base, 'blocked', 'runtime is paused', {});
    }
    if (!d.policy.exists()) {
      return this.#end(request, base, 'blocked', 'no risk policy is configured', {});
    }

    const { policy } = d.policy.getWithHash();
    if (!policy.enabledChains.includes(request.chain)) {
      return this.#end(
        request,
        base,
        'skipped',
        `${request.chain} is not enabled in the policy`,
        {},
      );
    }

    let walletAddress: string;
    try {
      walletAddress = d.wallets.depositAddress(request.chain);
    } catch {
      return this.#end(
        request,
        base,
        'skipped',
        'create the agent wallets before running a cycle',
        {},
      );
    }

    // --- research ------------------------------------------------------------
    const research = await d.research.research({
      chain: request.chain,
      ...(request.token ? { token: request.token } : {}),
      ...(request.poolId ? { poolId: request.poolId } : {}),
    });
    const researchRef = { id: research.id, status: research.status };

    // --- decide ----------------------------------------------------------------
    const executable = d.registry.status(request.chain);
    const allowlist = policy.tokenAllowlist[request.chain] ?? [];
    const portfolio = d.ledger.mark(mode, await this.#positionPrices(mode, request.chain));

    const traded = await d.trader.decide({
      chain: request.chain,
      research,
      portfolio,
      policy,
      allowlist,
      executable: executable.executable,
      executableReason: executable.reason,
    });
    const decision = traded.decision;

    d.audit.append({
      category: 'trade',
      action: 'trade.decision',
      status: decision.action === 'NO_ACTION' ? 'hold' : 'ok',
      summary:
        decision.action === 'NO_ACTION'
          ? `Trader: NO ACTION — ${decision.reason.slice(0, 160)}`
          : `Trader proposes ${decision.action} ${decision.token ?? ''} for ${decision.requestedNotionalUsd} USD`,
      chain: request.chain,
      actor: 'agent:trader',
      mode,
      correlationId: cycleId,
      detail: {
        researchId: research.id,
        model: traded.model,
        modelStatus: traded.modelStatus,
        fallback: traded.fallback,
        latencyMs: traded.latencyMs,
        decision,
      },
    });

    if (decision.action === 'NO_ACTION') {
      return this.#end(request, base, 'no_action', decision.reason, {
        research: researchRef,
        decision,
        modelStatus: traded.modelStatus,
      });
    }

    const adapter = d.registry.get(request.chain);
    if (!adapter) {
      return this.#end(request, base, 'skipped', executable.reason, {
        research: researchRef,
        decision,
        modelStatus: traded.modelStatus,
      });
    }

    // --- build -----------------------------------------------------------------
    const built = await d.builder.build({
      chain: request.chain,
      mode,
      decisionCycleId: cycleId,
      source: request.source,
      walletAddress,
      decision,
      policy,
      adapter,
    });
    if (!built.ok) {
      notes.push(...built.notes);
      d.audit.append({
        category: 'trade',
        action: 'trade.proposal',
        status: 'hold',
        summary: `Proposal not built: ${built.reason}`,
        chain: request.chain,
        actor: 'system',
        mode,
        correlationId: cycleId,
        detail: { decision, notes: built.notes },
      });
      return this.#end(request, base, 'skipped', built.reason, {
        research: researchRef,
        decision,
        modelStatus: traded.modelStatus,
      });
    }

    const { proposal } = built;
    notes.push(...proposal.notes);

    // --- LIVE on EVM: the router must be allowed to pull the input token ---------
    if (mode === 'LIVE' && chainFamily(request.chain) === 'evm') {
      const approval = await this.#ensureAllowance(cycleId, request, proposal, walletAddress);
      if (approval) {
        return this.#end(request, base, approval.outcome, approval.reason, {
          research: researchRef,
          decision,
          modelStatus: traded.modelStatus,
          ...(approval.trade ? { trade: approval.trade } : {}),
          ...(approval.risk ? { risk: approval.risk } : {}),
          ...(approval.execution ? { execution: approval.execution } : {}),
        });
      }
    }

    // --- propose + decide -------------------------------------------------------
    const trade = d.trades.propose(proposal.action, proposal.side, {
      researchId: research.id,
      route: {
        protocol: proposal.quote.protocol,
        source: proposal.quote.source,
        marketId: proposal.quote.marketId,
      },
    });
    const verdict = d.gate.decide(proposal.action, proposal.snapshot, proposal.priceLookup);
    d.trades.decide(trade.id, verdict);
    this.#auditVerdict(request.chain, mode, cycleId, trade.id, proposal.action, verdict);

    const tradeRef = { tradeId: trade.id, actionId: proposal.action.actionId };
    const riskRef = { allowed: verdict.allowed, code: verdict.code, reason: verdict.reason };

    if (!verdict.allowed) {
      return this.#end(request, base, 'rejected', `${verdict.code}: ${verdict.reason}`, {
        research: researchRef,
        decision,
        modelStatus: traded.modelStatus,
        trade: tradeRef,
        risk: riskRef,
      });
    }

    // --- execute --------------------------------------------------------------
    const execution =
      mode === 'PAPER'
        ? d.paper.execute(trade.id, proposal.action, proposal.quote, proposal.prices)
        : await d.live.execute(trade.id, proposal.action, proposal.quote, proposal.prices);

    return this.#end(
      request,
      base,
      execution.status === 'filled' ? 'filled' : 'failed',
      execution.status === 'filled'
        ? `${mode} fill: ${execution.amountOut ?? '?'} received`
        : (execution.error ?? 'execution failed'),
      {
        research: researchRef,
        decision,
        modelStatus: traded.modelStatus,
        trade: tradeRef,
        risk: riskRef,
        execution,
      },
    );
  }

  /**
   * Make sure the router can pull `amountIn` of the input token.
   *
   * Returns null when the allowance is already sufficient or an approval was
   * executed and confirmed. Otherwise returns the ending for the cycle: the
   * approval was rejected by the engine or failed on chain, and the swap is
   * not attempted this cycle.
   *
   * The approval is for the exact amount, never unlimited, and it goes
   * through the risk engine as an `approve` action with its own fee check
   * and contract allowlist check.
   */
  async #ensureAllowance(
    cycleId: string,
    request: CycleRequest,
    proposal: BuiltProposal,
    walletAddress: string,
  ): Promise<{
    outcome: CycleOutcome;
    reason: string;
    trade?: { tradeId: string; actionId: string };
    risk?: { allowed: boolean; code: RiskDecision['code']; reason: string };
    execution?: ExecutionOutcome;
  } | null> {
    const d = this.#deps;
    const adapter = d.registry.get(request.chain);
    if (!adapter || !supportsErc20Approval(adapter)) return null;

    const token = proposal.action.tokenIn;
    const needed = amountToBigint(proposal.action.amountIn);

    let current: bigint;
    try {
      current = await adapter.allowance(token.address, walletAddress);
    } catch (error) {
      return { outcome: 'skipped', reason: `allowance read failed: ${errorMessage(error)}` };
    }
    if (current >= needed) return null;

    let fee: ProposedAction['feeEstimate'];
    try {
      fee = await adapter.approveFeeEstimate();
    } catch (error) {
      return { outcome: 'skipped', reason: `approval fee estimate failed: ${errorMessage(error)}` };
    }

    const candidate = {
      schemaVersion: 1 as const,
      actionId: randomUUID(),
      decisionCycleId: cycleId,
      idempotencyKey: '0'.repeat(64),
      proposedAt: this.#now(),
      mode: 'LIVE' as const,
      source: request.source,
      chain: request.chain,
      kind: 'approve' as const,
      protocol: proposal.action.protocol,
      contract: proposal.action.contract,
      reduceOnly: false,
      tokenIn: token,
      tokenOut: token,
      amountIn: needed.toString(),
      quote: null,
      feeEstimate: fee,
      rationale: `exact approval of ${needed.toString()} for the swap that follows`,
    };
    candidate.idempotencyKey = deriveIdempotencyKey(candidate);
    const parsed = proposedActionSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        outcome: 'skipped',
        reason: `internal: approval failed schema (${parsed.error.issues[0]?.message ?? '?'})`,
      };
    }
    const action = parsed.data;

    // The approval sees the same prices and balances as the swap it precedes.
    const snapshot = {
      prices: {
        [priceKey(request.chain, token.address)]:
          proposal.snapshot.prices[priceKey(request.chain, token.address)]!,
        [priceKey(request.chain, CHAINS[request.chain].nativeSentinel)]:
          proposal.snapshot.prices[priceKey(request.chain, CHAINS[request.chain].nativeSentinel)]!,
      },
      liquidity: {},
      balances: {
        ...(proposal.snapshot.balances[balanceKey(request.chain, token.address)]
          ? {
              [balanceKey(request.chain, token.address)]:
                proposal.snapshot.balances[balanceKey(request.chain, token.address)]!,
            }
          : {}),
        ...(proposal.snapshot.balances[
          balanceKey(request.chain, CHAINS[request.chain].nativeSentinel)
        ]
          ? {
              [balanceKey(request.chain, CHAINS[request.chain].nativeSentinel)]:
                proposal.snapshot.balances[
                  balanceKey(request.chain, CHAINS[request.chain].nativeSentinel)
                ]!,
            }
          : {}),
      },
    };

    const trade = d.trades.propose(action, 'approve', { route: { protocol: action.protocol } });
    const verdict = d.gate.decide(action, snapshot, proposal.priceLookup);
    d.trades.decide(trade.id, verdict);
    this.#auditVerdict(request.chain, 'LIVE', cycleId, trade.id, action, verdict);

    const tradeRef = { tradeId: trade.id, actionId: action.actionId };
    const riskRef = { allowed: verdict.allowed, code: verdict.code, reason: verdict.reason };
    if (!verdict.allowed) {
      return {
        outcome: 'rejected',
        reason: `approval ${verdict.code}: ${verdict.reason}`,
        trade: tradeRef,
        risk: riskRef,
      };
    }

    const tx = adapter.buildApprove(token.address, walletAddress, needed);
    const execution = await d.live.executeApprove(trade.id, action, tx, proposal.prices.nativeUsd);
    if (execution.status !== 'filled') {
      return {
        outcome: 'failed',
        reason: `approval failed: ${execution.error ?? 'unknown'}`,
        trade: tradeRef,
        risk: riskRef,
        execution,
      };
    }

    this.#log.info({ cycleId, tradeId: trade.id, txHash: execution.txHash }, 'approval confirmed');
    return null;
  }

  /** Cross-checked prices for every open position on the chain, for the mark. */
  async #positionPrices(
    mode: Mode,
    chain: ChainId,
  ): Promise<(c: ChainId, token: string) => string | null> {
    const prices = new Map<string, string>();
    const held = this.#deps.ledger
      .listPositions(mode)
      .filter((position) => position.chain === chain);
    await Promise.all(
      held.map(async (position) => {
        try {
          const result = await this.#deps.market.getCrossCheckedPrice(chain, position.token);
          if (result.priceUsd !== null && !result.disputed)
            prices.set(position.token, result.priceUsd);
        } catch (error) {
          this.#log.warn(
            { chain, token: position.token, err: error },
            'position price lookup failed',
          );
        }
      }),
    );
    return (c, token) => (c === chain ? (prices.get(token) ?? null) : null);
  }

  #auditVerdict(
    chain: ChainId,
    mode: Mode,
    cycleId: string,
    tradeId: string,
    action: ProposedAction,
    verdict: RiskDecision,
  ): void {
    const failing = verdict.checks.find((check) => !check.passed && check.skipped === undefined);
    this.#deps.audit.append({
      category: 'risk',
      action: verdict.allowed ? 'risk.allowed' : 'risk.rejected',
      status: verdict.allowed ? 'ok' : 'rejected',
      summary: verdict.allowed
        ? `Risk engine allowed ${action.kind} on ${chain} (${verdict.derived?.amountInUsd ?? '?'} USD)`
        : `Risk engine rejected ${action.kind} on ${chain}: ${verdict.code} — ${verdict.reason.slice(0, 160)}`,
      chain,
      actor: 'risk-engine',
      mode,
      correlationId: cycleId,
      detail: {
        tradeId,
        actionId: action.actionId,
        code: verdict.code,
        rule: failing?.name ?? null,
        observed: failing?.observed ?? null,
        limit: failing?.limit ?? null,
        policyHash: verdict.policyHash,
        engineVersion: verdict.engineVersion,
        ...(verdict.replayOf ? { replayOf: verdict.replayOf } : {}),
      },
    });
  }

  #end(
    request: CycleRequest,
    base: { cycleId: string; startedAt: number; mode: Mode; notes: string[] },
    outcome: CycleOutcome,
    reason: string,
    parts: Partial<
      Pick<CycleReport, 'research' | 'decision' | 'modelStatus' | 'trade' | 'risk' | 'execution'>
    >,
  ): CycleReport {
    const finishedAt = this.#now();
    const report: CycleReport = {
      cycleId: base.cycleId,
      chain: request.chain,
      mode: base.mode,
      startedAt: new Date(base.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      outcome,
      reason,
      research: parts.research ?? null,
      decision: parts.decision ?? null,
      modelStatus: parts.modelStatus ?? null,
      trade: parts.trade ?? null,
      risk: parts.risk ?? null,
      execution: parts.execution ?? null,
      notes: base.notes,
    };

    this.#deps.audit.append({
      category: 'trade',
      action: 'trade.cycle',
      status:
        outcome === 'filled'
          ? 'ok'
          : outcome === 'failed'
            ? 'failed'
            : outcome === 'rejected'
              ? 'rejected'
              : 'hold',
      summary: `Cycle ${outcome.replace('_', ' ')}: ${reason.slice(0, 200)}`,
      chain: request.chain,
      actor: request.source === 'operator' ? 'operator' : 'scheduler',
      mode: base.mode,
      correlationId: base.cycleId,
      detail: {
        outcome,
        durationMs: finishedAt - base.startedAt,
        researchId: report.research?.id ?? null,
        tradeId: report.trade?.tradeId ?? null,
        riskCode: report.risk?.code ?? null,
        txHash: report.execution?.txHash ?? null,
        notes: base.notes,
      },
    });

    this.#log.info(
      { cycleId: base.cycleId, chain: request.chain, outcome, reason },
      'cycle finished',
    );
    return report;
  }

  #report(
    request: CycleRequest,
    outcome: CycleOutcome,
    reason: string,
    parts: Partial<CycleReport>,
  ): CycleReport {
    const at = new Date(this.#now()).toISOString();
    return {
      cycleId: randomUUID(),
      chain: request.chain,
      mode: this.#deps.state.getMode(),
      startedAt: at,
      finishedAt: at,
      outcome,
      reason,
      research: null,
      decision: null,
      modelStatus: null,
      trade: null,
      risk: null,
      execution: null,
      notes: [],
      ...parts,
    };
  }
}
