import { afterEach, describe, expect, it } from 'vitest';
import { shutdownServices } from '../src/core/services.js';
import type { ChainAdapter } from '../src/chains/types.js';
import type { ChainId } from '../src/chains/registry.js';
import { NOTIFIER_LIMITS, categoryFor, renderNotification } from '../src/telegram/notifications.js';
import { NOTIFICATION_KINDS } from '../src/telegram/types.js';
import { harness, pairOperator, stubChain } from './telegram-harness.js';
import type { Harness } from './telegram-harness.js';

/**
 * The notifier's job is to be quiet. Every rule that keeps it quiet is
 * asserted here, and then the one thing that must not be quiet: an
 * emergency stop while paired with alerts on.
 */

describe('Notifier', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('maps every kind to a dashboard category', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(['riskRejections', 'tradeDecisions', 'liquidityUpdates', 'runtimeAlerts']).toContain(
        categoryFor(kind),
      );
    }
  });

  it('renders plain text with the mode, the title and the suppressed count', () => {
    const text = renderNotification(
      {
        kind: 'trade.rejected',
        chain: 'base',
        summary: 'swap USDC→WETH rejected: COOLDOWN_ACTIVE.',
      },
      'PAPER',
      3,
    );
    expect(text.split('\n')[0]).toBe('[ATRA PAPER] Trade rejected by the risk engine — Base');
    expect(text).toContain('3 similar events were not sent');
    // Plain text: no markdown or HTML markup (underscores in codes are fine
    // because no parse_mode is ever set).
    expect(text).not.toMatch(/[*`<>]/);
  });

  it('sends nothing while unpaired', async () => {
    h = await harness();
    await h.telegram.start();
    expect(await h.telegram.notify({ kind: 'trade.filled', summary: 'x' })).toBe('unpaired');
    expect(h.transport.notifications).toHaveLength(0);
  });

  it('honours the master switch and the per-category toggles', async () => {
    h = await harness();
    await pairOperator(h);
    expect(await h.telegram.notify({ kind: 'trade.filled', summary: 'filled 1' })).toBe('sent');

    h.telegram.setNotifications({ tradeDecisions: false });
    expect(await h.telegram.notify({ kind: 'trade.filled', summary: 'filled 2' })).toBe(
      'category-off',
    );
    expect(await h.telegram.notify({ kind: 'paused', summary: 'paused' })).toBe('sent');

    await h.telegram.handleCommand(h.command('/alerts off'));
    expect(await h.telegram.notify({ kind: 'emergency.engaged', summary: 'stop' })).toBe(
      'alerts-off',
    );
    await h.telegram.handleCommand(h.command('/alerts on'));
    expect(await h.telegram.notify({ kind: 'emergency.engaged', summary: 'stop' })).toBe('sent');
    expect(h.transport.notifications.map((n) => n.kind)).toEqual([
      'trade.filled',
      'paused',
      'emergency.engaged',
    ]);
  });

  it('suppresses a duplicate for an hour', async () => {
    h = await harness();
    await pairOperator(h);
    expect(
      await h.telegram.notify({
        kind: 'gas.low',
        chain: 'base',
        summary: 'low',
        dedupeKey: 'gas.low:base',
      }),
    ).toBe('sent');
    expect(
      await h.telegram.notify({
        kind: 'gas.low',
        chain: 'base',
        summary: 'low',
        dedupeKey: 'gas.low:base',
      }),
    ).toBe('duplicate');
    h.clock.now += NOTIFIER_LIMITS.dedupeMs + 1;
    expect(
      await h.telegram.notify({
        kind: 'gas.low',
        chain: 'base',
        summary: 'low',
        dedupeKey: 'gas.low:base',
      }),
    ).toBe('sent');
  });

  it('cools down risk rejections per code for ten minutes and reports what it swallowed', async () => {
    h = await harness();
    await pairOperator(h);
    const reject = (code: string, n: number) =>
      h.telegram.notify({
        kind: 'trade.rejected',
        chain: 'base',
        summary: `rejected ${code}`,
        rejectionCode: code,
        dedupeKey: `r:${code}:${String(n)}`,
      });
    expect(await reject('COOLDOWN_ACTIVE', 1)).toBe('sent');
    expect(await reject('COOLDOWN_ACTIVE', 2)).toBe('cooldown');
    expect(await reject('COOLDOWN_ACTIVE', 3)).toBe('cooldown');
    // A different code has its own cooldown.
    expect(await reject('DATA_STALE', 1)).toBe('sent');
    h.clock.now += NOTIFIER_LIMITS.rejectionCooldownMs + 1;
    expect(await reject('COOLDOWN_ACTIVE', 4)).toBe('sent');
    const last = h.transport.notifications.at(-1)!;
    expect(last.text).toContain('2 similar events were not sent');
  });

  it('caps at thirty messages an hour', async () => {
    h = await harness();
    await pairOperator(h);
    const outcomes: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      outcomes.push(
        await h.telegram.notify({ kind: 'trade.filled', summary: `fill ${String(index)}` }),
      );
    }
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(NOTIFIER_LIMITS.hourlyCap);
    expect(outcomes.slice(30)).toEqual(['hourly-cap', 'hourly-cap']);
    h.clock.now += 60 * 60_000 + 1;
    expect(await h.telegram.notify({ kind: 'trade.filled', summary: 'fill later' })).toBe('sent');
  });

  it('records a delivery failure and never throws', async () => {
    h = await harness();
    await pairOperator(h);
    h.transport.failNotify = new Error('boom');
    expect(await h.telegram.notify({ kind: 'trade.filled', summary: 'x' })).toBe('failed');
    expect(h.telegram.status().recent[0]).toMatchObject({
      kind: 'trade.filled',
      outcome: 'failed',
    });
    h.transport.failNotify = null;
    // A failed send did not consume the dedupe slot.
    expect(await h.telegram.notify({ kind: 'trade.filled', summary: 'x' })).toBe('sent');
  });

  it('keeps only the last hundred outcomes', async () => {
    h = await harness();
    await h.telegram.start();
    for (let index = 0; index < 130; index += 1) {
      await h.telegram.notify({ kind: 'trade.filled', summary: String(index) });
    }
    const recent = h.telegram.status().recent;
    expect(recent).toHaveLength(NOTIFIER_LIMITS.queueSize);
    expect(recent[0]!.summary).toBe('129');
  });
});

describe('DailyLossWatcher', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('fires once per UTC day at 80% of the limit, from supplied usage', async () => {
    h = await harness();
    await pairOperator(h);
    expect(await h.telegram.checkDailyLoss({ dailyLossUsd: '39.99', maxDailyLossUsd: '50' })).toBe(
      false,
    );
    expect(await h.telegram.checkDailyLoss({ dailyLossUsd: '40', maxDailyLossUsd: '50' })).toBe(
      true,
    );
    expect(h.transport.notifications.at(-1)?.text).toMatch(
      /\$40\.00 of the \$50\.00 daily limit \(80%\)/,
    );
    // Same day: silent even when the loss grows.
    expect(await h.telegram.checkDailyLoss({ dailyLossUsd: '49', maxDailyLossUsd: '50' })).toBe(
      false,
    );
    // Next UTC day: armed again.
    h.clock.now += 24 * 60 * 60_000;
    expect(await h.telegram.checkDailyLoss({ dailyLossUsd: '45', maxDailyLossUsd: '50' })).toBe(
      true,
    );
    expect(h.transport.notifications.filter((n) => n.kind === 'risk.dailyLossNear')).toHaveLength(
      2,
    );
  });

  it('computes the loss from the ledger when no usage is supplied', async () => {
    h = await harness();
    await pairOperator(h);
    // No fills: loss 0, nothing fires.
    expect(await h.telegram.checkDailyLoss()).toBe(false);
    expect(h.transport.notifications).toHaveLength(0);
  });
});

describe('GasWatcher', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('raises gas.low once an hour per chain from the wallet reading', async () => {
    const adapters = new Map<ChainId, ChainAdapter>([
      ['base', stubChain('base', { native: 1_000n, feeNative: 21_000_000_000_000n })],
      ['solana', stubChain('solana', { native: 10n ** 9n, feeNative: 5_000n })],
    ]);
    h = await harness({ adapters });
    await pairOperator(h);
    const observed = await h.telegram.checkGas();
    expect(observed).toEqual([
      { chain: 'base', gasLow: true },
      { chain: 'solana', gasLow: false },
    ]);
    expect(h.transport.notifications).toHaveLength(1);
    expect(h.transport.notifications[0]!.kind).toBe('gas.low');
    expect(h.transport.notifications[0]!.text).toMatch(/Low gas balance — Base/);
    await h.telegram.checkGas();
    expect(h.transport.notifications).toHaveLength(1);
  });

  it('runs on the ten-minute timer while started, and not before pairing', async () => {
    const adapters = new Map<ChainId, ChainAdapter>([
      ['base', stubChain('base', { native: 0n, feeNative: 1n })],
    ]);
    h = await harness({ adapters });
    await h.telegram.start();
    expect(await h.telegram.checkGas()).toEqual([]);
    h.transport.events!.onPaired({ userId: 1, chatId: 1, displayName: 'op' }, h.clock.now);
    h.timers.advance(10 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.transport.notifications.some((n) => n.kind === 'gas.low')).toBe(true);
  });
});
