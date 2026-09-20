import type { Db } from '../db/database.js';
import type { StateStore } from '../core/state.js';
import type { AuditLog } from '../audit/audit.js';
import type { AutoTradePipeline, CycleReport } from './pipeline.js';
import type { ChainId } from '../chains/registry.js';
import { isChainId } from '../chains/registry.js';
import { childLogger } from '../logging/logger.js';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';

/**
 * The auto-trade scheduler.
 *
 * Every `intervalSeconds` it walks the operator's watchlist and runs one
 * pipeline cycle per entry, sequentially. It is off by default and stays off
 * across restarts unless the operator enabled it; enabling it is a stored
 * setting, not a process flag, so a container restart cannot turn it on.
 *
 * It checks the pause and emergency switches itself before each run in
 * addition to the pipeline's own checks, so a stopped runtime does not even
 * start a cycle. An emergency stop also disables the schedule outright: the
 * operator must re-enable it deliberately after clearing the stop.
 */

const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

export interface SchedulerStatus {
  enabled: boolean;
  intervalSeconds: number;
  running: boolean;
  lastCycleId: string | null;
  lastCycleAt: string | null;
  lastCycleStatus: string | null;
  nextRunAt: string | null;
}

export interface SchedulerDeps {
  db: Db;
  state: StateStore;
  audit: AuditLog;
  pipeline: AutoTradePipeline;
  now?: () => number;
}

export class AutoTradeScheduler {
  readonly #db: Db;
  readonly #state: StateStore;
  readonly #audit: AuditLog;
  readonly #pipeline: AutoTradePipeline;
  readonly #now: () => number;
  readonly #log = childLogger('scheduler');
  #timer: ReturnType<typeof setInterval> | null = null;
  #nextRunAt: number | null = null;
  #running = false;

  constructor(deps: SchedulerDeps) {
    this.#db = deps.db;
    this.#state = deps.state;
    this.#audit = deps.audit;
    this.#pipeline = deps.pipeline;
    this.#now = deps.now ?? (() => Date.now());
    this.#ensureRow();
  }

  /** Arm the timer if the stored setting says so. Called once at boot. */
  start(): void {
    const status = this.status();
    if (status.enabled) this.#arm(status.intervalSeconds);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#nextRunAt = null;
  }

  status(): SchedulerStatus {
    const row = this.#row();
    return {
      enabled: row.auto_trade_enabled === 1,
      intervalSeconds: row.interval_seconds,
      running: this.#running,
      lastCycleId: row.last_cycle_id,
      lastCycleAt: row.last_cycle_at,
      lastCycleStatus: row.last_cycle_status,
      nextRunAt: this.#nextRunAt === null ? null : new Date(this.#nextRunAt).toISOString(),
    };
  }

  configure(enabled: boolean, intervalSeconds: number, actor: string): SchedulerStatus {
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
      throw new AppError(ErrorCode.CONFLICT, 'Clear the emergency stop before enabling auto-trade');
    }

    this.#db
      .prepare(
        'UPDATE scheduler_state SET auto_trade_enabled = ?, interval_seconds = ?, updated_at = ? WHERE id = 1',
      )
      .run(enabled ? 1 : 0, intervalSeconds, new Date(this.#now()).toISOString());

    this.#audit.append({
      category: 'system',
      action: enabled ? 'scheduler.enabled' : 'scheduler.disabled',
      status: 'ok',
      summary: enabled
        ? `Auto-trade enabled every ${String(intervalSeconds)}s`
        : 'Auto-trade disabled',
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
    this.#db
      .prepare('UPDATE scheduler_state SET auto_trade_enabled = 0, updated_at = ? WHERE id = 1')
      .run(new Date(this.#now()).toISOString());
    this.#log.warn({ reason }, 'auto-trade disabled by emergency stop');
  }

  /** Run one pass over the watchlist now, regardless of the timer. */
  async runOnce(source: 'scheduler' | 'operator'): Promise<CycleReport[]> {
    if (this.#running) {
      throw new AppError(ErrorCode.CONFLICT, 'A scheduled pass is already running');
    }
    const switches = this.#state.getSwitches();
    if (switches.emergencyStop) {
      throw new AppError(ErrorCode.CONFLICT, 'Emergency stop is active');
    }
    if (switches.globalPause) {
      throw new AppError(ErrorCode.CONFLICT, 'Runtime is paused');
    }

    this.#running = true;
    const reports: CycleReport[] = [];
    try {
      const entries = this.#watchlist();
      if (entries.length === 0) {
        this.#log.info('watchlist is empty; nothing to run');
      }
      for (const entry of entries) {
        // Re-check between entries: an emergency stop mid-pass ends the pass.
        if (this.#state.getSwitches().emergencyStop || this.#state.getSwitches().globalPause) break;
        try {
          const report = await this.#pipeline.runCycle({
            chain: entry.chain,
            poolId: entry.poolId,
            source,
          });
          reports.push(report);
          this.#record(report);
        } catch (error) {
          this.#log.error({ entry, err: error }, 'cycle threw');
          this.#audit.append({
            category: 'system',
            action: 'scheduler.error',
            status: 'failed',
            summary: `Cycle for ${entry.label} threw: ${errorMessage(error)}`,
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

  /**
   * Arm a plain period.
   *
   * This used to build a cron pattern, and every interval that was not a
   * whole number of minutes up to an hour fell through to
   * `*\/${Math.min(interval, 59)} * * * * *`. The minimum interval is 60 s,
   * so that expression was always `*\/59 * * * * *`, which fires at :00 and
   * :59 of every minute: an operator asking for one pass a day got one every
   * thirty seconds. A period is what the setting means, so a period is what
   * is armed.
   */
  #arm(intervalSeconds: number): void {
    this.stop();
    const periodMs = intervalSeconds * 1_000;
    this.#nextRunAt = this.#now() + periodMs;

    const timer = setInterval(() => {
      this.#nextRunAt = this.#now() + periodMs;
      // runOnce refuses to overlap itself, so a pass that outlives its
      // period is skipped rather than queued.
      void this.runOnce('scheduler').catch((error: unknown) => {
        this.#log.warn({ err: error }, 'scheduled pass skipped');
      });
    }, periodMs);
    // The HTTP server holds the process open; a pending pass must not.
    timer.unref?.();

    this.#timer = timer;
    this.#log.info({ intervalSeconds }, 'auto-trade armed');
  }

  #watchlist(): Array<{ chain: ChainId; poolId: string; label: string }> {
    const enabled = new Set(this.#state.getInstallation()?.enabledChains ?? []);
    return this.#db
      .prepare<[], { chain: string; pool_id: string; label: string }>(
        'SELECT chain, pool_id, label FROM watchlist ORDER BY created_at',
      )
      .all()
      .filter((row): row is { chain: ChainId; pool_id: string; label: string } =>
        isChainId(row.chain),
      )
      .filter((row) => enabled.has(row.chain))
      .map((row) => ({ chain: row.chain, poolId: row.pool_id, label: row.label }));
  }

  #record(report: CycleReport): void {
    this.#db
      .prepare(
        'UPDATE scheduler_state SET last_cycle_id = ?, last_cycle_at = ?, last_cycle_status = ?, updated_at = ? WHERE id = 1',
      )
      .run(report.cycleId, report.finishedAt, report.outcome, new Date(this.#now()).toISOString());
  }

  #ensureRow(): void {
    this.#db
      .prepare(
        'INSERT INTO scheduler_state (id, auto_trade_enabled, interval_seconds, updated_at) VALUES (1, 0, 300, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(new Date(this.#now()).toISOString());
  }

  #row(): SchedulerRow {
    return this.#db.prepare<[], SchedulerRow>('SELECT * FROM scheduler_state WHERE id = 1').get()!;
  }
}

interface SchedulerRow {
  id: number;
  auto_trade_enabled: number;
  interval_seconds: number;
  last_cycle_id: string | null;
  last_cycle_at: string | null;
  last_cycle_status: string | null;
  updated_at: string;
}
