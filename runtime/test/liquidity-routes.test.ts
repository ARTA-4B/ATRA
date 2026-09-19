import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { buildServices, shutdownServices } from '../src/core/services.js';
import { loadConfig } from '../src/config/env.js';
import type { Services } from '../src/core/services.js';
import type { AppEnv } from '../src/http/context.js';
import { requestContext } from '../src/http/middleware.js';
import { toProblem } from '../src/http/respond.js';
import { liquidityRoutes } from '../src/http/routes/liquidity.js';
import { LiquidityService } from '../src/liquidity/service.js';
import { LiquidityRegistry } from '../src/liquidity/registry.js';

/**
 * The liquidity routes over a real session, database and audit trail.
 *
 * The router is mounted on a fresh Hono app with the same context the
 * production server attaches, so nothing about the route code is different;
 * only the host and CSRF guards are absent. The registry is empty here (no
 * adapters), which is exactly what the dashboard sees in CI.
 */

const PASSWORD = 'correct horse battery staple';
const FAST_KDF = { memoryKib: 1024, iterations: 1, parallelism: 1 };

describe('Phase 4: liquidity routes', () => {
  let services: Services;
  let liquidity: LiquidityService;
  let app: Hono<AppEnv>;
  let cookie: string;

  const request = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: {
        host: '127.0.0.1:3000',
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text)) : null };
  };

  beforeEach(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ATRA_MODE: 'ci',
      ATRA_LOG_LEVEL: 'silent',
      ATRA_DATA_DIR: './.test-data',
    });
    services = buildServices(config, { databaseFile: ':memory:', kdfParams: FAST_KDF });
    liquidity = new LiquidityService({
      db: services.db,
      audit: services.audit,
      state: services.state,
      ledger: services.ledger,
      trades: services.trades,
      gate: services.gate,
      policy: services.riskPolicy,
      wallets: services.wallets,
      market: services.market,
      llm: services.llm,
      registry: new LiquidityRegistry([]),
    });
    services.state.onEmergencyStop((active, reason) => {
      liquidity.onEmergencyStop(active, reason);
    });

    await services.auth.setPassword(PASSWORD);
    await services.vault.initialize(PASSWORD);
    services.state.createInstallation(randomUUID(), 'test', ['base']);
    services.riskPolicy.initialize(['base']);
    services.wallets.createAgentWallets();
    services.state.completeSetup();
    const session = await services.auth.login(PASSWORD);
    cookie = `atra_session=${session.token}`;

    app = new Hono<AppEnv>();
    app.onError((error, c) => {
      const problem = toProblem(error, c.get('requestId') ?? 'unknown');
      return c.json(problem, problem.status as 400);
    });
    app.use('*', requestContext());
    app.use('*', async (c, next) => {
      c.set('services', services);
      c.set('mode', services.state.getMode());
      await next();
    });
    app.route('/api/v1/liquidity', liquidityRoutes(liquidity));
  });

  afterEach(() => {
    liquidity.stop();
    shutdownServices(services);
  });

  it('requires a session', async () => {
    cookie = '';
    const response = await request('GET', '/api/v1/liquidity');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('GET / returns the LiquidityView shape with honest zeros and no adapters', async () => {
    const response = await request('GET', '/api/v1/liquidity');
    expect(response.status).toBe(200);
    expect(response.body.meta.mode).toBe('PAPER');
    expect(response.body.meta.source).toBe('local');
    const view = response.body.data;
    expect(view.summary).toEqual({
      totalValueUsd: '0.000000',
      activePositions: 0,
      unclaimedFeesUsd: '0.000000',
      requiresAttention: 0,
    });
    expect(view.positions).toEqual([]);
    expect(view.actions).toEqual([]);
    expect(view.supportedProtocols).toEqual([]);
    expect(view.adapters).toHaveLength(4);
    expect(view.adapters.every((a: { available: boolean }) => a.available === false)).toBe(true);
    expect(view.automation).toMatchObject({
      enabled: false,
      intervalSeconds: 1800,
      running: false,
      paused: false,
      nextRunAt: null,
      lastCycleAt: null,
    });
    expect(view.modelStatus).toBe('UNTRAINED');
    expect(view.verifiedExamplePools).toHaveLength(2);
  });

  it('GET /positions, /actions and /adapters answer through the envelope', async () => {
    for (const path of ['/positions', '/actions?limit=5', '/adapters', '/automation']) {
      const response = await request('GET', `/api/v1/liquidity${path}`);
      expect(response.status).toBe(200);
      expect(response.body.meta.requestId).toBeTruthy();
    }
    const adapters = await request('GET', '/api/v1/liquidity/adapters');
    expect(
      adapters.body.data.adapters.find((a: { chain: string }) => a.chain === 'solana').reason,
    ).toMatch(/no LP adapter/);
  });

  it('PUT /automation validates the body and switches automation on and off', async () => {
    const invalid = await request('PUT', '/api/v1/liquidity/automation', {
      enabled: true,
      intervalSeconds: 10,
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe('SCHEMA_INVALID');
    expect(invalid.body.errors[0].path).toBe('intervalSeconds');

    const on = await request('PUT', '/api/v1/liquidity/automation', {
      enabled: true,
      intervalSeconds: 600,
    });
    expect(on.status).toBe(200);
    expect(on.body.data.enabled).toBe(true);
    expect(on.body.data.intervalSeconds).toBe(600);
    expect(on.body.data.nextRunAt).not.toBeNull();

    const off = await request('PUT', '/api/v1/liquidity/automation', {
      enabled: false,
      intervalSeconds: 600,
    });
    expect(off.body.data.enabled).toBe(false);
    expect(off.body.data.nextRunAt).toBeNull();

    const audit = services.audit.list({ category: 'system' }).map((row) => row.action);
    expect(audit).toEqual(
      expect.arrayContaining(['lp-scheduler.enabled', 'lp-scheduler.disabled']),
    );
  });

  it('refuses to enable automation under an emergency stop with 409, and the stop disarms it', async () => {
    await request('PUT', '/api/v1/liquidity/automation', { enabled: true, intervalSeconds: 600 });
    services.state.setEmergencyStop(true, 'test', 'operator');
    expect((await request('GET', '/api/v1/liquidity/automation')).body.data.enabled).toBe(false);

    const response = await request('PUT', '/api/v1/liquidity/automation', {
      enabled: true,
      intervalSeconds: 600,
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONFLICT');
    expect(response.body.detail).toMatch(/emergency stop/i);
  });

  it('POST /run is 409 while stopped or paused, and 202 with a report otherwise', async () => {
    const body = { chain: 'base', poolId: '0xcdac0d6c6c59727a65f871236188350531885c43' };
    services.state.setEmergencyStop(true, 'test', 'operator');
    expect((await request('POST', '/api/v1/liquidity/run', body)).status).toBe(409);
    services.state.setEmergencyStop(false, null, 'operator');
    services.state.setGlobalPause(true, 'test', 'operator');
    const paused = await request('POST', '/api/v1/liquidity/run', body);
    expect(paused.status).toBe(409);
    expect(paused.body.detail).toMatch(/paused/);
    services.state.setGlobalPause(false, null, 'operator');

    const bad = await request('POST', '/api/v1/liquidity/run', { chain: 'mars', poolId: 'x' });
    expect(bad.status).toBe(422);

    // No LP adapter for Base in this harness: the cycle is skipped and says why.
    const response = await request('POST', '/api/v1/liquidity/run', body);
    expect(response.status).toBe(202);
    expect(response.body.data.outcome).toBe('skipped');
    expect(response.body.data.reason).toMatch(/no LP adapter/);
    const view = await request('GET', '/api/v1/liquidity');
    expect(view.body.data.actions[0].action).toBe('HOLD');
    expect(view.body.data.automation.lastCycleAt).not.toBeNull();
  });
});
