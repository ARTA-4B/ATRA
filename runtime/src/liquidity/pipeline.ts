import { randomUUID } from 'node:crypto';
import type { ChainId } from '../chains/registry.js';
import { CHAINS, canonicalizeAddress, chainFamily, isNativeToken } from '../chains/registry.js';
import type {
  LiquidityManagerAgent,
  LpAgentOutput,
  LpDecision,
} from '../agents/liquidity-manager/agent.js';
import type { TradeStore } from '../trading/trades.js';
import type { RiskGate } from '../risk/gate.js';
import type { RiskPolicyStore } from '../risk/store.js';
import type { RiskPolicy } from '../risk/policy.js';
import type { StateStore } from '../core/state.js';
import type { AuditLog } from '../audit/audit.js';
import type { WalletService } from '../wallet/service.js';
import type { MarketService } from '../market/service.js';
import type { ActionSource, Mode, ProposedAction, RiskDecision, Stamped } from '../risk/types.js';
import { balanceKey, priceKey, proposedActionSchema } from '../risk/types.js';
import { deriveIdempotencyKey } from '../risk/engine.js';
import { amountToBigint, microsToUsd, nativeToUsdMicros, priceToAtto } from '../risk/money.js';
import { childLogger } from '../logging/logger.js';
import { errorMessage } from '../util/errors.js';
import type { LiquidityStore, LpPositionRecord } from './store.js';
import type { LiquidityRegistry } from './registry.js';
import type { BuiltLpProposal, LpProposalBuilder, PriceMap } from './proposal.js';
import { positionValueMicros } from './proposal.js';
import type { PaperLpExecutor, LpExecutionOutcome } from './paper.js';
import type { LiveLpExecutor } from './live.js';
import type { LpAdapter, LpPoolState, LpPositionState, LpRecordedAction } from './types.js';
import { toRecordedAction } from './types.js';

/**
 * One liquidity-management cycle, end to end.
 *
 *   read pool + position ──> agent proposes ──> proposal built ──> risk engine ──> executor
 *          │                      │                   │                 │              │
 *     chain facts,           HOLD is the         deterministic       the only       PAPER sim
 *     cross-checked          default             sizing/quoting      authority      or LIVE sign
 *     prices
 *
 * The cycle is linear and every stage can end it. Each ending is recorded in
 * the audit log and the lp_actions table with the stage that ended it and
 * why, so "the agent did nothing" is always explained by a row.
 *
 * Nothing here signs. The executors do, and only the LIVE one — and only when
 * the trade row is `allowed`, which only the risk gate can write.
 */

export interface LpCycleRequest {
  chain: ChainId;
  poolId: string;
  source: ActionSource;
}

export type LpCycleOutcome = 'blocked' | 'skipped' | 'hold' | 'rejected' | 'filled' | 'failed';

export interface LpCycleReport {
  cycleId: string;
  chain: ChainId;
  poolId: string;
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  outcome: LpCycleOutcome;
  reason: string;
  decision: LpDecision | null;
  modelStatus: LpAgentOutput['modelStatus'] | null;
  trade: { tradeId: string; actionId: string } | null;
  risk: { allowed: boolean; code: RiskDecision['code']; reason: string } | null;
  execution: LpExecutionOutcome | null;
  position: LpPositionRecord | null;
  notes: string[];
}

export interface LiquidityPipelineDeps {
  agent: LiquidityManagerAgent;
  builder: LpProposalBuilder;
  store: LiquidityStore;
  trades: TradeStore;
  gate: RiskGate;
  policy: RiskPolicyStore;
  state: StateStore;
  audit: AuditLog;
  wallets: WalletService;
  market: MarketService;
  registry: LiquidityRegistry;
  paper: PaperLpExecutor;
  live: LiveLpExecutor;
  now?: () => number;
}

interface CycleBase {
  cycleId: string;
  startedAt: number;
  mode: Mode;
  poolId: string;
  notes: string[];
}

export class LiquidityPipeline {
  readonly #deps: LiquidityPipelineDeps;
  readonly #now: () => number;
  readonly #log = childLogger('lp-pipeline');
  #running = false;

  constructor(deps: LiquidityPipelineDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  get running(): boolean {
    return this.#running;
  }

  async runCycle(request: LpCycleRequest): Promise<LpCycleReport> {
    const base: CycleBase = {
      cycleId: randomUUID(),
      startedAt: this.#now(),
      mode: this.#deps.state.getMode(),
      poolId: canonicalizeAddress(request.chain, request.poolId),
      notes: [],
    };
    if (this.#running) {
      return this.#report(request, base, 'blocked', 'a liquidity cycle is already running');
    }
    this.#running = true;
    try {
      return await this.#run(request, base);
    } finally {
      this.#running = false;
    }
  }

  async #run(request: LpCycleRequest, base: CycleBase): Promise<LpCycleReport> {
    const d = this.#deps;
    const { cycleId, mode, notes, poolId } = base;

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

    let wallet: string;
    try {
      wallet = d.wallets.depositAddress(request.chain);
    } catch {
      return this.#end(
        request,
        base,
        'skipped',
        'create the agent wallets before running a cycle',
        {},
      );
    }

    // --- adapter -------------------------------------------------------------
    const status = d.registry.status(request.chain);
    const adapter = d.registry.get(request.chain);
    if (!adapter) {
      // No adapter means nothing can even be read. The HOLD is recorded so the
      // dashboard shows why the pool was skipped, without consulting a model.
      d.store.recordAction({
        cycleId,
        mode,
        chain: request.chain,
        protocol: 'none',
        poolId,
        action: 'HOLD',
        status: 'hold',
        note: status.reason,
      });
      d.audit.append({
        category: 'liquidity',
        action: 'liquidity.decision',
        status: 'hold',
        summary: `Liquidity manager: HOLD — ${status.reason.slice(0, 160)}`,
        chain: request.chain,
        actor: 'system',
        mode,
        correlationId: cycleId,
        detail: { poolId, executable: false, reason: status.reason },
      });
      return this.#end(request, base, 'skipped', status.reason, {});
    }

    // --- read ------------------------------------------------------------------
    let pool: LpPoolState;
    try {
      pool = await adapter.readPool(poolId);
    } catch (error) {
      return this.#end(request, base, 'skipped', `pool read failed: ${errorMessage(error)}`, {});
    }
    notes.push(
      `pool ${pool.poolId} ${pool.token0.symbol ?? pool.token0.address}/${pool.token1.symbol ?? pool.token1.address} reserves ${pool.reserve0}/${pool.reserve1} via ${pool.source}`,
    );

    const native = CHAINS[request.chain].tokens.find((t) =>
      isNativeToken(request.chain, t.address),
    )!;
    const prices = await this.#prices(request.chain, [
      pool.token0.address,
      pool.token1.address,
      native.address,
    ]);
    const price0 = prices.get(pool.token0.address);
    const price1 = prices.get(pool.token1.address);
    const priceNative = prices.get(native.address);

    const stored = d.store.getPosition(mode, request.chain, adapter.protocol, pool.poolId);
    const position = await this.#position(mode, adapter, wallet, pool, stored);
    const mark = this.#mark(mode, adapter, pool, position, stored, price0, price1);
    if (stored) {
      d.store.mark(mode, request.chain, adapter.protocol, pool.poolId, {
        valueUsd: mark.valueUsd,
        feesUsd: mark.feesUsd,
        note: mark.note,
        at: this.#now(),
      });
    }
    const poolLiquidityUsd =
      price0 && price1
        ? microsToUsd(
            nativeToUsdMicros(
              amountToBigint(pool.reserve0),
              pool.token0.decimals,
              priceToAtto(price0.value),
              'floor',
            ) +
              nativeToUsdMicros(
                amountToBigint(pool.reserve1),
                pool.token1.decimals,
                priceToAtto(price1.value),
                'floor',
              ),
          )
        : null;

    // --- decide ------------------------------------------------------------------
    const allowed = poolAllowlisted(policy, request.chain, adapter.protocol, pool.poolId);
    const agentOutput = await d.agent.decide({
      chain: request.chain,
      pool,
      position:
        position && amountToBigint(position.lpTokens) > 0n
          ? { ...position, capitalUsd: stored?.capitalUsd ?? null, valueUsd: mark.valueUsd }
          : null,
      prices: {
        token0Usd: price0?.value ?? null,
        token1Usd: price1?.value ?? null,
        nativeUsd: priceNative?.value ?? null,
      },
      poolLiquidityUsd,
      policy,
      eligibility: {
        poolAllowlisted: allowed.pool,
        protocolAllowlisted: allowed.protocol,
        rebalancesToday: d.store.rebalancesToday(mode, request.chain, pool.poolId),
        maxRebalancePerDay: policy.lp.maxRebalancePerDay,
        claimableFeesUsd: mark.feesUsd,
        minFeeThresholdUsd: policy.lp.minFeeThresholdUsd,
        rangeApplicable: pool.range !== null,
        feesSimulated: mode === 'PAPER',
      },
      executable: true,
      executableReason: status.reason,
      mode,
    });
    const decision = agentOutput.decision;
    const recorded = toRecordedAction(decision.action);

    d.audit.append({
      category: 'liquidity',
      action: 'liquidity.decision',
      status: decision.action === 'HOLD' ? 'hold' : 'ok',
      summary:
        decision.action === 'HOLD'
          ? `Liquidity manager: HOLD — ${decision.reason.slice(0, 160)}`
          : `Liquidity manager proposes ${decision.action} on ${pool.poolId.slice(0, 10)}…${
              decision.action === 'ADD_LIQUIDITY' ? ` for ${decision.capitalUsd} USD` : ''
            }`,
      chain: request.chain,
      actor: 'agent:liquidity-manager',
      mode,
      correlationId: cycleId,
      detail: {
        poolId: pool.poolId,
        model: agentOutput.model,
        modelStatus: agentOutput.modelStatus,
        fallback: agentOutput.fallback,
        overridden: agentOutput.overridden,
        latencyMs: agentOutput.latencyMs,
        decision,
      },
    });

    if (decision.action === 'HOLD') {
      d.store.recordAction({
        cycleId,
        mode,
        chain: request.chain,
        protocol: adapter.protocol,
        poolId: pool.poolId,
        action: 'HOLD',
        status: 'hold',
        note: decision.reason,
      });
      return this.#end(request, base, 'hold', decision.reason, {
        decision,
        modelStatus: agentOutput.modelStatus,
        position: stored ?? null,
      });
    }

    // --- build -------------------------------------------------------------------
    const built = await d.builder.build({
      chain: request.chain,
      mode,
      decisionCycleId: cycleId,
      source: request.source,
      walletAddress: wallet,
      decision,
      policy,
      adapter,
      pool,
      position,
      prices,
    });
    if (!built.ok) {
      notes.push(...built.notes);
      d.store.recordAction({
        cycleId,
        mode,
        chain: request.chain,
        protocol: adapter.protocol,
        poolId: pool.poolId,
        action: recorded,
        status: 'hold',
        note: `not built: ${built.reason}`,
      });
      d.audit.append({
        category: 'liquidity',
        action: 'liquidity.proposal',
        status: 'hold',
        summary: `LP proposal not built: ${built.reason.slice(0, 200)}`,
        chain: request.chain,
        actor: 'system',
        mode,
        correlationId: cycleId,
        detail: { decision, notes: built.notes },
      });
      return this.#end(request, base, 'skipped', built.reason, {
        decision,
        modelStatus: agentOutput.modelStatus,
        position: stored ?? null,
      });
    }
    const { proposal } = built;
    notes.push(...proposal.notes);

    // --- LIVE on EVM: the router must be allowed to pull what it moves ------------
    if (mode === 'LIVE' && chainFamily(request.chain) === 'evm') {
      for (const leg of approvalLegs(proposal, pool)) {
        const ending = await this.#ensureAllowance(
          cycleId,
          request,
          proposal,
          adapter,
          wallet,
          leg,
        );
        if (ending) {
          d.store.recordAction({
            cycleId,
            mode,
            chain: request.chain,
            protocol: adapter.protocol,
            poolId: pool.poolId,
            action: recorded,
            status: ending.outcome === 'rejected' ? 'rejected' : 'failed',
            tradeId: ending.trade?.tradeId ?? null,
            note: ending.reason,
          });
          return this.#end(request, base, ending.outcome, ending.reason, {
            decision,
            modelStatus: agentOutput.modelStatus,
            ...(ending.trade ? { trade: ending.trade } : {}),
            ...(ending.risk ? { risk: ending.risk } : {}),
            position: stored ?? null,
          });
        }
      }
    }

    // --- propose + decide ---------------------------------------------------------
    const route: Record<string, unknown> = {
      lp: true,
      protocol: adapter.protocol,
      poolId: pool.poolId,
      plan: proposal.plan.kind,
      ...(proposal.plan.kind === 'remove' ? { lpTokens: proposal.plan.quote.lpTokens } : {}),
    };
    const trade = d.trades.propose(proposal.action, proposal.side, { route });
    const verdict = d.gate.decide(proposal.action, proposal.snapshot, proposal.priceLookup);
    d.trades.decide(trade.id, verdict);
    this.#auditVerdict(request.chain, mode, cycleId, trade.id, proposal.action, verdict);

    const tradeRef = { tradeId: trade.id, actionId: proposal.action.actionId };
    const riskRef = { allowed: verdict.allowed, code: verdict.code, reason: verdict.reason };

    if (!verdict.allowed) {
      d.store.recordAction({
        cycleId,
        tradeId: trade.id,
        mode,
        chain: request.chain,
        protocol: adapter.protocol,
        poolId: pool.poolId,
        action: proposal.recorded,
        status: 'rejected',
        capitalUsd: proposal.action.lp?.capitalUsd ?? null,
        note: `${verdict.code}: ${verdict.reason}`,
      });
      return this.#end(request, base, 'rejected', `${verdict.code}: ${verdict.reason}`, {
        decision,
        modelStatus: agentOutput.modelStatus,
        trade: tradeRef,
        risk: riskRef,
        position: stored ?? null,
      });
    }

    // --- execute --------------------------------------------------------------------
    const execution =
      mode === 'PAPER'
        ? d.paper.execute(trade.id, proposal.action, proposal.plan, pool, proposal.prices)
        : await d.live.execute(trade.id, proposal.action, proposal.plan, pool, proposal.prices);

    // A position that just changed is marked now, from the pool and prices
    // this cycle read, so the dashboard shows a dated value straight away.
    const after = d.store.getPosition(mode, request.chain, adapter.protocol, pool.poolId);
    if (after) {
      const fresh = this.#mark(mode, adapter, pool, null, after, price0, price1);
      d.store.mark(mode, request.chain, adapter.protocol, pool.poolId, {
        valueUsd: fresh.valueUsd,
        feesUsd: fresh.feesUsd,
        note: fresh.note,
        at: this.#now(),
      });
    }

    d.store.recordAction({
      cycleId,
      tradeId: trade.id,
      mode,
      chain: request.chain,
      protocol: adapter.protocol,
      poolId: pool.poolId,
      action: proposal.recorded,
      status: execution.status,
      txHash: execution.txHash,
      lpTokens: execution.lpTokens,
      amount0: execution.amount0,
      amount1: execution.amount1,
      feeUsd: execution.feeUsd,
      capitalUsd: proposal.action.lp?.capitalUsd ?? null,
      note:
        execution.status === 'filled'
          ? `${mode} ${proposal.recorded.toLowerCase()} filled${mode === 'PAPER' ? ' (simulated)' : ''}`
          : (execution.error ?? 'execution failed'),
    });

    return this.#end(
      request,
      base,
      execution.status === 'filled' ? 'filled' : 'failed',
      execution.status === 'filled'
        ? `${mode} ${proposal.recorded} filled: ${execution.lpTokens ?? '?'} LP`
        : (execution.error ?? 'execution failed'),
      {
        decision,
        modelStatus: agentOutput.modelStatus,
        trade: tradeRef,
        risk: riskRef,
        execution,
        position: after ?? null,
      },
    );
  }

  /**
   * The wallet's position: the chain's reading in LIVE, the LP ledger's in
   * PAPER (with the share of the reserves recomputed from the live pool, so
   * the paper position moves with the market exactly as a real one would).
   */
  async #position(
    mode: Mode,
    adapter: LpAdapter,
    wallet: string,
    pool: LpPoolState,
    stored: LpPositionRecord | undefined,
  ): Promise<LpPositionState | null> {
    if (mode === 'LIVE') {
      try {
        return await adapter.readPosition(wallet, pool.poolId);
      } catch (error) {
        this.#log.warn(
          { chain: pool.chain, poolId: pool.poolId, err: error },
          'position read failed',
        );
        return null;
      }
    }
    if (!stored) return null;
    const lpTokens = amountToBigint(stored.lpTokens);
    const totalSupply = amountToBigint(pool.totalSupply);
    const amount0 =
      totalSupply > 0n ? (lpTokens * amountToBigint(pool.reserve0)) / totalSupply : 0n;
    const amount1 =
      totalSupply > 0n ? (lpTokens * amountToBigint(pool.reserve1)) / totalSupply : 0n;
    return {
      chain: pool.chain,
      protocol: adapter.protocol,
      poolId: pool.poolId,
      owner: wallet.toLowerCase(),
      lpTokens: stored.lpTokens,
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      claimable0: null,
      claimable1: null,
      claimNote: 'fee accrual is not simulated in PAPER',
      observedAt: this.#now(),
      source: 'paper-sim',
    };
  }

  /** What the position is worth now, and what fees it could claim. Null when unpriced. */
  #mark(
    mode: Mode,
    adapter: LpAdapter,
    pool: LpPoolState,
    position: LpPositionState | null,
    stored: LpPositionRecord | undefined,
    price0: Stamped<string> | undefined,
    price1: Stamped<string> | undefined,
  ): { valueUsd: string | null; feesUsd: string | null; note: string | null } {
    const lpTokens = position
      ? amountToBigint(position.lpTokens)
      : stored
        ? amountToBigint(stored.lpTokens)
        : 0n;
    if (!price0 || !price1) {
      return {
        valueUsd: null,
        feesUsd: null,
        note: 'unpriced: no reliable USD price for a pool asset',
      };
    }
    const atto0 = priceToAtto(price0.value);
    const atto1 = priceToAtto(price1.value);
    const valueUsd = microsToUsd(positionValueMicros(pool, lpTokens, atto0, atto1));
    if (mode === 'PAPER') {
      return { valueUsd, feesUsd: '0.000000', note: 'fee accrual is not simulated in PAPER' };
    }
    if (!position || position.claimable0 === null || position.claimable1 === null) {
      // A protocol that tracks claimable fees but whose reading failed is
      // "unknown", never zero; one that compounds fees has nothing to claim.
      return {
        valueUsd,
        feesUsd: adapter.claimsFees ? null : '0.000000',
        note: position?.claimNote ?? 'fees compound into the reserves; nothing to claim separately',
      };
    }
    const fees =
      nativeToUsdMicros(amountToBigint(position.claimable0), pool.token0.decimals, atto0, 'floor') +
      nativeToUsdMicros(amountToBigint(position.claimable1), pool.token1.decimals, atto1, 'floor');
    return { valueUsd, feesUsd: microsToUsd(fees), note: position.claimNote };
  }

  async #prices(chain: ChainId, tokens: string[]): Promise<PriceMap> {
    const out: PriceMap = new Map();
    await Promise.all(
      [...new Set(tokens)].map(async (token) => {
        try {
          const result = await this.#deps.market.getCrossCheckedPrice(chain, token);
          if (result.priceUsd === null || result.disputed) return;
          const observedAt = result.sources
            .map((source) => Date.parse(source.observedAt))
            .reduce((oldest, at) => Math.min(oldest, at), Number.POSITIVE_INFINITY);
          out.set(token, {
            value: result.priceUsd,
            at: Number.isFinite(observedAt) ? observedAt : this.#now(),
            source: result.sources.map((source) => source.source).join('+'),
          });
        } catch (error) {
          this.#log.warn({ chain, token, err: error }, 'price lookup failed');
        }
      }),
    );
    return out;
  }

  /**
   * Make sure the router can pull one leg: a pool asset for an add, the LP
   * token for a removal. Exact amount, never unlimited, through the risk
   * engine as an `approve` action with its own fee and spender checks.
   * Returns null when the allowance suffices or the approval confirmed.
   */
  async #ensureAllowance(
    cycleId: string,
    request: LpCycleRequest,
    proposal: BuiltLpProposal,
    adapter: LpAdapter,
    wallet: string,
    leg: ApprovalLeg,
  ): Promise<{
    outcome: LpCycleOutcome;
    reason: string;
    trade?: { tradeId: string; actionId: string };
    risk?: { allowed: boolean; code: RiskDecision['code']; reason: string };
  } | null> {
    const d = this.#deps;
    let current: bigint;
    try {
      current = await adapter.allowance(leg.token.address, wallet);
    } catch (error) {
      return { outcome: 'skipped', reason: `allowance read failed: ${errorMessage(error)}` };
    }
    if (current >= leg.amount) return null;

    let fee: ProposedAction['feeEstimate'];
    try {
      fee = await adapter.approveFeeEstimate();
    } catch (error) {
      return { outcome: 'skipped', reason: `approval fee estimate failed: ${errorMessage(error)}` };
    }

    const lpLeg = proposal.action.lp!;
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
      protocol: adapter.protocol,
      contract: proposal.plan.kind === 'claim' ? adapter.contracts[0]! : proposal.action.contract,
      reduceOnly: false,
      tokenIn: leg.token,
      tokenOut: leg.token,
      amountIn: leg.amount.toString(),
      quote: null,
      feeEstimate: fee,
      ...(leg.isLpToken
        ? {
            lp: {
              poolId: lpLeg.poolId,
              capitalUsd: lpLeg.capitalUsd,
              rebalanceIndexToday: lpLeg.rebalanceIndexToday,
              claimableFeesUsd: '0',
            },
          }
        : {}),
      rationale: `exact approval of ${leg.amount.toString()} ${leg.label} for the LP ${proposal.recorded.toLowerCase()} that follows`,
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

    const native = CHAINS[request.chain].nativeSentinel;
    const pick = (record: Record<string, Stamped<string>>, key: string) =>
      record[key] ? { [key]: record[key] } : {};
    const snapshot = {
      prices: {
        ...pick(proposal.snapshot.prices, priceKey(request.chain, leg.token.address)),
        ...pick(proposal.snapshot.prices, priceKey(request.chain, native)),
      },
      liquidity: {},
      balances: {
        ...pick(proposal.snapshot.balances, balanceKey(request.chain, leg.token.address)),
        ...pick(proposal.snapshot.balances, balanceKey(request.chain, native)),
      },
      ...(proposal.snapshot.lp ? { lp: proposal.snapshot.lp } : {}),
    };

    const trade = d.trades.propose(action, 'approve', {
      route: { lp: true, protocol: action.protocol, poolId: lpLeg.poolId, leg: leg.label },
    });
    const verdict = d.gate.decide(action, snapshot, proposal.priceLookup);
    d.trades.decide(trade.id, verdict);
    this.#auditVerdict(request.chain, 'LIVE', cycleId, trade.id, action, verdict);

    const tradeRef = { tradeId: trade.id, actionId: action.actionId };
    const riskRef = { allowed: verdict.allowed, code: verdict.code, reason: verdict.reason };
    if (!verdict.allowed) {
      return {
        outcome: 'rejected',
        reason: `approval of ${leg.label} ${verdict.code}: ${verdict.reason}`,
        trade: tradeRef,
        risk: riskRef,
      };
    }

    const tx = adapter.buildApprove(leg.token.address, wallet, leg.amount);
    const execution = await d.live.executeApprove(trade.id, action, tx, proposal.prices.nativeUsd);
    if (execution.status !== 'filled') {
      return {
        outcome: 'failed',
        reason: `approval of ${leg.label} failed: ${execution.error ?? 'unknown'}`,
        trade: tradeRef,
        risk: riskRef,
      };
    }
    this.#log.info(
      { cycleId, tradeId: trade.id, txHash: execution.txHash },
      'lp approval confirmed',
    );
    return null;
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
        ? `Risk engine allowed ${action.kind} on ${chain} (${action.lp?.capitalUsd ?? verdict.derived?.amountInUsd ?? '?'} USD)`
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
    request: LpCycleRequest,
    base: CycleBase,
    outcome: LpCycleOutcome,
    reason: string,
    parts: Partial<
      Pick<LpCycleReport, 'decision' | 'modelStatus' | 'trade' | 'risk' | 'execution' | 'position'>
    >,
  ): LpCycleReport {
    const finishedAt = this.#now();
    const report: LpCycleReport = {
      cycleId: base.cycleId,
      chain: request.chain,
      poolId: base.poolId,
      mode: base.mode,
      startedAt: new Date(base.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      outcome,
      reason,
      decision: parts.decision ?? null,
      modelStatus: parts.modelStatus ?? null,
      trade: parts.trade ?? null,
      risk: parts.risk ?? null,
      execution: parts.execution ?? null,
      position: parts.position ?? null,
      notes: base.notes,
    };

    this.#deps.audit.append({
      category: 'liquidity',
      action: 'liquidity.cycle',
      status:
        outcome === 'filled'
          ? 'ok'
          : outcome === 'failed'
            ? 'failed'
            : outcome === 'rejected'
              ? 'rejected'
              : 'hold',
      summary: `LP cycle ${outcome}: ${reason.slice(0, 200)}`,
      chain: request.chain,
      actor: request.source === 'operator' ? 'operator' : 'scheduler',
      mode: base.mode,
      correlationId: base.cycleId,
      detail: {
        outcome,
        poolId: base.poolId,
        durationMs: finishedAt - base.startedAt,
        tradeId: report.trade?.tradeId ?? null,
        riskCode: report.risk?.code ?? null,
        txHash: report.execution?.txHash ?? null,
        notes: base.notes,
      },
    });

    this.#log.info(
      { cycleId: base.cycleId, chain: request.chain, outcome, reason },
      'lp cycle finished',
    );
    return report;
  }

  #report(
    request: LpCycleRequest,
    base: CycleBase,
    outcome: LpCycleOutcome,
    reason: string,
  ): LpCycleReport {
    const at = new Date(this.#now()).toISOString();
    return {
      cycleId: base.cycleId,
      chain: request.chain,
      poolId: base.poolId,
      mode: base.mode,
      startedAt: at,
      finishedAt: at,
      outcome,
      reason,
      decision: null,
      modelStatus: null,
      trade: null,
      risk: null,
      execution: null,
      position: null,
      notes: [],
    };
  }
}

interface ApprovalLeg {
  token: { address: string; decimals: number };
  amount: bigint;
  label: string;
  isLpToken: boolean;
}

/** Which allowances an LP transaction needs the router to hold. */
function approvalLegs(proposal: BuiltLpProposal, pool: LpPoolState): ApprovalLeg[] {
  const plan = proposal.plan;
  if (plan.kind === 'add') {
    return [
      {
        token: { address: pool.token0.address, decimals: pool.token0.decimals },
        amount: amountToBigint(plan.quote.amount0),
        label: pool.token0.symbol ?? 'token0',
        isLpToken: false,
      },
      {
        token: { address: pool.token1.address, decimals: pool.token1.decimals },
        amount: amountToBigint(plan.quote.amount1),
        label: pool.token1.symbol ?? 'token1',
        isLpToken: false,
      },
    ];
  }
  if (plan.kind === 'remove') {
    return [
      {
        token: { address: pool.poolId, decimals: pool.lpTokenDecimals },
        amount: amountToBigint(plan.quote.lpTokens),
        label: 'LP token',
        isLpToken: true,
      },
    ];
  }
  // A claim is a call on the pool by the holder; nothing is pulled.
  return [];
}

/** Whether the policy allows this pool and its protocol. */
export function poolAllowlisted(
  policy: RiskPolicy,
  chain: ChainId,
  protocol: string,
  poolId: string,
): { pool: boolean; protocol: boolean } {
  const canonical = canonicalizeAddress(chain, poolId);
  return {
    protocol: (policy.lp.allowedProtocols[chain] ?? []).includes(protocol),
    pool: policy.lp.allowedPools.some(
      (entry) =>
        entry.chain === chain &&
        entry.protocol === protocol &&
        canonicalizeAddress(chain, entry.poolId) === canonical,
    ),
  };
}

export type { LpRecordedAction };
