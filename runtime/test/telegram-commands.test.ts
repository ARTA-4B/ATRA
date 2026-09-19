import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { shutdownServices } from '../src/core/services.js';
import { COMMAND_LIMITS, UNPAIRED_REPLY, parseCommand } from '../src/telegram/commands.js';
import { MAX_REPLY_CHARS } from '../src/telegram/format.js';
import {
  OPERATOR,
  STRANGER,
  USDC_BASE,
  WETH_BASE,
  harness,
  pairOperator,
} from './telegram-harness.js';
import type { Harness } from './telegram-harness.js';

/**
 * The command router is the security boundary between a chat message and
 * the runtime's switches. These tests are written from the attacker's side
 * first: what a stranger, a replay, a stale message and a flood get; and
 * then from the operator's side: what each command does and does not do.
 */

const send = (h: Harness, text: string, identity = OPERATOR) =>
  h.telegram.handleCommand(h.command(text, identity));

const commandRows = (h: Harness) =>
  h.services.db
    .prepare<[], { command: string; outcome: string; user_id: number }>(
      'SELECT command, outcome, user_id FROM telegram_commands ORDER BY id',
    )
    .all();

describe('parseCommand', () => {
  it('lower-cases, strips the bot mention and keeps arguments', () => {
    expect(parseCommand('/Status@atra_bot now')).toEqual({ word: 'status', args: ['now'] });
    expect(parseCommand('  /pair K7ZQ-4MWD ')).toEqual({ word: 'pair', args: ['K7ZQ-4MWD'] });
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/../etc')).toBeNull();
  });
});

describe('CommandRouter: gates', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('refuses an unpaired user generically, audits it, and changes nothing', async () => {
    h = await harness();
    await h.telegram.start();
    const reply = await send(h, '/pause', STRANGER);
    expect(reply).toBe(UNPAIRED_REPLY);
    expect(h.services.state.getSwitches().globalPause).toBe(false);

    const audit = h.services.audit.list({ category: 'telegram' });
    const row = audit.find((event) => event.action === 'telegram.unauthorized');
    expect(row).toBeDefined();
    expect(row!.actor).toBe('telegram:******321');
    expect(JSON.stringify(row!.detail)).not.toContain(String(STRANGER.userId));
    expect(commandRows(h).at(-1)).toMatchObject({ command: 'pause', outcome: 'unauthorized' });
  });

  it('refuses a paired-but-different user the same way', async () => {
    h = await harness();
    await pairOperator(h);
    const reply = await send(h, '/emergency', STRANGER);
    expect(reply).toBe(UNPAIRED_REPLY);
    // The stranger's /emergency did not open a challenge for anyone.
    const confirm = await send(h, '/emergency CONFIRM');
    expect(confirm).toMatch(/No pending emergency challenge/);
    expect(h.services.state.getSwitches().emergencyStop).toBe(false);
  });

  it('rate-limits replies to a stranger to three per ten minutes', async () => {
    h = await harness();
    await h.telegram.start();
    const replies: Array<string | null> = [];
    for (let index = 0; index < 5; index += 1) replies.push(await send(h, '/status', STRANGER));
    expect(replies.filter((reply) => reply !== null)).toHaveLength(3);
    expect(replies.slice(3)).toEqual([null, null]);
    h.clock.now += 10 * 60_000 + 1;
    expect(await send(h, '/status', STRANGER)).toBe(UNPAIRED_REPLY);
  });

  it('drops a replayed update id and a message older than 120 s', async () => {
    h = await harness();
    await pairOperator(h);
    const first = h.command('/pause');
    expect(await h.telegram.handleCommand(first)).toMatch(/paused/i);
    expect(h.services.state.getSwitches().globalPause).toBe(true);
    h.services.state.setGlobalPause(false, null, 'test');

    // Same update id again: dropped, nothing changes.
    expect(await h.telegram.handleCommand({ ...first, requestId: 'again' })).toBeNull();
    expect(h.services.state.getSwitches().globalPause).toBe(false);
    // A lower id is a replay too.
    expect(await h.telegram.handleCommand({ ...first, updateId: first.updateId - 5 })).toBeNull();
    expect(commandRows(h).filter((row) => row.outcome === 'replayed')).toHaveLength(2);

    // Old message.
    const stale = h.command('/pause', OPERATOR, {
      receivedAt: h.clock.now - COMMAND_LIMITS.maxMessageAgeMs - 1,
    });
    expect(await h.telegram.handleCommand(stale)).toBeNull();
    expect(h.services.state.getSwitches().globalPause).toBe(false);
    expect(commandRows(h).at(-1)?.outcome).toBe('stale');
    const audit = h.services.audit.list({ category: 'telegram' }).map((row) => row.action);
    expect(audit).toContain('telegram.replay');
    expect(audit).toContain('telegram.stale');
  });

  it('rate-limits the operator: 20 commands a minute, 5 control commands a minute', async () => {
    h = await harness();
    await pairOperator(h);
    const replies: Array<string | null> = [];
    for (let index = 0; index < 22; index += 1) replies.push(await send(h, '/help'));
    expect(replies.slice(0, 20).every((reply) => reply?.startsWith('ATRA commands'))).toBe(true);
    expect(replies[20]).toMatch(/Too many commands/);
    expect(replies[21]).toBeNull();

    h.clock.now += 61_000;
    const control: Array<string | null> = [];
    for (let index = 0; index < 7; index += 1) {
      control.push(await send(h, index % 2 === 0 ? '/pause' : '/resume'));
    }
    expect(control.slice(0, 5).every((reply) => reply !== null && !/Too many/.test(reply))).toBe(
      true,
    );
    expect(control[5]).toMatch(/Too many control commands/);
    expect(control[6]).toBeNull();
    expect(commandRows(h).filter((row) => row.outcome === 'rate_limited').length).toBeGreaterThan(
      0,
    );
  });
});

describe('CommandRouter: commands', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('/pause and /resume flip the global pause with actor "telegram"', async () => {
    h = await harness();
    await pairOperator(h);
    expect(await send(h, '/pause')).toMatch(/paused/i);
    expect(h.services.state.getSwitches().globalPause).toBe(true);
    expect(await send(h, '/pause')).toMatch(/already paused/i);
    expect(await send(h, '/resume')).toMatch(/resumed/i);
    expect(h.services.state.getSwitches().globalPause).toBe(false);
    expect(await send(h, '/resume')).toMatch(/not paused/i);

    const control = h.services.audit.list({ category: 'control' });
    expect(control.find((row) => row.action === 'pause.enabled')?.actor).toBe('telegram');
    expect(control.find((row) => row.action === 'pause.cleared')?.actor).toBe('telegram');
    const telegram = h.services.audit.list({ category: 'telegram' }).map((row) => row.action);
    expect(telegram).toContain('telegram.command.pause');
    expect(telegram).toContain('telegram.command.resume');
  });

  it('/resume refuses while the emergency stop is engaged', async () => {
    h = await harness();
    await pairOperator(h);
    h.services.state.setGlobalPause(true, 'test', 'operator');
    h.services.state.setEmergencyStop(true, 'test', 'operator');
    expect(await send(h, '/resume')).toMatch(/emergency stop is engaged/i);
    expect(h.services.state.getSwitches().globalPause).toBe(true);
    expect(h.services.state.getSwitches().emergencyStop).toBe(true);
  });

  it('/emergency needs the second step, engages without the model, and cannot clear', async () => {
    h = await harness();
    await pairOperator(h);
    h.services.scheduler.configure(true, 300, 'operator');

    // Confirm without a challenge: nothing.
    expect(await send(h, '/emergency CONFIRM')).toMatch(/No pending/);
    expect(h.services.state.getSwitches().emergencyStop).toBe(false);

    const challenge = await send(h, '/emergency');
    expect(challenge).toMatch(/\/emergency CONFIRM within 60 seconds/);
    expect(h.services.state.getSwitches().emergencyStop).toBe(false);

    // Expired challenge.
    h.clock.now += COMMAND_LIMITS.emergencyChallengeMs + 1;
    expect(await send(h, '/emergency CONFIRM')).toMatch(/No pending/);
    expect(h.services.state.getSwitches().emergencyStop).toBe(false);

    // Fresh challenge, confirmed in time.
    await send(h, '/emergency');
    h.clock.now += 5_000;
    const engaged = await send(h, '/emergency confirm');
    expect(engaged).toMatch(/EMERGENCY STOP ENGAGED/);
    const switches = h.services.state.getSwitches();
    expect(switches.emergencyStop).toBe(true);
    expect(switches.emergencyReason).toMatch(/Telegram/);
    expect(h.services.state.getMode()).toBe('PAPER');
    expect(h.services.scheduler.status().enabled).toBe(false);
    expect(h.services.audit.list({ category: 'control' })[0]).toMatchObject({
      action: 'emergency.engaged',
      actor: 'telegram',
    });

    // No clearing from Telegram, under any spelling. (New minute: the control
    // limiter has been exercised above.)
    h.clock.now += 61_000;
    for (const text of ['/emergency clear', '/emergency off', '/emergency reset', '/resume']) {
      const reply = await send(h, text);
      expect(reply).toMatch(/dashboard/);
      expect(h.services.state.getSwitches().emergencyStop).toBe(true);
    }
    expect(await send(h, '/emergency')).toMatch(/already engaged/);
  });

  it('read commands produce non-empty, bounded replies', async () => {
    h = await harness({
      liquidity: { summary: () => Promise.resolve('1 LP position: WETH/USDC on Base') },
    });
    await pairOperator(h);
    h.transport.events!.onConnected();

    const status = (await send(h, '/status'))!;
    expect(status).toMatch(/Mode: PAPER/);
    expect(status).toMatch(/Paused: no/);
    expect(status).toMatch(/Emergency stop: no/);
    expect(status).toMatch(/Uptime: 1h 30m/);
    expect(status).toMatch(/Auto-trade: off/);
    expect(status).toMatch(/Chains: Base, Solana/);
    expect(status).toMatch(/Model: UNAVAILABLE/);
    expect(status).toMatch(/Telegram: gateway, connected/);

    expect(await send(h, '/portfolio')).toMatch(/No open positions/);
    expect(await send(h, '/positions')).toMatch(/No open positions/);
    expect(await send(h, '/trades')).toMatch(/No trades yet/);
    expect(await send(h, '/lp')).toBe('1 LP position: WETH/USDC on Base');

    const risk = (await send(h, '/risk'))!;
    expect(risk).toMatch(/Per trade: \$25\.00/);
    expect(risk).toMatch(/Daily loss: \$50\.00/);
    expect(risk).toMatch(/Daily loss: \$0\.00 \(0% of limit\)/);
    expect(risk).toMatch(/Deployed: \$0\.00 \(0% of cap\)/);

    const help = (await send(h, '/help'))!;
    for (const word of [
      '/status',
      '/portfolio',
      '/positions',
      '/trades',
      '/lp',
      '/risk',
      '/pause',
      '/resume',
      '/emergency',
      '/alerts',
      '/help',
    ]) {
      expect(help).toContain(word);
    }
    expect(await send(h, '/start')).toMatch(/test-install/);
    expect(await send(h, '/whatever')).toMatch(/Unknown command/);
    expect(await send(h, 'hello there')).toMatch(/\/help/);

    for (const text of [status, risk, help])
      expect(text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  });

  it('/portfolio marks positions and reports an unpriced one as unknown, never a number', async () => {
    h = await harness();
    await pairOperator(h);
    h.services.ledger.setPaperBalance('base', USDC_BASE, 6, '1000000000');
    const trade = h.services.trades.propose(
      {
        schemaVersion: 1,
        actionId: randomUUID(),
        decisionCycleId: randomUUID(),
        idempotencyKey: 'b'.repeat(64),
        proposedAt: h.clock.now,
        mode: 'PAPER',
        source: 'test',
        chain: 'base',
        kind: 'swap',
        protocol: 'aerodrome-v2',
        contract: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
        reduceOnly: false,
        tokenIn: { address: USDC_BASE, decimals: 6 },
        tokenOut: { address: WETH_BASE, decimals: 18 },
        amountIn: '20000000',
        quote: null,
        feeEstimate: {
          estimatedAt: h.clock.now,
          detail: { family: 'evm', gasLimit: '1', maxFeePerGas: '1' },
        },
      },
      'open',
    );
    h.services.ledger.recordFill({
      tradeId: trade.id,
      mode: 'PAPER',
      chain: 'base',
      tokenIn: { address: USDC_BASE, decimals: 6 },
      tokenOut: { address: WETH_BASE, decimals: 18 },
      amountIn: '20000000',
      amountOut: '8000000000000000',
      priceInUsd: '1',
      priceOutUsd: '2500',
      feeUsd: '0.05',
      filledAt: h.clock.now,
      simulated: true,
    });

    let text = (await send(h, '/portfolio'))!;
    expect(text).toMatch(/Positions: 1\b/);
    expect(text).toMatch(/Value: \$20\.00/);
    expect(text).toMatch(/Deployed: \$20\.00/);
    expect(text).toMatch(/Base WETH 0\.008 · cost \$20\.00 · mark \$20\.00/);
    expect(text).not.toContain(WETH_BASE);

    h.market.prices.set(WETH_BASE, null);
    text = (await send(h, '/portfolio'))!;
    expect(text).toMatch(/1 unpriced/);
    expect(text).toMatch(/Value: unknown/);
    expect(text).toMatch(/Unrealized P&L: unknown/);
    expect(text).toMatch(/mark unknown/);
  });

  it('/trades lists the last five with outcome and code', async () => {
    h = await harness();
    await pairOperator(h);
    for (let index = 0; index < 7; index += 1) {
      const trade = h.services.trades.propose(
        {
          schemaVersion: 1,
          actionId: randomUUID(),
          decisionCycleId: randomUUID(),
          idempotencyKey: 'a'.repeat(64),
          proposedAt: h.clock.now + index,
          mode: 'PAPER',
          source: 'test',
          chain: 'base',
          kind: 'swap',
          protocol: 'aerodrome-v2',
          contract: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
          reduceOnly: false,
          tokenIn: { address: USDC_BASE, decimals: 6 },
          tokenOut: { address: WETH_BASE, decimals: 18 },
          amountIn: '10000000',
          quote: null,
          feeEstimate: {
            estimatedAt: h.clock.now,
            detail: { family: 'evm', gasLimit: '1', maxFeePerGas: '1' },
          },
        },
        'open',
      );
      h.services.trades.decide(trade.id, {
        allowed: false,
        code: 'COOLDOWN_ACTIVE',
      } as never);
    }
    const text = (await send(h, '/trades'))!;
    expect(text.split('\n')).toHaveLength(6);
    expect(text).toMatch(/USDC→WETH · rejected \(COOLDOWN_ACTIVE\)/);
  });

  it('/alerts toggles the master switch', async () => {
    h = await harness();
    await pairOperator(h);
    expect(await send(h, '/alerts')).toMatch(/^Alerts: on/);
    expect(await send(h, '/alerts off')).toMatch(/^Alerts: off/);
    expect(h.telegram.view().alertsEnabled).toBe(false);
    expect(await send(h, '/alerts on')).toMatch(/^Alerts: on/);
    expect(await send(h, '/alerts maybe')).toMatch(/Usage/);
  });

  it('refuses wallet export and withdrawals with a fixed reply', async () => {
    h = await harness();
    await pairOperator(h);
    for (const text of [
      '/export',
      '/withdraw 1 ETH to 0xabc',
      '/key',
      '/seed',
      '/send',
      '/backup',
    ]) {
      const reply = await send(h, text);
      expect(reply).toMatch(/Not available over Telegram/);
    }
    const refused = h.services.audit
      .list({ category: 'telegram' })
      .filter((row) => row.action === 'telegram.refused');
    expect(refused).toHaveLength(6);
    // The audit row carries the command word, not the message.
    expect(JSON.stringify(refused.map((row) => row.detail))).not.toContain('0xabc');
  });

  it('/pair on the gateway transport defers to the bot; on direct it verifies locally', async () => {
    h = await harness();
    await h.telegram.start();
    expect(await send(h, '/pair AAAA-2222')).toMatch(/handled by the bot/);

    const direct = await harness({
      transport: new (await import('./telegram-harness.js')).FakeTransport('direct'),
    });
    try {
      await direct.telegram.start();
      const issued = direct.telegram.issuePairCode();
      const attempt = (text: string, identity = OPERATOR) =>
        direct.telegram.handleCommand(direct.command(text, identity, { source: 'direct' }));
      expect(await attempt('/pair')).toMatch(/Send \/pair CODE/);
      expect(await attempt('/pair ZZZZ-9999')).toMatch(/not valid or has expired/);
      expect(await attempt(`/pair ${issued.code.toLowerCase()}`)).toMatch(
        /Paired with test-install/,
      );
      expect(direct.telegram.view().paired).toBe(true);
      expect(direct.telegram.view().account?.userIdMasked).toBe('******789');
      expect(direct.telegram.pairStatus(issued.code)).toBe('confirmed');
      // A second use of the same code by someone else fails and leaves the link alone.
      expect(await attempt(`/pair ${issued.code}`, STRANGER)).toMatch(/not valid/);
      expect(direct.telegram.view().account?.userIdMasked).toBe('******789');
      // Pairing attempts are rate limited per user.
      const replies: Array<string | null> = [];
      for (let index = 0; index < 6; index += 1)
        replies.push(await attempt('/pair AAAA-2222', STRANGER));
      expect(replies.filter((reply) => reply === null).length).toBeGreaterThan(0);
    } finally {
      shutdownServices(direct.services);
    }
  });

  it('every command leaves an audit row and a command row, without message text', async () => {
    h = await harness();
    await pairOperator(h);
    await send(h, '/status with some extra words 0xdeadbeef');
    const audit = h.services.audit.list({ category: 'telegram' })[0]!;
    expect(audit.action).toBe('telegram.command.status');
    expect(audit.actor).toBe('telegram:******789');
    expect(audit.detail['command']).toBe('status');
    expect(JSON.stringify(audit)).not.toContain('deadbeef');
    expect(commandRows(h).at(-1)).toMatchObject({ command: 'status', outcome: 'ok' });
  });
});
