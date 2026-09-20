import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/database.js';
import type { Db } from '../src/db/database.js';
import { AuditLog } from '../src/audit/audit.js';
import { StateStore } from '../src/core/state.js';
import { AutoTradeScheduler } from '../src/trading/scheduler.js';
import type { AutoTradePipeline } from '../src/trading/pipeline.js';

/**
 * How often the scheduler actually fires.
 *
 * The interval used to be encoded as a cron pattern, and every interval that
 * was not a whole number of minutes up to an hour fell through to a
 * seconds-step pattern of `min(interval, 59)`. Since the minimum interval is
 * 60 seconds that step was always 59, which fires at :00 and :59 of every
 * minute: an operator who asked for one pass a day got one every thirty
 * seconds, and the only thing standing between that and a stream of trades
 * was the engine's cooldowns. These tests measure the firing rate rather than
 * the pattern, so the same mistake cannot come back in another
 * form.
 */

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

describe('AutoTradeScheduler timing', () => {
  let db: Db;
  let scheduler: AutoTradeScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    db = openDatabase({ file: ':memory:' });
    const audit = new AuditLog(db);
    const state = new StateStore(db, audit);
    state.createInstallation('i', 'test', ['base']);

    // The pipeline is never reached: these tests count how often the timer
    // asks for a pass, not what a pass does.
    const pipeline = {} as AutoTradePipeline;
    scheduler = new AutoTradeScheduler({ db, state, audit, pipeline, now: () => Date.now() });
  });

  afterEach(() => {
    scheduler.stop();
    closeDatabase(db);
    vi.useRealTimers();
  });

  /** Arm the scheduler and count the passes it asks for. */
  function armed(intervalSeconds: number) {
    const passes = vi.spyOn(scheduler, 'runOnce').mockResolvedValue([]);
    scheduler.configure(true, intervalSeconds, 'test');
    return passes;
  }

  it('fires once per period for an interval that is not a whole minute', () => {
    const passes = armed(90);

    vi.advanceTimersByTime(89_000);
    expect(passes).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(passes).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(90_000);
    expect(passes).toHaveBeenCalledTimes(2);
  });

  it('fires once a day when the operator asks for once a day', () => {
    const passes = armed(24 * 60 * 60);

    // The old pattern fired twice a minute: 2,880 passes in this window.
    vi.advanceTimersByTime(23 * 60 * 60 * 1_000);
    expect(passes).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60 * 60 * 1_000);
    expect(passes).toHaveBeenCalledTimes(1);
  });

  it('fires on the hour for a whole-minute interval, with no wrap at :00', () => {
    // 7 minutes used to become "0 */7 * * * *", which runs at :56 and then
    // :00 — a four-minute gap every hour.
    const passes = armed(7 * 60);

    for (let minute = 7; minute <= 70; minute += 7) {
      vi.advanceTimersByTime(7 * 60 * 1_000);
      expect(passes).toHaveBeenCalledTimes(minute / 7);
    }
  });

  it('reports the next run one period out, and forgets it when stopped', () => {
    armed(300);
    expect(scheduler.status().nextRunAt).toBe(new Date(NOW + 300_000).toISOString());

    scheduler.stop();
    expect(scheduler.status().nextRunAt).toBeNull();
  });

  it('stops firing once disabled', () => {
    const passes = armed(60);
    vi.advanceTimersByTime(60_000);
    expect(passes).toHaveBeenCalledTimes(1);

    scheduler.configure(false, 60, 'test');
    vi.advanceTimersByTime(10 * 60_000);
    expect(passes).toHaveBeenCalledTimes(1);
  });

  it('does not queue a second pass while one is still running', async () => {
    // runOnce refuses to overlap itself; the timer must surface that as a
    // skipped pass, not an unhandled rejection.
    const passes = vi
      .spyOn(scheduler, 'runOnce')
      .mockRejectedValue(new Error('A scheduled pass is already running'));
    scheduler.configure(true, 60, 'test');

    vi.advanceTimersByTime(180_000);
    // Let the caught rejections settle: an uncaught one fails the run.
    await Promise.resolve();

    expect(passes).toHaveBeenCalledTimes(3);
  });
});
