import type { Db } from '../db/database.js';
import type { AuditLog } from '../audit/audit.js';
import type { StateStore } from '../core/state.js';
import type { LedgerService } from '../trading/ledger.js';
import type { TradeStore } from '../trading/trades.js';
import type { RiskGate } from '../risk/gate.js';
import type { RiskPolicyStore } from '../risk/store.js';
import type { WalletService } from '../wallet/service.js';
import type { MarketService } from '../market/service.js';
import type { LlmProvider } from '../llm/provider.js';
import type { ChainId } from '../chains/registry.js';
import { CHAINS } from '../chains/registry.js';
import type { Mode } from '../risk/types.js';
import { microsToUsd, usdToMicros } from '../risk/money.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { LiquidityManagerAgent } from '../agents/liquidity-manager/agent.js';
import { LiquidityStore } from './store.js';
import type { LpActionRecord, LpPositionRecord } from './store.js';
import type { LiquidityRegistry } from './registry.js';
import { LpProposalBuilder } from './proposal.js';
import { PaperLpExecutor } from './paper.js';
import { LiveLpExecutor } from './live.js';
import type { LpReconcileReport } from './live.js';
import { LiquidityPipeline } from './pipeline.js';
import type { LpCycleReport } from './pipeline.js';
import { LiquidityScheduler } from './scheduler.js';
import type { LpSchedulerStatus } from './scheduler.js';
import { VERIFIED_EXAMPLE_POOLS } from './protocols.js';

/**
 * The liquidity service: what the composition root constructs and the
 * dashboard routes read.
 *
 * It owns the LP ledger, the Liquidity Manager agent, the proposal builder,
 * both executors, the pipeline and the scheduler, and builds them from the
 * services the rest of the runtime already has. Wiring it is one constructor
 * call plus the emergency-stop hook.
 */

export interface LiquidityServiceDeps {
  db: Db;
  audit: AuditLog;
  state: StateStore;
  ledger: LedgerService;
  trades: TradeStore;
  gate: RiskGate;
  policy: RiskPolicyStore;
  wallets: WalletService;
  market: MarketService;
  llm: LlmProvider;
  registry: LiquidityRegistry;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The dashboard's action vocabulary (`COLLECT FEES` with a space). */
export type LpDashboardAction = 'HOLD' | 'ADD' | 'REMOVE' | 'REBALANCE' | 'COLLECT FEES' | 'EXIT';

export interface LpPositionView {
  id: string;
  pool: string;
  poolId: string;
  chain: string;
  chainId: ChainId;
  protocol: string;
  mode: Mode;
  valueUsd: string | null;
  capitalUsd: string;
  unrealizedUsd: string | null;
  /** v2 pools have no range. A concentrated-liquidity adapter would fill this. */
  range: { lowerUsd: string; upperUsd: string; inRange: boolean } | null;
  feesUsd: string | null;
  feesNote: string | null;
  lpTokens: string;
  amounts: {
    token0: { address: string; symbol: string; amount: string; decimals: number };
    token1: { address: string; symbol: string; amount: string; decimals: number };
  };
  lastAction: LpDashboardAction;
  lastActionAt: string;
  lastRebalanceAt: string | null;
  rebalance: { today: number; max: number; nextEligibleAt: string | null };
  status: 'SIMULATED' | 'ACTIVE';
  source: 'paper-sim' | 'chain';
  openedAt: string;
  markedAt: string | null;
}

export interface LpActionView {
  id: string;
  at: string;
  pool: string;
  poolId: string;
  chain: string;
  chainId: ChainId;
  protocol: string;
  mode: Mode;
  action: LpDashboardAction;
  status: LpActionRecord['status'];
  note: string;
  txHash: string | null;
  lpTokens: string | null;
  feeUsd: string | null;
  capitalUsd: string | null;
  /** The cycle id: every audit row of the cycle shares it as correlationId. */
  activityId: string;
}

export interface LpAutomationView {
  enabled: boolean;
  intervalSeconds: number;
  running: boolean;
  paused: boolean;
  nextRunAt: string | null;
  lastCycleAt: string | null;
  lastCycleStatus: string | null;
}

export interface LiquidityView {
  summary: {
    totalValueUsd: string | null;
    activePositions: number;
    unclaimedFeesUsd: string | null;
    requiresAttention: number;
    /** Set when a total is null: which positions could not be valued. */
    reason?: string;
  };
  positions: LpPositionView[];
  actions: LpActionView[];
  supportedProtocols: Array<{ id: string; name: string; chains: ChainId[] }>;
  adapters: ReturnType<LiquidityRegistry['list']>;
  verifiedExamplePools: typeof VERIFIED_EXAMPLE_POOLS;
  automation: LpAutomationView;
  modelStatus: 'UNTRAINED';
}

export class LiquidityService {
  readonly store: LiquidityStore;
  readonly agent: LiquidityManagerAgent;
  readonly builder: LpProposalBuilder;
  readonly paper: PaperLpExecutor;
  readonly live: LiveLpExecutor;
  readonly pipeline: LiquidityPipeline;
  readonly scheduler: LiquidityScheduler;
  readonly registry: LiquidityRegistry;

  readonly #state: StateStore;
  readonly #policy: RiskPolicyStore;
  readonly #audit: AuditLog;

  constructor(deps: LiquidityServiceDeps) {
    const now = deps.now ?? (() => Date.now());
    this.#state = deps.state;
    this.#policy = deps.policy;
    this.#audit = deps.audit;
    this.registry = deps.registry;
    this.store = new LiquidityStore(deps.db, now);
    this.agent = new LiquidityManagerAgent(deps.llm);
    this.builder = new LpProposalBuilder({
      ledger: deps.ledger,
      wallets: deps.wallets,
      store: this.store,
      now,
    });
    this.paper = new PaperLpExecutor({
      ledger: deps.ledger,
      trades: deps.trades,
      gate: deps.gate,
      audit: deps.audit,
      store: this.store,
      now,
    });
    this.live = new LiveLpExecutor({
      trades: deps.trades,
      gate: deps.gate,
      audit: deps.audit,
      wallets: deps.wallets,
      state: deps.state,
      store: this.store,
      registry: deps.registry,
      now,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    this.pipeline = new LiquidityPipeline({
      agent: this.agent,
      builder: this.builder,
      store: this.store,
      trades: deps.trades,
      gate: deps.gate,
      policy: deps.policy,
      state: deps.state,
      audit: deps.audit,
      wallets: deps.wallets,
      market: deps.market,
      registry: deps.registry,
      paper: this.paper,
      live: this.live,
      now,
    });
    this.scheduler = new LiquidityScheduler({
      store: this.store,
      state: deps.state,
      audit: deps.audit,
      policy: deps.policy,
      pipeline: this.pipeline,
      now,
    });
  }

  /** The hook the composition root registers with `state.onEmergencyStop`. */
  onEmergencyStop(active: boolean, reason: string | null): void {
    if (active) this.scheduler.disableForEmergency(reason ?? 'emergency stop');
  }

  /** Boot-time work: settle in-flight LP rows, then arm the schedule. */
  async start(): Promise<LpReconcileReport> {
    const report = await this.live.reconcile();
    if (report.checked > 0) {
      this.#audit.append({
        category: 'system',
        action: 'lp.reconciled',
        status: report.stillPending > 0 ? 'pending' : 'ok',
        summary: `Reconciled ${String(report.checked)} in-flight LP row(s): ${String(report.filled)} filled, ${String(report.failed)} failed, ${String(report.stillPending)} still pending`,
        mode: this.#state.getMode(),
        detail: { ...report },
      });
    }
    this.scheduler.start();
    return report;
  }

  stop(): void {
    this.scheduler.stop();
  }

  // --- dashboard --------------------------------------------------------------

  view(limit = 50): LiquidityView {
    const mode = this.#state.getMode();
    const positions = this.positions(mode);
    const attention = positions.filter(
      (p) => p.valueUsd === null || p.feesUsd === null || p.range?.inRange === false,
    ).length;

    const unvalued = positions.filter((p) => p.valueUsd === null);
    const unfeed = positions.filter((p) => p.feesUsd === null);
    const total = positions.reduce((sum, p) => sum + usdToMicros(p.valueUsd ?? '0'), 0n);
    const fees = positions.reduce((sum, p) => sum + usdToMicros(p.feesUsd ?? '0'), 0n);

    return {
      summary: {
        totalValueUsd: unvalued.length === 0 ? microsToUsd(total) : null,
        activePositions: positions.length,
        unclaimedFeesUsd: unfeed.length === 0 ? microsToUsd(fees) : null,
        requiresAttention: attention,
        ...(unvalued.length > 0
          ? { reason: `${String(unvalued.length)} position(s) not yet observed by a cycle` }
          : {}),
      },
      positions,
      actions: this.actions(limit, mode),
      supportedProtocols: this.registry.supportedProtocols(),
      adapters: this.registry.list(),
      verifiedExamplePools: VERIFIED_EXAMPLE_POOLS,
      automation: this.automation(),
      modelStatus: 'UNTRAINED',
    };
  }

  positions(mode: Mode = this.#state.getMode()): LpPositionView[] {
    const policy = this.#policy.exists() ? this.#policy.get() : undefined;
    return this.store.listPositions(mode).map((record) => this.#positionView(record, policy));
  }

  actions(limit = 50, mode?: Mode): LpActionView[] {
    return this.store
      .listActions({ limit, ...(mode ? { mode } : {}) })
      .map((record) => this.#actionView(record));
  }

  automation(): LpAutomationView {
    const status: LpSchedulerStatus = this.scheduler.status();
    return {
      enabled: status.enabled,
      intervalSeconds: status.intervalSeconds,
      running: status.running,
      paused: this.#state.getSwitches().globalPause,
      nextRunAt: status.nextRunAt,
      lastCycleAt: status.lastCycleAt,
      lastCycleStatus: status.lastCycleStatus,
    };
  }

  configureAutomation(enabled: boolean, intervalSeconds: number, actor: string): LpAutomationView {
    this.scheduler.configure(enabled, intervalSeconds, actor);
    return this.automation();
  }

  /** One cycle now, through the same path as the scheduler. */
  async run(chain: ChainId, poolId: string): Promise<LpCycleReport> {
    const switches = this.#state.getSwitches();
    if (switches.emergencyStop) {
      throw new AppError(ErrorCode.CONFLICT, 'Emergency stop is active');
    }
    if (switches.globalPause) {
      throw new AppError(ErrorCode.CONFLICT, 'Runtime is paused');
    }
    if (this.pipeline.running || this.scheduler.status().running) {
      throw new AppError(ErrorCode.CONFLICT, 'A liquidity cycle is already running');
    }
    const report = await this.pipeline.runCycle({ chain, poolId, source: 'operator' });
    this.store.recordCycle(report.cycleId, report.finishedAt, report.outcome);
    return report;
  }

  #positionView(
    record: LpPositionRecord,
    policy: ReturnType<RiskPolicyStore['get']> | undefined,
  ): LpPositionView {
    const symbol0 = symbolOf(record.chain, record.token0);
    const symbol1 = symbolOf(record.chain, record.token1);
    const today = this.store.rebalancesToday(record.mode, record.chain, record.poolId);
    const max = policy?.lp.maxRebalancePerDay ?? 0;
    const nextEligibleAt =
      today >= max
        ? new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 86_400_000).toISOString()
        : null;
    const unrealized =
      record.mark.valueUsd === null
        ? null
        : microsToUsd(usdToMicros(record.mark.valueUsd) - usdToMicros(record.capitalUsd));

    return {
      id: record.id,
      pool: `${symbol0}/${symbol1}`,
      poolId: record.poolId,
      chain: CHAINS[record.chain].displayName,
      chainId: record.chain,
      protocol: record.protocol,
      mode: record.mode,
      valueUsd: record.mark.valueUsd,
      capitalUsd: record.capitalUsd,
      unrealizedUsd: unrealized,
      range: null,
      feesUsd: record.mark.feesUsd,
      feesNote: record.mark.note,
      lpTokens: record.lpTokens,
      amounts: {
        token0: {
          address: record.token0,
          symbol: symbol0,
          amount: record.amount0,
          decimals: record.decimals0,
        },
        token1: {
          address: record.token1,
          symbol: symbol1,
          amount: record.amount1,
          decimals: record.decimals1,
        },
      },
      lastAction: dashboardAction(record.lastAction),
      lastActionAt: record.lastActionAt,
      lastRebalanceAt: record.lastRebalanceAt,
      rebalance: { today, max, nextEligibleAt },
      status: record.mode === 'PAPER' ? 'SIMULATED' : 'ACTIVE',
      source: record.mode === 'PAPER' ? 'paper-sim' : 'chain',
      openedAt: record.openedAt,
      markedAt: record.mark.markedAt,
    };
  }

  #actionView(record: LpActionRecord): LpActionView {
    const position = this.store.getPosition(
      record.mode,
      record.chain,
      record.protocol,
      record.poolId,
    );
    const pool = position
      ? `${symbolOf(record.chain, position.token0)}/${symbolOf(record.chain, position.token1)}`
      : record.poolId.slice(0, 10) + '…';
    return {
      id: record.id,
      at: record.at,
      pool,
      poolId: record.poolId,
      chain: CHAINS[record.chain].displayName,
      chainId: record.chain,
      protocol: record.protocol,
      mode: record.mode,
      action: dashboardAction(record.action),
      status: record.status,
      note: record.note,
      txHash: record.txHash,
      lpTokens: record.lpTokens,
      feeUsd: record.feeUsd,
      capitalUsd: record.capitalUsd,
      activityId: record.cycleId,
    };
  }
}

function dashboardAction(action: LpActionRecord['action']): LpDashboardAction {
  return action === 'COLLECT_FEES' ? 'COLLECT FEES' : action;
}

function symbolOf(chain: ChainId, token: string): string {
  return CHAINS[chain].tokens.find((entry) => entry.address === token)?.symbol ?? token.slice(0, 8);
}
