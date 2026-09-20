import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { Writable } from 'node:stream';
import { loadConfig, readTelegramSecrets } from '../src/config/env.js';
import type { AppError } from '../src/util/errors.js';
import { setRootLogger } from '../src/logging/logger.js';
import { redact } from '../src/logging/redact.js';
import { shutdownServices } from '../src/core/services.js';
import { TelegramService } from '../src/telegram/service.js';
import type { CycleReport } from '../src/trading/pipeline.js';
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
 * The facade: how it is configured, how it behaves with nothing configured,
 * and the hooks the composition root calls. The last block is the secrecy
 * check: with both tokens set and a real logger capturing every line, no
 * reply, audit row, log object or notification may contain either token.
 */

const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const GATEWAY_TOKEN = 'atra_inst_9f8e7d6c5b4a3210';

describe('configuration', () => {
  it('selects the gateway, then the direct bot, then nothing', () => {
    const base = { NODE_ENV: 'test', ATRA_MODE: 'normal', ATRA_DATA_DIR: './.test-data' };
    expect(loadConfig(base).telegram).toEqual({
      transport: 'none',
      gatewayUrl: undefined,
      gatewayTokenConfigured: false,
      botTokenConfigured: false,
      botUsername: undefined,
    });
    expect(
      loadConfig({
        ...base,
        ATRA_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        ATRA_TELEGRAM_BOT_USERNAME: '@my_bot',
      }).telegram,
    ).toMatchObject({ transport: 'direct', botTokenConfigured: true, botUsername: 'my_bot' });
    expect(
      loadConfig({
        ...base,
        ATRA_GATEWAY_URL: 'https://gateway.example',
        ATRA_GATEWAY_TOKEN: GATEWAY_TOKEN,
        ATRA_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      }).telegram,
    ).toMatchObject({ transport: 'gateway', gatewayUrl: 'https://gateway.example' });
    // CI never opens a transport.
    expect(
      loadConfig({ ...base, ATRA_MODE: 'ci', ATRA_TELEGRAM_BOT_TOKEN: BOT_TOKEN }).telegram
        .transport,
    ).toBe('none');
  });

  it('refuses a gateway URL without its token, and a non-http(s)/ws(s) URL', () => {
    const base = { NODE_ENV: 'test', ATRA_DATA_DIR: './.test-data' };
    expect(() => loadConfig({ ...base, ATRA_GATEWAY_URL: 'https://gateway.example' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() =>
      loadConfig({ ...base, ATRA_GATEWAY_URL: 'ftp://gateway.example', ATRA_GATEWAY_TOKEN: 'x' }),
    ).toThrow(/Invalid environment configuration/);
  });

  it('refuses cleartext to a remote gateway and allows it for loopback', () => {
    const base = {
      NODE_ENV: 'test',
      ATRA_DATA_DIR: './.test-data',
      ATRA_GATEWAY_TOKEN: GATEWAY_TOKEN,
    };
    // The installation token rides in the upgrade request's Authorization header.
    for (const url of ['http://gateway.example', 'ws://gateway.example:8787', 'http://10.0.0.5']) {
      expect(() => loadConfig({ ...base, ATRA_GATEWAY_URL: url })).toThrow(
        /Invalid environment configuration/,
      );
    }
    let thrown: unknown;
    try {
      loadConfig({ ...base, ATRA_GATEWAY_URL: 'http://gateway.example' });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AppError).errors?.[0]).toEqual({
      path: 'ATRA_GATEWAY_URL',
      message: 'must use https or wss; plain http is allowed only for localhost',
    });

    for (const url of [
      'http://localhost:8787',
      'ws://127.0.0.1:8787',
      'http://[::1]:8787',
      'https://gateway.example',
      'wss://gateway.example',
    ]) {
      expect(loadConfig({ ...base, ATRA_GATEWAY_URL: url }).telegram.transport).toBe('gateway');
    }
  });

  it('keeps the tokens off the config object and reads them separately', () => {
    const env = {
      NODE_ENV: 'test',
      ATRA_DATA_DIR: './.test-data',
      ATRA_GATEWAY_URL: 'https://gateway.example',
      ATRA_GATEWAY_TOKEN: GATEWAY_TOKEN,
      ATRA_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    };
    expect(JSON.stringify(loadConfig(env))).not.toContain(GATEWAY_TOKEN);
    expect(JSON.stringify(loadConfig(env))).not.toContain(BOT_TOKEN);
    expect(readTelegramSecrets(env)).toEqual({ gatewayToken: GATEWAY_TOKEN, botToken: BOT_TOKEN });
    expect(readTelegramSecrets({})).toEqual({ gatewayToken: undefined, botToken: undefined });
  });
});

describe('TelegramService', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('constructs with nothing configured and every method behaves', async () => {
    h = await harness({ transport: null });
    expect(h.telegram.configured).toBe(false);
    expect(h.telegram.transportKind).toBeNull();
    expect(h.telegram.view().configured).toBe(false);
    expect(() => h.telegram.issuePairCode()).toThrow(/not configured/);
    expect(h.telegram.pairStatus('AAAA-2222')).toBe('expired');
    expect(h.telegram.unpair().paired).toBe(false);
    expect(h.telegram.setNotifications({ runtimeAlerts: false }).notifications.runtimeAlerts).toBe(
      false,
    );
    expect(await h.telegram.notify({ kind: 'paused', summary: 'x' })).toBe('unpaired');
    await h.telegram.start();
    await h.telegram.stop();
    expect(await h.telegram.checkGas()).toEqual([]);
    expect(await h.telegram.checkDailyLoss()).toBe(false);
    // A command arriving anyway (impossible without a transport) is refused generically.
    expect(await h.telegram.handleCommand(h.command('/pause'))).toMatch(/not paired/);
  });

  it('builds a real transport from config + secrets, and none when the secret is missing', async () => {
    h = await harness({ transport: null });
    const base = { NODE_ENV: 'test', ATRA_LOG_LEVEL: 'silent', ATRA_DATA_DIR: './.test-data' };
    const make = (
      env: Record<string, string>,
      secrets: { gatewayToken?: string; botToken?: string },
    ) =>
      new TelegramService({
        db: h.services.db,
        audit: h.services.audit,
        state: h.services.state,
        ledger: h.services.ledger,
        trades: h.services.trades,
        riskPolicy: h.services.riskPolicy,
        wallets: h.services.wallets,
        market: h.services.market,
        scheduler: h.services.scheduler,
        config: loadConfig({ ...base, ...env }),
        secrets: { gatewayToken: undefined, botToken: undefined, ...secrets },
      });

    const gateway = make(
      { ATRA_GATEWAY_URL: 'https://gateway.example', ATRA_GATEWAY_TOKEN: GATEWAY_TOKEN },
      { gatewayToken: GATEWAY_TOKEN },
    );
    expect(gateway.transportKind).toBe('gateway');
    expect(gateway.view().configured).toBe(true);

    const direct = make(
      { ATRA_TELEGRAM_BOT_TOKEN: BOT_TOKEN, ATRA_TELEGRAM_BOT_USERNAME: 'my_bot' },
      { botToken: BOT_TOKEN },
    );
    expect(direct.transportKind).toBe('direct');
    expect(direct.view().botUrl).toBe('https://t.me/my_bot');
    expect(direct.issuePairCode().botUrl).toBe('https://t.me/my_bot');

    const missing = make({ ATRA_TELEGRAM_BOT_TOKEN: BOT_TOKEN }, {});
    expect(missing.transportKind).toBeNull();
  });

  it('reconciles the gateway welcome against its own pairing, failing closed', async () => {
    h = await harness();
    await pairOperator(h);
    const events = h.transport.events!;

    // Same user: nothing changes.
    events.onWelcome({ paired: true, telegram: OPERATOR, botUsername: 'b' });
    expect(h.telegram.view().paired).toBe(true);
    expect(h.transport.revokes).toBe(0);

    // Different user: local link dropped, gateway told to drop its own.
    events.onWelcome({ paired: true, telegram: STRANGER, botUsername: 'b' });
    expect(h.telegram.view().paired).toBe(false);
    expect(h.transport.revokes).toBe(1);

    // Gateway paired, runtime has no record: revoke.
    events.onWelcome({ paired: true, telegram: OPERATOR, botUsername: 'b' });
    expect(h.transport.revokes).toBe(2);
    expect(h.telegram.view().paired).toBe(false);

    // Locally paired, gateway says unpaired: local link dropped.
    events.onPaired(OPERATOR, h.clock.now);
    events.onWelcome({ paired: false, telegram: null, botUsername: 'b' });
    expect(h.telegram.view().paired).toBe(false);

    // A pending code is re-offered on reconnect.
    const issued = h.telegram.issuePairCode();
    const before = h.transport.offers.length;
    events.onWelcome({ paired: false, telegram: null, botUsername: 'b' });
    expect(h.transport.offers.length).toBe(before + 1);
    expect(h.telegram.pairStatus(issued.code)).toBe('pending');

    // An unpaired frame from the gateway clears the link and audits it.
    events.onPaired(OPERATOR, h.clock.now);
    events.onUnpaired('operator sent /unpair');
    expect(h.telegram.view().paired).toBe(false);
    expect(h.services.audit.list({ category: 'telegram' })[0]?.action).toBe('telegram.unpaired');
  });

  it('refuses a gateway pairing that names another account, and keeps the link', async () => {
    h = await harness();
    await pairOperator(h);
    h.transport.events!.onPaired(STRANGER, h.clock.now);

    expect(h.telegram.view().account?.userIdMasked).toBe('******789');
    const refused = h.services.audit
      .list({ category: 'telegram' })
      .find((row) => row.action === 'telegram.pair.refused');
    expect(refused?.status).toBe('failed');
    expect(refused?.detail['userIdMasked']).toBe('******321');
    // Moving to another account starts with an unpair, so no code is issued.
    expect(() => h.telegram.issuePairCode()).toThrow(/already paired/i);
    h.telegram.unpair();
    expect(() => h.telegram.issuePairCode()).not.toThrow();
  });

  it('audits a superseded gateway session and a revoked installation token', async () => {
    h = await harness();
    await pairOperator(h);
    h.transport.events!.onSuperseded();
    h.transport.events!.onRevoked();

    const rows = h.services.audit.list({ category: 'telegram' });
    const superseded = rows.find((row) => row.action === 'telegram.transport.superseded');
    expect(superseded?.status).toBe('failed');
    expect(superseded?.summary).toMatch(/revoke and reissue the token/);
    const revoked = rows.find((row) => row.action === 'telegram.transport.revoked');
    expect(revoked?.status).toBe('failed');
    expect(revoked?.summary).toMatch(/until a new token is issued/);
  });

  it('announces online on connect and offline on stop, once', async () => {
    h = await harness();
    await pairOperator(h);
    h.transport.events!.onConnected();
    h.transport.events!.onDisconnected('blip');
    h.transport.events!.onConnected();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transport.notifications.filter((n) => n.kind === 'runtime.online')).toHaveLength(1);
    expect(h.transport.notifications[0]!.text).toMatch(/Runtime online/);
    await h.telegram.stop();
    expect(h.transport.notifications.at(-1)!.kind).toBe('runtime.offline');
    expect(h.transport.stopped).toBe(true);
    await h.telegram.stop();
    expect(h.transport.notifications.filter((n) => n.kind === 'runtime.offline')).toHaveLength(1);
  });

  it('turns cycle reports into trade notifications and runs the daily-loss check', async () => {
    h = await harness();
    await pairOperator(h);
    const trade = h.services.trades.propose(
      {
        schemaVersion: 1,
        actionId: randomUUID(),
        decisionCycleId: randomUUID(),
        idempotencyKey: 'c'.repeat(64),
        proposedAt: h.clock.now,
        mode: 'PAPER',
        source: 'scheduler',
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
    h.services.trades.decide(trade.id, {
      allowed: true,
      code: 'OK',
      derived: { amountInUsd: '20.000000', feeUsd: '0.01' },
    } as never);

    const report = (
      outcome: CycleReport['outcome'],
      extra: Partial<CycleReport> = {},
    ): CycleReport => ({
      cycleId: randomUUID(),
      chain: 'base',
      mode: 'PAPER',
      startedAt: new Date(h.clock.now).toISOString(),
      finishedAt: new Date(h.clock.now).toISOString(),
      outcome,
      reason: 'test',
      research: null,
      decision: null,
      modelStatus: null,
      trade: { tradeId: trade.id, actionId: trade.actionId },
      risk: null,
      execution: null,
      notes: [],
      ...extra,
    });

    await h.telegram.onCycleReport(report('filled'));
    await h.telegram.onCycleReport(
      report('rejected', {
        risk: {
          allowed: false,
          code: 'COOLDOWN_ACTIVE',
          reason: 'cooldown.market: observed 10 vs limit 900',
        },
      }),
    );
    await h.telegram.onCycleReport(report('failed', { reason: 'simulation failed: revert' }));
    await h.telegram.onCycleReport(report('no_action'));
    await h.telegram.onCycleReport(report('blocked'));

    const kinds = h.transport.notifications.map((n) => n.kind);
    expect(kinds).toEqual(['trade.filled', 'trade.rejected', 'trade.failed']);
    expect(h.transport.notifications[0]!.text).toMatch(
      /swap USDC→WETH for \$20\.00 filled in PAPER mode/,
    );
    expect(h.transport.notifications[0]!.text).toMatch(/Simulated fill/);
    expect(h.transport.notifications[1]!.text).toMatch(/rejected: COOLDOWN_ACTIVE/);
    expect(h.transport.notifications[2]!.text).toMatch(/simulation failed/);
    expect(JSON.stringify(h.transport.notifications)).not.toContain(WETH_BASE);
  });

  it('forwards the state hooks as notifications', async () => {
    h = await harness();
    await pairOperator(h);
    h.telegram.onEmergencyStop(true, 'operator pressed stop');
    h.telegram.onPauseChanged(true, 'maintenance', 'operator');
    h.telegram.onPauseChanged(false, null, 'telegram');
    h.telegram.onEmergencyStop(false, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transport.notifications.map((n) => n.kind)).toEqual([
      'emergency.engaged',
      'paused',
      'resumed',
      'emergency.cleared',
    ]);
    expect(h.transport.notifications[0]!.text).toMatch(/EMERGENCY STOP ENGAGED/);
  });
});

describe('secrecy', () => {
  let h: Harness;
  afterEach(() => {
    setRootLogger(pino({ level: 'silent' }));
    if (h) shutdownServices(h.services);
  });

  it('never lets a token reach a reply, an audit row, a notification or a log line', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    // The same deep redactor the production logger installs, writing to a
    // sink this test can read back.
    const captured = pino(
      {
        level: 'trace',
        formatters: { log: (object) => redact(object) as Record<string, unknown> },
      },
      sink,
    );
    setRootLogger(captured);

    h = await harness({
      transport: null,
      env: {
        ATRA_MODE: 'normal',
        ATRA_GATEWAY_URL: 'https://gateway.example',
        ATRA_GATEWAY_TOKEN: GATEWAY_TOKEN,
        ATRA_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      },
    });
    const service = new TelegramService({
      db: h.services.db,
      audit: h.services.audit,
      state: h.services.state,
      ledger: h.services.ledger,
      trades: h.services.trades,
      riskPolicy: h.services.riskPolicy,
      wallets: h.services.wallets,
      market: h.services.market,
      scheduler: h.services.scheduler,
      config: h.services.config,
      secrets: { gatewayToken: GATEWAY_TOKEN, botToken: BOT_TOKEN },
      transport: h.transport,
      now: () => h.clock.now,
    });
    await service.start();
    service.issuePairCode();
    h.transport.events!.onPaired(OPERATOR, h.clock.now);
    h.transport.events!.onConnected();
    const replies: Array<string | null> = [];
    for (const text of [
      '/status',
      '/help',
      '/risk',
      '/portfolio',
      '/trades',
      '/alerts',
      `/pair ${BOT_TOKEN}`,
      `/withdraw ${GATEWAY_TOKEN}`,
    ]) {
      replies.push(await service.handleCommand(h.command(text)));
    }
    await service.notify({ kind: 'paused', summary: 'paused' });
    await service.stop();

    const everything = JSON.stringify({
      replies,
      audit: h.services.audit.list({ limit: 500 }),
      notifications: h.transport.notifications,
      view: service.view(),
      status: service.status(),
      commands: h.services.db.prepare('SELECT * FROM telegram_commands').all(),
      logs: lines,
    });
    expect(everything).not.toContain(BOT_TOKEN);
    expect(everything).not.toContain(GATEWAY_TOKEN);
    expect(replies.every((reply) => reply !== null && reply.length > 0)).toBe(true);
  });
});
