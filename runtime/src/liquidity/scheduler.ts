import { Cron } from 'croner';
import type { StateStore } from '../core/state.js';
import type { AuditLog } from '../audit/audit.js';
import type { RiskPolicyStore } from '../risk/store.js';
import type { ChainId } from '../chains/registry.js';
import { childLogger } from '../logging/logger.js';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';
import type { LiquidityStore } from './store.js';
import type { LiquidityPipeline, LpCycleReport } from './pipeline.js';

/**
 * The LP scheduler.
 *
 * Every `intervalSeconds` it walks the policy's `lp.allowedPools` (on the
 * chains the installation enables) and runs one liquidity cycle per pool,
 * sequentially. Off by default and stored, so a restart cannot turn it on.
 * It checks the pause and emergency switches before each pass and between
 * pools, and an emergency stop disables it outright; the operator re-enables
 * it deliberately after clearing the stop.
 *
 * With LP disabled in the policy (no pools) an enabled schedule runs nothing,
 * and says so in the log.
 */

const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

export interface LpSchedulerStatus {
  enabled: boolean;
  intervalSeconds: number;
  running: boolean;
  lastCycleId: string | null;
  lastCycleAt: string | null;
  lastCycleStatus: string | null;
  nextRunAt: string | null;
}

export interface LiquiditySchedulerDeps {
  store: LiquidityStore;
  state: StateStore;
  audit: AuditLog;
  policy: RiskPolicyStore;
  pipeline: LiquidityPipeline;
  now?: () => number;
}

export class LiquidityScheduler {
  readonly #store: LiquidityStore;
  readonly #state: StateStore;
  readonly #audit: AuditLog;
  readonly #policy: RiskPolicyStore;
  readonly #pipeline: LiquidityPipeline;
  readonly #log = childLogger('lp-scheduler');
  #job: Cron | null = null;
  #running = false;

  constructor(deps: LiquiditySchedulerDeps) {
    this.#store = deps.store;
    this.#state = deps.state;
    this.#audit = deps.audit;
    this.#policy = deps.policy;
    this.#pipeline = deps.pipeline;
  }

  /** Arm the timer if the stored setting says so. Called once at boot. */
  start(): void {
    const status = this.status();
    if (status.enabled) this.#arm(status.intervalSeconds);
  }

  stop(): void {
    this.#job?.stop();
    this.#job = null;
  }

  status(): LpSchedulerStatus {
    const row = this.#store.scheduler();
    const next = this.#job?.nextRun() ?? null;
    return {
      enabled: row.enabled,
      intervalSeconds: row.intervalSeconds,
      running: this.#running || this.#pipeline.running,
      lastCycleId: row.lastCycleId,
      lastCycleAt: row.lastCycleAt,
      lastCycleStatus: row.lastCycleStatus,
      nextRunAt: next ? next.toISOString() : null,
    };
  }

  configure(enabled: boolean, intervalSeconds: number, actor: string): LpSchedulerStatus {
    if (
      !Number.isInteger(intervalSeconds) ||
      intervalSeconds < MIN_INTERVAL_SECONDS ||
      intervalSeconds > MAX_INTERVAL_SECONDS
    ) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        `intervalSeconds must be between ${String(MIN_INTERVAL_SECONDS)} and ${String(MAX_INTERVAL_SECONDS)}`,
        { errors: [{ path: 'intervalSeconds', message: 'out of range' }] },
      );
    }
    if (enabled && this.#state.getSwitches().emergencyStop) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'Clear the emergency stop before enabling LP automation',
      );
    }

    this.#store.setScheduler(enabled, intervalSeconds);
    this.#audit.append({
      category: 'system',
      action: enabled ? 'lp-scheduler.enabled' : 'lp-scheduler.disabled',
      status: 'ok',
      summary: enabled
        ? `LP automation enabled every ${String(intervalSeconds)}s`
        : 'LP automation disabled',
      actor,
      mode: this.#state.getMode(),
      detail: { intervalSeconds },
    });

    this.stop();
    if (enabled) this.#arm(intervalSeconds);
    return this.status();
  }

  /** Called by the emergency stop path: disable without waiting for a tick. */
  disableForEmergency(reason: string): void {
    this.stop();
    this.#store.disableScheduler();
    this.#log.warn({ reason }, 'LP automation disabled by emergency stop');
  }

  /** Run one pass over the allowlisted pools now, regardless of the timer. */
  async runOnce(source: 'scheduler' | 'operator'): Promise<LpCycleReport[]> {
    if (this.#running) {
      throw new AppError(ErrorCode.CONFLICT, 'A scheduled LP pass is already running');
    }
    const switches = this.#state.getSwitches();
    if (switches.emergencyStop) {
      throw new AppError(ErrorCode.CONFLICT, 'Emergency stop is active');
    }
    if (switches.globalPause) {
      throw new AppError(ErrorCode.CONFLICT, 'Runtime is paused');
    }

    this.#running = true;
    const reports: LpCycleReport[] = [];
    try {
      const pools = this.#pools();
      if (pools.length === 0) {
        this.#log.info('no allowlisted LP pools on an enabled chain; nothing to run');
      }
      for (const entry of pools) {
        // Re-check between pools: an emergency stop mid-pass ends the pass.
        const now = this.#state.getSwitches();
        if (now.emergencyStop || now.globalPause) break;
        try {
          const report = await this.#pipeline.runCycle({
            chain: entry.chain,
            poolId: entry.poolId,
            source,
          });
          reports.push(report);
          this.#store.recordCycle(report.cycleId, report.finishedAt, report.outcome);
        } catch (error) {
          this.#log.error({ entry, err: error }, 'lp cycle threw');
          this.#audit.append({
            category: 'system',
            action: 'lp-scheduler.error',
            status: 'failed',
            summary: `LP cycle for ${entry.protocol} ${entry.poolId} threw: ${errorMessage(error)}`,
            chain: entry.chain,
            actor: source,
            mode: this.#state.getMode(),
          });
        }
      }
    } finally {
      this.#running = false;
    }
    return reports;
  }

  #arm(intervalSeconds: number): void {
    this.stop();
    const pattern =
      intervalSeconds % 60 === 0 && intervalSeconds <= 3600
        ? `0 */${String(intervalSeconds / 60)} * * * *`
        : `*/${String(Math.min(intervalSeconds, 59))} * * * * *`;

    this.#job = new Cron(pattern, { protect: true, catch: true }, () => {
      void this.runOnce('scheduler').catch((error: unknown) => {
        this.#log.warn({ err: error }, 'scheduled LP pass skipped');
      });
    });
    this.#log.info({ intervalSeconds, pattern }, 'LP automation armed');
  }

  #pools(): Array<{ chain: ChainId; protocol: string; poolId: string }> {
    if (!this.#policy.exists()) return [];
    const enabled = new Set(this.#state.getInstallation()?.enabledChains ?? []);
    return this.#policy
      .get()
      .lp.allowedPools.filter((entry) => enabled.has(entry.chain))
      .map((entry) => ({ chain: entry.chain, protocol: entry.protocol, poolId: entry.poolId }));
  }
}
