import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../src/http/context.js';
import { csrfGuard, hostGuard, requestContext, securityHeaders } from '../src/http/middleware.js';
import { toProblem } from '../src/http/respond.js';
import { telegramRoutes } from '../src/http/routes/telegram.js';
import { shutdownServices } from '../src/core/services.js';
import { PAIR_CODE_RE } from '../src/telegram/protocol.js';
import { OPERATOR, harness } from './telegram-harness.js';
import type { Harness } from './telegram-harness.js';

/**
 * The dashboard's Telegram routes, mounted on a minimal app with the same
 * middleware stack as the real server: request context, security headers,
 * the services binding, the host guard and the CSRF guard. Sessions are
 * real; the transport is the fake from the harness.
 */

function app(h: Harness): Hono<AppEnv> {
  const root = new Hono<AppEnv>();
  root.onError((error, c) => {
    const problem = toProblem(error, c.get('requestId') ?? 'unknown');
    return c.json(problem, problem.status as 400, { 'content-type': 'application/problem+json' });
  });
  root.use('*', requestContext());
  root.use('*', securityHeaders());
  root.use('*', async (c, next) => {
    c.set('services', h.services);
    c.set('mode', h.services.state.getMode());
    await next();
  });
  root.use('*', hostGuard(h.services.config.hostAllowlist));
  root.use('*', csrfGuard(h.services.config.corsOrigins));
  root.route('/api/v1/telegram', telegramRoutes(h.telegram));
  return root;
}

class Client {
  readonly #app: Hono<AppEnv>;
  cookie: string | undefined;

  constructor(hono: Hono<AppEnv>) {
    this.#app = hono;
  }

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
      host: '127.0.0.1:3000',
      'x-atra-client': 'atra-dashboard',
    };
    if (this.cookie) headers['cookie'] = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.#app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
}

function signedIn(h: Harness): Client {
  const client = new Client(app(h));
  const session = h.services.auth.createSession();
  client.cookie = `atra_session=${session.token}`;
  return client;
}

describe('/api/v1/telegram', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('requires a session', async () => {
    h = await harness();
    const client = new Client(app(h));
    const response = await client.call('GET', '/api/v1/telegram');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    const pair = await client.call('POST', '/api/v1/telegram/pair', {});
    expect(pair.status).toBe(401);
  });

  it('returns the view with the contract shape when nothing is configured', async () => {
    h = await harness({ transport: null });
    const client = signedIn(h);
    const response = await client.call('GET', '/api/v1/telegram');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      configured: false,
      paired: false,
      botUrl: null,
      botUsername: null,
      account: null,
      installation: 'test-install',
      notifications: {
        riskRejections: true,
        tradeDecisions: true,
        liquidityUpdates: true,
        runtimeAlerts: true,
      },
      transport: null,
      connected: false,
      alertsEnabled: true,
    });
    expect(response.body.meta.source).toBe('local');

    const pair = await client.call('POST', '/api/v1/telegram/pair', {});
    expect(pair.status).toBe(409);
    expect(pair.body.code).toBe('TELEGRAM_NOT_CONFIGURED');
  });

  it('issues a code, polls it to confirmed, and unpairs', async () => {
    h = await harness();
    await h.telegram.start();
    const client = signedIn(h);

    const pair = await client.call('POST', '/api/v1/telegram/pair', {});
    expect(pair.status).toBe(201);
    const code: string = pair.body.data.code;
    expect(code).toMatch(PAIR_CODE_RE);
    expect(pair.body.data.command).toBe(`/pair ${code}`);
    expect(pair.body.data.botUrl).toBe('https://t.me/atra_test_bot');
    expect(Date.parse(pair.body.data.expiresAt) - h.clock.now).toBe(5 * 60_000);
    // The transport was offered the hash, never the code.
    expect(h.transport.offers).toHaveLength(1);
    expect(h.transport.offers[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(h.transport.offers)).not.toContain(code.replace('-', ''));

    let status = await client.call('GET', `/api/v1/telegram/pair/${code}`);
    expect(status.body.data).toEqual({ status: 'pending' });

    h.transport.events!.onPaired(OPERATOR, h.clock.now);
    status = await client.call('GET', `/api/v1/telegram/pair/${code.toLowerCase()}`);
    expect(status.body.data).toEqual({ status: 'confirmed' });

    const view = await client.call('GET', '/api/v1/telegram');
    expect(view.body.data.paired).toBe(true);
    expect(view.body.data.account).toEqual({
      displayName: 'Rizky',
      userIdMasked: '******789',
      pairedAt: new Date(h.clock.now).toISOString(),
    });
    expect(JSON.stringify(view.body)).not.toContain(String(OPERATOR.userId));

    const unpair = await client.call('POST', '/api/v1/telegram/unpair', {});
    expect(unpair.status).toBe(200);
    expect(unpair.body.data.paired).toBe(false);
    expect(unpair.body.data.account).toBeNull();
    expect(h.transport.revokes).toBe(1);
  });

  it('reports an expired or unknown code as expired and refuses a malformed one', async () => {
    h = await harness();
    const client = signedIn(h);
    const pair = await client.call('POST', '/api/v1/telegram/pair', {});
    const code: string = pair.body.data.code;
    h.clock.now += 5 * 60_000 + 1;
    expect((await client.call('GET', `/api/v1/telegram/pair/${code}`)).body.data.status).toBe(
      'expired',
    );
    expect((await client.call('GET', '/api/v1/telegram/pair/AAAA-2222')).body.data.status).toBe(
      'expired',
    );
    // The contract's regex admits O and I; the alphabet never issues them, so
    // such a code is merely unknown. A wrong-length one is malformed.
    expect((await client.call('GET', '/api/v1/telegram/pair/NOTA-CODE')).body.data.status).toBe(
      'expired',
    );
    const bad = await client.call('GET', '/api/v1/telegram/pair/nope');
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('SCHEMA_INVALID');
  });

  it('updates notification toggles with PUT or PATCH and validates the body', async () => {
    h = await harness();
    const client = signedIn(h);
    const put = await client.call('PUT', '/api/v1/telegram/notifications', {
      riskRejections: false,
      tradeDecisions: true,
      liquidityUpdates: false,
      runtimeAlerts: true,
    });
    expect(put.status).toBe(200);
    expect(put.body.data.notifications).toEqual({
      riskRejections: false,
      tradeDecisions: true,
      liquidityUpdates: false,
      runtimeAlerts: true,
    });

    const patch = await client.call('PATCH', '/api/v1/telegram/notifications', {
      riskRejections: true,
    });
    expect(patch.body.data.notifications.riskRejections).toBe(true);
    expect(patch.body.data.notifications.liquidityUpdates).toBe(false);

    const invalid = await client.call('PUT', '/api/v1/telegram/notifications', {
      riskRejections: 'yes',
    });
    expect(invalid.status).toBe(422);
    const unknown = await client.call('PUT', '/api/v1/telegram/notifications', { other: true });
    expect(unknown.status).toBe(422);

    const audit = h.services.audit.list({ category: 'telegram' });
    expect(audit.some((row) => row.action === 'telegram.notifications.updated')).toBe(true);
  });

  it('refuses writes without the dashboard header', async () => {
    h = await harness();
    const client = signedIn(h);
    const root = app(h);
    const response = await root.request('/api/v1/telegram/pair', {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', cookie: client.cookie! },
    });
    expect(response.status).toBe(403);
  });
});
