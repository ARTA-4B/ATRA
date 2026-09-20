import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { buildServices, shutdownServices } from '../src/core/services.js';
import { loadConfig } from '../src/config/env.js';
import type { Services } from '../src/core/services.js';
import type { AppEnv } from '../src/http/context.js';
import { requestContext } from '../src/http/middleware.js';
import { toProblem } from '../src/http/respond.js';
import { TREASURY_ADMIN_HEADER, treasuryRoutes } from '../src/http/routes/treasury.js';
import { TreasuryService } from '../src/treasury/service.js';
import {
  TREASURY_ADMIN_FAILURE_LIMIT,
  TREASURY_GATE_FAILURE_LIMIT,
} from '../src/treasury/admin.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/provider.js';
import type { MarketDataProvider } from '../src/market/types.js';
import { EVM_NATIVE_SENTINEL } from '../src/chains/registry.js';

/**
 * The treasury routes over a real session, database and audit trail.
 *
 * The router is mounted on a fresh Hono app with the same context the
 * production server attaches, so nothing about the route code is different;
 * only the host and CSRF guards are absent. The `incoming` binding carries
 * the client address the local-only guard reads, exactly as
 * @hono/node-server provides it.
 */

const PASSWORD = 'correct horse battery staple';
const ADMIN_SECRET = 'treasury admin secret 2026';
const FAST_KDF = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TREASURY_BASE = '0x1111111111111111111111111111111111111111';
const RECIPIENT_BASE = '0x2222222222222222222222222222222222222222';

function fakeMarket(): MarketDataProvider {
  const prices = new Map([
    [USDC_BASE, '1'],
    [EVM_NATIVE_SENTINEL, '2500'],
  ]);
  return {
    source: 'dexscreener',
    chains: ['base', 'bsc', 'robinhood', 'solana'],
    health: () =>
      Promise.resolve({
        source: 'dexscreener',
        healthy: true,
        latencyMs: 1,
        error: null,
        chains: [],
      }),
    getPoolsForToken: () => Promise.resolve([]),
    getPool: () => Promise.resolve(null),
    getTokenPriceUsd: (_chain, token) => Promise.resolve(prices.get(token) ?? null),
    search: () => Promise.resolve([]),
  };
}

function noActionModel(): LlmProvider {
  return {
    kind: 'openai-compatible',
    model: 'scripted',
    available: () => Promise.resolve({ available: true, detail: 'ok' }),
    chat: <T>(_request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResponse<T>> =>
      Promise.resolve({
        data: schema.parse({
          summary: 'nothing to do',
          concerns: [],
          recommendedActions: [
            { action: 'NO_ACTION', provider: null, amountUsd: '0', reason: 'ok' },
          ],
          confidence: 0.9,
        }),
        toolCalls: [],
        model: 'scripted',
        latencyMs: 1,
        usage: { promptTokens: null, completionTokens: null },
        attempts: 1,
      }),
  };
}

interface Reply {
  status: number;
  body: any;
}

describe('Phase 5: treasury routes', () => {
  let services: Services;
  let treasury: TreasuryService;
  let app: Hono<AppEnv>;
  let cookie: string;
  let adminToken: string | undefined;
  let remoteAddress: string | undefined = '127.0.0.1';

  const request = async (
    method: string,
    path: string,
    body?: unknown,
    options: { cookie?: string; token?: string | null } = {},
  ): Promise<Reply> => {
    const headers: Record<string, string> = { host: '127.0.0.1:3000' };
    const sessionCookie = options.cookie ?? cookie;
    if (sessionCookie) headers['cookie'] = sessionCookie;
    const token = options.token === undefined ? adminToken : options.token;
    if (token) headers[TREASURY_ADMIN_HEADER] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const env =
      remoteAddress === undefined ? undefined : { incoming: { socket: { remoteAddress } } };
    const response = await app.request(
      path,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      env,
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const setupAndLogin = async () => {
    const setup = await request('POST', '/api/v1/treasury/admin/setup', {
      adminSecret: ADMIN_SECRET,
    });
    expect(setup.status).toBe(201);
    const login = await request('POST', '/api/v1/treasury/admin/login', {
      adminSecret: ADMIN_SECRET,
    });
    expect(login.status).toBe(200);
    adminToken = login.body.data.token;
  };

  /** Caps, a treasury address and an on-chain provider through the API. */
  const configure = async () => {
    const config = await request('PUT', '/api/v1/treasury/config', {
      caps: { perPaymentCapUsd: '100', monthlyCapUsd: '250', approvalThresholdUsd: '50' },
      addresses: [
        {
          chain: 'base',
          address: TREASURY_BASE,
          label: 'treasury',
          tokens: [{ address: USDC_BASE, symbol: 'USDC', decimals: 6 }],
        },
      ],
    });
    expect(config.status).toBe(200);
    const provider = await request('POST', '/api/v1/treasury/providers', {
      name: 'Keyed RPC',
      category: 'rpc',
      billingMode: 'on-chain',
      monthlyBudgetUsd: '200',
      recipient: { chain: 'base', address: RECIPIENT_BASE },
    });
    expect(provider.status).toBe(201);
    return provider.body.data as { id: string };
  };

  beforeEach(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ATRA_MODE: 'ci',
      ATRA_LOG_LEVEL: 'silent',
      ATRA_DATA_DIR: './.test-data',
    });
    services = buildServices(config, {
      databaseFile: ':memory:',
      kdfParams: FAST_KDF,
      llm: noActionModel(),
      marketProviders: [fakeMarket()],
    });
    treasury = new TreasuryService({
      db: services.db,
      audit: services.audit,
      adapters: services.adapters,
      market: services.market,
      llm: services.llm,
      kdfParams: FAST_KDF,
    });

    await services.auth.setPassword(PASSWORD);
    await services.vault.initialize(PASSWORD);
    services.state.createInstallation(randomUUID(), 'test', ['base']);
    services.riskPolicy.initialize(['base']);
    services.wallets.createAgentWallets();
    services.state.completeSetup();
    const session = await services.auth.login(PASSWORD);
    cookie = `atra_session=${session.token}`;
    adminToken = undefined;
    remoteAddress = '127.0.0.1';

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
    app.route('/api/v1/treasury', treasuryRoutes(treasury));
  });

  afterEach(() => {
    shutdownServices(services);
  });

  describe('the admin gate', () => {
    it('setup is loopback-only, needs a session, and is single-use', async () => {
      const anonymous = await request(
        'POST',
        '/api/v1/treasury/admin/setup',
        { adminSecret: ADMIN_SECRET },
        { cookie: '' },
      );
      expect(anonymous.status).toBe(401);

      remoteAddress = '203.0.113.7';
      const remote = await request('POST', '/api/v1/treasury/admin/setup', {
        adminSecret: ADMIN_SECRET,
      });
      expect(remote.status).toBe(403);
      expect(remote.body.code).toBe('LOOPBACK_ONLY');

      remoteAddress = undefined;
      const unknown = await request('POST', '/api/v1/treasury/admin/setup', {
        adminSecret: ADMIN_SECRET,
      });
      expect(unknown.status).toBe(403);

      remoteAddress = '127.0.0.1';
      const short = await request('POST', '/api/v1/treasury/admin/setup', { adminSecret: 'short' });
      expect(short.status).toBe(422);
      expect(short.body.errors[0].path).toBe('adminSecret');

      const status0 = await request('GET', '/api/v1/treasury/admin/status');
      expect(status0.body.data).toMatchObject({
        configured: false,
        authenticated: false,
        frozen: false,
      });

      const first = await request('POST', '/api/v1/treasury/admin/setup', {
        adminSecret: ADMIN_SECRET,
      });
      expect(first.status).toBe(201);
      const second = await request('POST', '/api/v1/treasury/admin/setup', {
        adminSecret: 'another secret entirely',
      });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('ALREADY_INITIALIZED');

      // The hash is Argon2id and the secret is nowhere in the database.
      const row = services.db
        .prepare<[], { admin_algorithm: string; admin_hash: Uint8Array }>(
          'SELECT admin_algorithm, admin_hash FROM treasury_config WHERE id = 1',
        )
        .get()!;
      expect(row.admin_algorithm).toBe('argon2id');
      expect(row.admin_hash.length).toBe(32);
      const dump = services.db
        .prepare<[], { detail_json: string }>('SELECT detail_json FROM audit_events')
        .all()
        .map((r) => r.detail_json)
        .join('\n');
      expect(dump).not.toContain(ADMIN_SECRET);
    });

    it('login needs the credential to exist, refuses a wrong secret, and locks out after repeated failures', async () => {
      const early = await request('POST', '/api/v1/treasury/admin/login', {
        adminSecret: ADMIN_SECRET,
      });
      expect(early.status).toBe(409);
      expect(early.body.errors[0].message).toBe('TREASURY_ADMIN_NOT_CONFIGURED');

      await request('POST', '/api/v1/treasury/admin/setup', { adminSecret: ADMIN_SECRET });
      for (let i = 0; i < TREASURY_ADMIN_FAILURE_LIMIT; i += 1) {
        const wrong = await request('POST', '/api/v1/treasury/admin/login', {
          adminSecret: 'wrong secret, wrong',
        });
        expect(wrong.status).toBe(401);
        expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      }
      const locked = await request('POST', '/api/v1/treasury/admin/login', {
        adminSecret: ADMIN_SECRET,
      });
      expect(locked.status).toBe(429);
      expect(locked.body.retryAfterSec).toBeGreaterThan(0);
      const failures = services.audit.list({ category: 'system', limit: 100 });
      expect(failures.filter((r) => r.action === 'treasury.admin.login.failed')).toHaveLength(
        TREASURY_ADMIN_FAILURE_LIMIT,
      );
      expect(failures.some((r) => r.action === 'treasury.admin.locked')).toBe(true);
    });

    it("every admin route refuses without the token, with the wrong token, and with another session's token", async () => {
      await setupAndLogin();
      const valid = adminToken!;
      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/api/v1/treasury'],
        ['GET', '/api/v1/treasury/config'],
        ['PUT', '/api/v1/treasury/config', {}],
        ['GET', '/api/v1/treasury/providers'],
        ['POST', '/api/v1/treasury/providers', {}],
        ['PUT', '/api/v1/treasury/providers/x', {}],
        ['GET', '/api/v1/treasury/expenses'],
        ['POST', '/api/v1/treasury/expenses', {}],
        ['GET', '/api/v1/treasury/proposals'],
        ['POST', '/api/v1/treasury/proposals', {}],
        ['POST', '/api/v1/treasury/proposals/x/approve', {}],
        ['POST', '/api/v1/treasury/proposals/x/reject', {}],
        ['POST', '/api/v1/treasury/proposals/x/cancel', {}],
        ['POST', '/api/v1/treasury/proposals/x/export'],
        ['POST', '/api/v1/treasury/freeze', {}],
        ['POST', '/api/v1/treasury/freeze/clear', {}],
        ['POST', '/api/v1/treasury/run'],
        ['GET', '/api/v1/treasury/alerts'],
        ['POST', '/api/v1/treasury/alerts/x/ack'],
      ];

      const other = await services.auth.login(PASSWORD);
      const otherCookie = `atra_session=${other.token}`;

      for (const [method, path, body] of routes) {
        const noSession = await request(method, path, body, { cookie: '', token: null });
        expect(noSession.status, `${method} ${path} without a session`).toBe(401);

        const noToken = await request(method, path, body, { token: null });
        expect(noToken.status, `${method} ${path} without the token`).toBe(403);
        expect(noToken.body.code).toBe('REAUTH_REQUIRED');
        expect(noToken.body.errors[0].message).toBe('TREASURY_ADMIN_REQUIRED');

        const badToken = await request(method, path, body, { token: 'tadm_not_a_real_token' });
        expect(badToken.status, `${method} ${path} with a bad token`).toBe(403);
        expect(badToken.body.code).toBe('REAUTH_INVALID');

        const wrongSession = await request(method, path, body, {
          cookie: otherCookie,
          token: valid,
        });
        expect(wrongSession.status, `${method} ${path} from another session`).toBe(403);
        expect(wrongSession.body.errors[0].message).toBe('TREASURY_ADMIN_INVALID');
      }

      // No treasury data was written by any of the refused calls.
      expect(treasury.listProviders()).toEqual([]);
      expect(treasury.listProposals()).toEqual([]);
      expect(treasury.isFrozen()).toBe(false);
    });

    it('throttles a session that keeps presenting invalid tokens', async () => {
      await setupAndLogin();
      for (let i = 0; i < TREASURY_GATE_FAILURE_LIMIT; i += 1) {
        const bad = await request('GET', '/api/v1/treasury/config', undefined, {
          token: `tadm_bad_${String(i)}`,
        });
        expect(bad.status).toBe(403);
      }
      const throttled = await request('GET', '/api/v1/treasury/config');
      expect(throttled.status).toBe(429);
      expect(throttled.body.code).toBe('RATE_LIMITED');
    });

    it('logout revokes the token; status reflects it', async () => {
      await setupAndLogin();
      const before = await request('GET', '/api/v1/treasury/admin/status');
      expect(before.body.data.authenticated).toBe(true);
      const logout = await request('POST', '/api/v1/treasury/admin/logout');
      expect(logout.body.data.revoked).toBe(1);
      const after = await request('GET', '/api/v1/treasury/admin/status');
      expect(after.body.data.authenticated).toBe(false);
      const refused = await request('GET', '/api/v1/treasury/config');
      expect(refused.status).toBe(403);
    });
  });

  describe('the admin surface', () => {
    beforeEach(async () => {
      await setupAndLogin();
    });

    it('GET / returns the dashboard shape, and every route leaves an audit row by treasury-admin', async () => {
      await configure();
      const view = await request('GET', '/api/v1/treasury');
      expect(view.status).toBe(200);
      expect(view.body.meta.source).toBe('rpc');
      const data = view.body.data;
      expect(data.notice).toContain('watch-only');
      expect(data.caps.perPaymentCapUsd).toBe('100.000000');
      expect(data.addresses[0].address).toBe(TREASURY_BASE);
      // No adapters in CI: unreadable, reported, never zero.
      expect(data.balances.complete).toBe(false);
      expect(data.balances.assets.every((a: { amount: string | null }) => a.amount === null)).toBe(
        true,
      );
      expect(data.balances.assets[0].reason).toContain('no adapter');
      expect(data.runway.months).toBeNull();
      expect(data.runway.reason).toContain('incomplete');
      expect(data.burn.basis).toBe('none');
      expect(data.providers).toHaveLength(1);
      expect(data.proposals.pending).toEqual([]);
      expect(data.alerts.some((a: { kind: string }) => a.kind === 'balance_unreadable')).toBe(true);
      expect(data.modelStatus).toBe('UNTRAINED');

      const rows = services.audit.list({ category: 'system', limit: 200 });
      const byAdmin = rows.filter((r) => r.actor === 'treasury-admin').map((r) => r.action);
      expect(byAdmin).toContain('treasury.dashboard.read');
      expect(byAdmin).toContain('treasury.config.updated');
      expect(byAdmin).toContain('treasury.provider.added');
      expect(byAdmin).toContain('treasury.admin.login');
      expect(byAdmin).toContain('treasury.admin.set');
    });

    it('walks a proposal from creation to an exported human instruction', async () => {
      const provider = await configure();
      const created = await request('POST', '/api/v1/treasury/proposals', {
        providerId: provider.id,
        amountUsd: '75',
        asset: 'USDC',
        memo: 'September',
      });
      expect(created.status).toBe(201);
      const id = created.body.data.id as string;
      expect(created.body.data.status).toBe('proposed');
      expect(created.body.data.recipient).toBe(RECIPIENT_BASE);

      // Over the approval threshold without the creator flag: rejected, with the checks.
      const noFlag = await request('POST', `/api/v1/treasury/proposals/${id}/approve`, {});
      expect(noFlag.status).toBe(409);
      expect(noFlag.body.errors[0].path).toBe('approval.creator');
      const rejected = await request('GET', '/api/v1/treasury/proposals?status=rejected');
      expect(rejected.body.data).toHaveLength(1);
      expect(rejected.body.data[0].decision.code).toBe('CREATOR_APPROVAL_REQUIRED');

      const again = await request('POST', '/api/v1/treasury/proposals', {
        providerId: provider.id,
        amountUsd: '75',
        asset: 'USDC',
      });
      const id2 = again.body.data.id as string;
      const approved = await request('POST', `/api/v1/treasury/proposals/${id2}/approve`, {
        creatorApproval: true,
        note: 'creator ok',
      });
      expect(approved.status).toBe(200);
      expect(approved.body.data.status).toBe('approved');

      const exported = await request('POST', `/api/v1/treasury/proposals/${id2}/export`);
      expect(exported.status).toBe(200);
      const instruction = exported.body.data;
      expect(instruction.from).toBe(TREASURY_BASE);
      expect(instruction.recipient).toBe(RECIPIENT_BASE);
      expect(instruction.amountUsd).toBe('75.000000');
      expect(instruction.amountBaseUnits).toBe('75000000');
      expect(instruction.asset.symbol).toBe('USDC');
      expect(instruction.notice).toContain('cannot sign');
      expect(Object.keys(instruction)).not.toContain('signature');
      expect(Object.keys(instruction)).not.toContain('data');

      const twice = await request('POST', `/api/v1/treasury/proposals/${id2}/export`);
      expect(twice.status).toBe(409);
    });

    it('refuses over-cap and non-allowlisted requests through the API, with the checks', async () => {
      const provider = await configure();
      const over = await request('POST', '/api/v1/treasury/proposals', {
        providerId: provider.id,
        amountUsd: '100.5',
        asset: 'USDC',
      });
      expect(over.status).toBe(409);
      expect(over.body.errors.map((e: { path: string }) => e.path)).toEqual(['amount.perPayment']);

      const unknown = await request('POST', '/api/v1/treasury/proposals', {
        providerId: randomUUID(),
        amountUsd: '1',
        asset: 'USDC',
      });
      expect(unknown.status).toBe(409);
      expect(unknown.body.errors[0].message).toContain('PROVIDER_UNKNOWN');

      const badAsset = await request('POST', '/api/v1/treasury/proposals', {
        providerId: provider.id,
        amountUsd: '1',
        asset: 'DOGE',
      });
      expect(badAsset.status).toBe(409);
      expect(badAsset.body.errors[0].message).toContain('ASSET_UNKNOWN');

      // There is no field for a recipient: the schema is strict.
      const withRecipient = await request('POST', '/api/v1/treasury/proposals', {
        providerId: provider.id,
        amountUsd: '1',
        asset: 'USDC',
        recipient: '0x3333333333333333333333333333333333333333',
      });
      expect(withRecipient.status).toBe(422);
    });

    it('a card provider gets a manual payable via POST /expenses and never a proposal', async () => {
      await configure();
      const card = await request('POST', '/api/v1/treasury/providers', {
        name: 'Card Host',
        category: 'hosting',
        billingMode: 'card',
        monthlyBudgetUsd: '50',
      });
      expect(card.status).toBe(201);
      const refused = await request('POST', '/api/v1/treasury/proposals', {
        providerId: card.body.data.id,
        amountUsd: '10',
        asset: 'USDC',
      });
      expect(refused.status).toBe(409);
      expect(refused.body.errors[0].message).toContain('PROVIDER_NOT_ON_CHAIN');

      const payable = await request('POST', '/api/v1/treasury/expenses', {
        providerId: card.body.data.id,
        period: '2026-09',
        amountUsd: '12',
        kind: 'manual-payable',
        status: 'payable',
        note: 'September invoice, pay by card',
      });
      expect(payable.status).toBe(201);
      expect(payable.body.data.kind).toBe('manual-payable');
      const view = await request('GET', '/api/v1/treasury');
      expect(view.body.data.manualPayables).toHaveLength(1);
      expect(view.body.data.proposals.pending).toEqual([]);

      const bad = await request('GET', '/api/v1/treasury/expenses?period=2026-9');
      expect(bad.status).toBe(422);
    });

    it('freeze refuses approval and export, is audited, and is cleared separately', async () => {
      const provider = await configure();
      const p = await request('POST', '/api/v1/treasury/proposals', {
        providerId: provider.id,
        amountUsd: '10',
        asset: 'USDC',
      });
      const freeze = await request('POST', '/api/v1/treasury/freeze', {
        reason: 'audit in progress',
      });
      expect(freeze.status).toBe(200);
      expect(freeze.body.data.frozen).toBe(true);
      expect(freeze.body.data.frozenBy).toBe('treasury-admin');

      const approve = await request(
        'POST',
        `/api/v1/treasury/proposals/${p.body.data.id}/approve`,
        { creatorApproval: true },
      );
      expect(approve.status).toBe(409);
      expect(approve.body.errors[0].message).toBe('FROZEN');
      const status = await request('GET', '/api/v1/treasury/admin/status');
      expect(status.body.data.frozen).toBe(true);

      const cleared = await request('POST', '/api/v1/treasury/freeze/clear', {
        note: 'audit finished',
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.frozen).toBe(false);
      const twice = await request('POST', '/api/v1/treasury/freeze/clear', { note: 'again' });
      expect(twice.status).toBe(409);
      const actions = services.audit.list({ category: 'system', limit: 100 }).map((r) => r.action);
      expect(actions).toContain('treasury.frozen');
      expect(actions).toContain('treasury.freeze.cleared');
    });

    it('POST /run performs one review and returns NO_ACTION with the scripted model', async () => {
      await configure();
      const run = await request('POST', '/api/v1/treasury/run');
      expect(run.status).toBe(202);
      expect(run.body.data.modelStatus).toBe('UNTRAINED');
      expect(run.body.data.actions.map((a: { action: string }) => a.action)).toEqual(['NO_ACTION']);
      const alerts = await request('GET', '/api/v1/treasury/alerts');
      expect(alerts.status).toBe(200);
      const ack = await request('POST', `/api/v1/treasury/alerts/${alerts.body.data[0].id}/ack`);
      expect(ack.status).toBe(200);
      expect(ack.body.data.acknowledgedAt).not.toBeNull();
    });

    it('validates config and provider bodies strictly', async () => {
      const extra = await request('PUT', '/api/v1/treasury/config', {
        caps: { perPaymentCapUsd: '1e3' },
      });
      expect(extra.status).toBe(422);
      const badAddress = await request('PUT', '/api/v1/treasury/config', {
        addresses: [{ chain: 'base', address: '0xZZ', label: 'x' }],
      });
      expect(badAddress.status).toBe(422);
      expect(badAddress.body.errors[0].message).toBe('INVALID_ADDRESS');
      const checksum = await request('PUT', '/api/v1/treasury/config', {
        addresses: [
          {
            chain: 'base',
            // Mixed case with a checksum that does not match: refused, not lowercased.
            address: '0xaBcDeF0123456789aBcDeF0123456789aBcDeF01',
            label: 'x',
          },
        ],
      });
      expect(checksum.status).toBe(422);
      const noRecipient = await request('POST', '/api/v1/treasury/providers', {
        name: 'x',
        category: 'rpc',
        billingMode: 'on-chain',
      });
      expect(noRecipient.status).toBe(422);
      const unknownField = await request('POST', '/api/v1/treasury/providers', {
        name: 'x',
        category: 'rpc',
        billingMode: 'card',
        privateKey: '0x00',
      });
      expect(unknownField.status).toBe(422);
    });
  });

  it('the treasury never touches the agent wallets or the ledger', async () => {
    await setupAndLogin();
    await configure();
    const walletsBefore = services.wallets.list();
    const paperBefore = services.ledger.listPositions('PAPER');
    await request('POST', '/api/v1/treasury/run');
    await request('GET', '/api/v1/treasury');
    expect(services.wallets.list()).toEqual(walletsBefore);
    expect(services.ledger.listPositions('PAPER')).toEqual(paperBefore);
    // No wallet or trade audit rows were written by the treasury.
    const rows = services.audit.list({ limit: 500 });
    expect(rows.filter((r) => r.actor === 'treasury-admin' && r.category !== 'system')).toEqual([]);
  });
});
