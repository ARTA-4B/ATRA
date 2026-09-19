import type { Db } from '../db/database.js';
import { closeDatabase, openDatabase } from '../db/database.js';
import { AuditLog } from '../audit/audit.js';
import { AuthService } from './auth.js';
import { StateStore } from './state.js';
import { Vault } from '../wallet/vault.js';
import { WalletService } from '../wallet/service.js';
import { RiskPolicyStore } from '../risk/store.js';
import { EvmChainAdapter } from '../chains/evm/adapter.js';
import { SolanaChainAdapter } from '../chains/solana/adapter.js';
import { CHAIN_IDS, CHAINS } from '../chains/registry.js';
import { MarketService } from '../market/service.js';
import { DexScreenerProvider } from '../market/providers/dexscreener.js';
import { GeckoTerminalProvider } from '../market/providers/geckoterminal.js';
import { ResearchAgent } from '../agents/research/agent.js';
import { TraderAgent } from '../agents/trader/agent.js';
import { HttpLlmProvider, NullLlmProvider } from '../llm/provider.js';
import { LedgerService } from '../trading/ledger.js';
import { TradeStore } from '../trading/trades.js';
import { RiskGate } from '../risk/gate.js';
import { ProposalBuilder } from '../trading/proposal.js';
import { AutoTradePipeline } from '../trading/pipeline.js';
import { AutoTradeScheduler } from '../trading/scheduler.js';
import { PaperExecutor } from '../execution/paper.js';
import { LiveExecutor } from '../execution/live.js';
import { ExecutionRegistry, buildExecutionRegistry } from '../execution/registry.js';
import type { ExecutionAdapter } from '../execution/types.js';
import { WithdrawalService } from '../wallet/withdrawal.js';
import { LiquidityService } from '../liquidity/service.js';
import { LiquidityRegistry, buildLiquidityRegistry } from '../liquidity/registry.js';
import type { LpAdapter } from '../liquidity/types.js';
import { TelegramService } from '../telegram/service.js';
import type { TelegramTransport } from '../telegram/transport.js';
import { readTelegramSecrets } from '../config/env.js';
import type { LlmProvider } from '../llm/provider.js';
import type { ChainId } from '../chains/registry.js';
import type { ChainAdapter } from '../chains/types.js';
import type { MarketDataProvider } from '../market/types.js';
import type { RuntimeConfig } from '../config/env.js';
import { childLogger } from '../logging/logger.js';
import { join } from 'node:path';
import type { KdfParams } from '../wallet/crypto.js';

/**
 * The composition root.
 *
 * Everything the runtime needs is constructed here, once, and passed down
 * explicitly. No module reaches for a global: that is what lets a test spin up
 * a complete runtime against an in-memory database with mock adapters, and it
 * keeps the dependency direction visible in one file.
 */
export interface Services {
  config: RuntimeConfig;
  db: Db;
  audit: AuditLog;
  auth: AuthService;
  state: StateStore;
  vault: Vault;
  wallets: WalletService;
  riskPolicy: RiskPolicyStore;
  adapters: Map<ChainId, ChainAdapter>;
  market: MarketService;
  llm: LlmProvider;
  research: ResearchAgent;
  // Phase 3
  ledger: LedgerService;
  trades: TradeStore;
  gate: RiskGate;
  execution: ExecutionRegistry;
  paper: PaperExecutor;
  live: LiveExecutor;
  trader: TraderAgent;
  builder: ProposalBuilder;
  pipeline: AutoTradePipeline;
  scheduler: AutoTradeScheduler;
  withdrawals: WithdrawalService;
  // Phase 4
  liquidity: LiquidityService;
  telegram: TelegramService;
  startedAt: Date;
}

export interface BuildOptions {
  /** Override the database location; tests pass ':memory:'. */
  databaseFile?: string;
  /** Skip building network adapters. Set automatically in ATRA_MODE=ci. */
  withAdapters?: boolean;
  /** Inject adapters directly, for tests. */
  adapters?: Map<ChainId, ChainAdapter>;
  /** Inject execution adapters, for tests. Default: none in CI, real ones otherwise. */
  executionAdapters?: ExecutionAdapter[];
  /** Override the reasoning provider, for tests. */
  llm?: LlmProvider;
  /** Override the market data providers, for tests. */
  marketProviders?: MarketDataProvider[];
  /** Inject liquidity-pool adapters, for tests. Default: none in CI, real ones otherwise. */
  liquidityAdapters?: LpAdapter[];
  /** Inject a Telegram transport, for tests. `null` forces "not configured". */
  telegramTransport?: TelegramTransport | null;
  /**
   * Weaker key-derivation parameters, so a test suite is not dominated by
   * Argon2. Only ever set from test code; the production entry point leaves it
   * undefined and the audited defaults apply.
   */
  kdfParams?: KdfParams;
}

export function buildServices(config: RuntimeConfig, options: BuildOptions = {}): Services {
  const log = childLogger('services');
  const databaseFile = options.databaseFile ?? join(config.dataDir, 'atra.db');

  const db = openDatabase({ file: databaseFile });
  const audit = new AuditLog(db);
  const auth = new AuthService(db, audit, options.kdfParams);
  const state = new StateStore(db, audit);
  const vault = new Vault(db, { autolockMs: config.autolockMs, kdfParams: options.kdfParams });
  const riskPolicy = new RiskPolicyStore(db, audit);

  const adapters =
    options.adapters ??
    ((options.withAdapters ?? !config.isCi)
      ? buildAdapters(config)
      : new Map<ChainId, ChainAdapter>());

  const wallets = new WalletService(db, vault, audit, adapters);

  // A policy change while LIVE drops the runtime back to PAPER. The operator
  // reviewed the old limits, not the new ones.
  riskPolicy.onChanged(() => {
    if (state.getMode() === 'LIVE') {
      state.revertToPaper('system', 'risk policy changed');
    }
  });

  // In CI mode there are no outbound calls at all, so the market layer gets no
  // providers and the model is the null provider. Everything above still works;
  // it simply reports that it has no data, which is what a smoke test wants to
  // exercise anyway.
  const market = new MarketService(
    options.marketProviders ??
      (config.isCi ? [] : [new DexScreenerProvider(), new GeckoTerminalProvider()]),
    db,
  );
  const llm = options.llm ?? buildLlmProvider(config);
  const research = new ResearchAgent(market, llm, { db, audit });

  // --- Phase 3: trading ----------------------------------------------------
  const ledger = new LedgerService(db);
  const trades = new TradeStore(db);
  const gate = new RiskGate({ db, audit, state, policy: riskPolicy, ledger });
  const execution =
    options.executionAdapters !== undefined
      ? new ExecutionRegistry(options.executionAdapters)
      : (options.withAdapters ?? !config.isCi)
        ? buildExecutionRegistry(config)
        : new ExecutionRegistry([]);
  const paper = new PaperExecutor({ ledger, trades, gate, audit });
  const live = new LiveExecutor({
    ledger,
    trades,
    gate,
    audit,
    wallets,
    state,
    registry: execution,
  });
  const trader = new TraderAgent(llm);
  const builder = new ProposalBuilder({ market, ledger, wallets });
  const pipeline = new AutoTradePipeline({
    research,
    trader,
    builder,
    market,
    trades,
    ledger,
    gate,
    policy: riskPolicy,
    state,
    audit,
    wallets,
    registry: execution,
    paper,
    live,
  });
  const scheduler = new AutoTradeScheduler({ db, state, audit, pipeline });
  const withdrawals = new WithdrawalService({ db, audit, wallets, state, market, adapters });

  // --- Phase 4: liquidity --------------------------------------------------
  const liquidityRegistry =
    options.liquidityAdapters !== undefined
      ? new LiquidityRegistry(options.liquidityAdapters)
      : (options.withAdapters ?? !config.isCi)
        ? buildLiquidityRegistry(config)
        : new LiquidityRegistry([]);
  const liquidity = new LiquidityService({
    db,
    audit,
    state,
    ledger,
    trades,
    gate,
    policy: riskPolicy,
    wallets,
    market,
    llm,
    registry: liquidityRegistry,
  });

  // --- Phase 4: Telegram ---------------------------------------------------
  const telegram = new TelegramService({
    db,
    audit,
    state,
    ledger,
    trades,
    riskPolicy,
    wallets,
    market,
    scheduler,
    config,
    llm,
    // /lp answers from the liquidity view; the bot never reaches into the
    // pipeline itself.
    liquidity: {
      summary: () => Promise.resolve(lpSummary(liquidity)),
    },
    secrets: readTelegramSecrets(),
    ...(options.telegramTransport !== undefined ? { transport: options.telegramTransport } : {}),
    startedAt: new Date(),
  });

  // An emergency stop disarms both schedules outright and tells the operator's
  // phone; the operator re-enables them deliberately after clearing the stop.
  state.onEmergencyStop((active, reason) => {
    if (active) {
      scheduler.disableForEmergency(reason ?? 'emergency stop');
      liquidity.onEmergencyStop(active, reason);
    }
    telegram.onEmergencyStop(active, reason);
  });
  state.onPauseChanged((paused, reason, actor) => {
    telegram.onPauseChanged(paused, reason, actor);
  });
  pipeline.onCycle((report) => {
    void telegram.onCycleReport(report);
  });

  log.info(
    {
      databaseFile: databaseFile === ':memory:' ? ':memory:' : databaseFile,
      adapters: [...adapters.keys()],
      mode: config.mode,
    },
    'services constructed',
  );

  return {
    config,
    db,
    audit,
    auth,
    state,
    vault,
    wallets,
    riskPolicy,
    adapters,
    market,
    llm,
    research,
    ledger,
    trades,
    gate,
    execution,
    paper,
    live,
    trader,
    builder,
    pipeline,
    scheduler,
    withdrawals,
    liquidity,
    telegram,
    startedAt: new Date(),
  };
}

/**
 * One line for the Telegram `/lp` command.
 *
 * Built from the same view the dashboard shows, so the two can never disagree;
 * an unpriced position is reported as unknown rather than as zero.
 */
function lpSummary(liquidity: LiquidityService): string {
  const view = liquidity.view(5);
  const lines = [
    `LP value ${view.summary.totalValueUsd} USD across ${String(view.summary.activePositions)} position(s)`,
    `Unclaimed fees ${view.summary.unclaimedFeesUsd} USD · ${String(view.summary.requiresAttention)} need attention`,
    `Automation ${view.automation.enabled ? 'on' : 'off'}${view.automation.nextRunAt ? ` · next ${view.automation.nextRunAt}` : ''}`,
  ];
  for (const position of view.positions.slice(0, 5)) {
    lines.push(`${position.chain} ${position.pool}: ${position.valueUsd} USD (${position.status})`);
  }
  return lines.join('\n');
}

/**
 * Build the reasoning provider from configuration.
 *
 * Defaults to a local Ollama endpoint, because a model on the operator's own
 * machine is the only configuration where the prompt never leaves it. An
 * unreachable endpoint is not an error here: the provider reports itself
 * unavailable and the agents degrade to observations only.
 *
 * The API key is read from the environment variable the operator names, never
 * from a config file that might be committed.
 */
export function buildLlmProvider(config: RuntimeConfig): LlmProvider {
  if (config.llm.kind === 'none') {
    return new NullLlmProvider('the runtime is configured without a reasoning model');
  }

  const endpoint =
    config.llm.url ?? (config.llm.kind === 'ollama' ? 'http://127.0.0.1:11434' : undefined);

  if (!endpoint) {
    return new NullLlmProvider('no model endpoint is configured');
  }

  const apiKey = config.llm.apiKeyEnv ? process.env[config.llm.apiKeyEnv] : undefined;

  return new HttpLlmProvider({
    kind: config.llm.kind,
    endpoint,
    model: config.llm.model ?? 'atra-4b',
    apiKey,
  });
}

/**
 * Build one adapter per supported chain.
 *
 * Construction never performs I/O, so a chain whose endpoint is down still has
 * an adapter and reports its failure through `health()` rather than vanishing
 * from the dashboard.
 */
export function buildAdapters(config: RuntimeConfig): Map<ChainId, ChainAdapter> {
  const adapters = new Map<ChainId, ChainAdapter>();

  for (const chain of CHAIN_IDS) {
    const override = config.rpcOverrides[chain];
    if (CHAINS[chain].family === 'evm') {
      adapters.set(chain, new EvmChainAdapter(chain, { rpcUrl: override }));
    } else {
      adapters.set(chain, new SolanaChainAdapter({ rpcUrl: override }));
    }
  }

  return adapters;
}

/**
 * Work that must happen once at boot, after construction and before the
 * scheduler runs: settle any trade that was in flight when the last process
 * died, then arm the schedule if the operator left it on.
 */
export async function startBackgroundServices(services: Services): Promise<void> {
  const log = childLogger('services');
  const report = await services.live.reconcile();
  if (report.checked > 0) {
    log.warn(report, 'reconciled in-flight trades from a previous run');
    services.audit.append({
      category: 'system',
      action: 'trades.reconciled',
      status: report.stillPending > 0 ? 'pending' : 'ok',
      summary: `Reconciled ${String(report.checked)} in-flight trade(s): ${String(report.filled)} filled, ${String(report.failed)} failed, ${String(report.stillPending)} still pending`,
      mode: services.state.getMode(),
      detail: { ...report },
    });
  }
  services.scheduler.start();

  const lp = await services.liquidity.start();
  if (lp.checked > 0) {
    log.warn(lp, 'reconciled in-flight LP actions from a previous run');
  }

  await services.telegram.start();
}

/**
 * Stop the background work that needs to finish cleanly: the Telegram
 * transport gets a moment to send its offline notice before the database
 * closes. Called from the signal handler, not from {@link shutdownServices},
 * which stays synchronous for the tests that tear a runtime down in place.
 */
export async function stopBackgroundServices(services: Services): Promise<void> {
  await services.telegram.stop();
  services.liquidity.stop();
  services.scheduler.stop();
}

/** Release everything. Safe to call more than once. */
export function shutdownServices(services: Services): void {
  services.scheduler.stop();
  services.liquidity.stop();
  services.vault.lock();
  closeDatabase(services.db);
}
