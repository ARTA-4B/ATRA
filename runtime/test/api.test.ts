import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/server.js';
import { buildServices, shutdownServices } from '../src/core/services.js';
import { loadConfig } from '../src/config/env.js';
import type { Services } from '../src/core/services.js';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/http/context.js';
import type { ChainAdapter } from '../src/chains/types.js';
import type { ChainId } from '../src/chains/registry.js';

/**
 * End-to-end tests over the real HTTP surface.
 *
 * These exercise the whole stack: middleware, session cookies, the vault, the
 * database and the audit trail. Chain adapters are stubbed so the suite never
 * touches the network, but nothing else is mocked — in particular, wallets are
 * really generated and really encrypted.
 */

const PASSWORD = 'correct horse battery staple';

/**
 * Cheap key-derivation parameters. The production defaults are asserted
 * separately in the vault tests; repeating that cost on every request here
 * would turn a fast suite into a slow one without testing anything new.
 */
const FAST_KDF = { memoryKib: 1024, iterations: 1, parallelism: 1 };

function stubAdapter(chain: ChainId, overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  const observation = <T>(value: T) => ({ value, observedAt: Date.now(), source: 'stub' });

  return {
    chain,
    health: () =>
      Promise.resolve({
        chain,
        healthy: true,
        height: 1000,
        latencyMs: 5,
        endpoint: 'stub',
        error: null,
        identity: 'stub',
        identityMatches: true,
      }),
    getNativeBalance: (address: string) =>
      Promise.resolve(
        observation({
          chain,
          address,
          amount: '1000000000000000000',
          symbol: 'ETH',
          decimals: 18,
        }),
      ),
    getTokenBalance: (owner: string, token: string) =>
      Promise.resolve(
        observation({ chain, owner, token, amount: '5000000', symbol: 'USDC', decimals: 6 }),
      ),
    getTokenMetadata: (address: string) =>
      Promise.resolve(
        observation({ chain, address, symbol: 'USDC', name: 'USD Coin', decimals: 6 }),
      ),
    estimateTransferFee: () =>
      Promise.resolve(
        observation({ chain, nativeAmount: '126000000000', unitPrice: '6000000', units: 21000 }),
      ),
    getTransactionStatus: (hash: string) =>
      Promise.resolve(
        observation({
          chain,
          hash,
          state: 'confirmed' as const,
          height: 1,
          confirmations: 1,
          error: null,
        }),
      ),
    ...overrides,
  };
}

/** A client that carries the session cookie and the dashboard header. */
class TestClient {
  #cookie: string | undefined;
  #reauth: string | undefined;

  readonly #app: Hono<AppEnv>;

  constructor(app: Hono<AppEnv>) {
    this.#app = app;
  }

  /** The address the runtime believes the client connected from. */
  remoteAddress: string | undefined = '127.0.0.1';

  async request(
    method: string,
    path: string,
    body?: unknown,
    options: { reauth?: boolean; host?: string; omitClientHeader?: boolean } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers: Record<string, string> = { host: options.host ?? '127.0.0.1:3000' };
    if (!options.omitClientHeader) headers['x-atra-client'] = 'atra-dashboard';
    if (this.#cookie) headers['cookie'] = this.#cookie;
    if (options.reauth && this.#reauth) headers['x-atra-reauth'] = this.#reauth;
    if (body !== undefined) headers['content-type'] = 'application/json';

    // @hono/node-server exposes the Node request as c.env.incoming; the local-only
    // guard reads the socket address from it, so the test client supplies the
    // same shape. Leaving it undefined exercises the fail-closed path.
    const env =
      this.remoteAddress === undefined
        ? undefined
        : { incoming: { socket: { remoteAddress: this.remoteAddress } } };

    const response = await this.#app.request(
      path,
      {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const value = setCookie.split(';')[0];
      this.#cookie = value?.startsWith('atra_session=') && !value.endsWith('=') ? value : undefined;
    }

    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    return { status: response.status, body: parsed, headers: response.headers };
  }

  get = (path: string, options = {}) => this.request('GET', path, undefined, options);
  post = (path: string, body?: unknown, options = {}) => this.request('POST', path, body, options);
  put = (path: string, body?: unknown, options = {}) => this.request('PUT', path, body, options);

  setReauth(token: string): void {
    this.#reauth = token;
  }
}

describe('ATRA HTTP API', () => {
  let services: Services;
  let app: Hono<AppEnv>;
  let client: TestClient;

  beforeEach(() => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ATRA_MODE: 'ci',
      ATRA_LOG_LEVEL: 'silent',
      ATRA_DATA_DIR: './.test-data',
    });

    const adapters = new Map<ChainId, ChainAdapter>([
      ['base', stubAdapter('base')],
      ['bsc', stubAdapter('bsc')],
      ['robinhood', stubAdapter('robinhood')],
      ['solana', stubAdapter('solana')],
    ]);

    services = buildServices(config, { databaseFile: ':memory:', adapters, kdfParams: FAST_KDF });
    app = createApp(services);
    client = new TestClient(app);
  });

  afterEach(() => {
    shutdownServices(services);
  });

  describe('health and metadata', () => {
    it('serves health without authentication', async () => {
      const response = await client.get('/health');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.mode).toBe('PAPER');
    });

    it('reports not ready until setup is complete', async () => {
      const response = await client.get('/ready');
      expect(response.status).toBe(503);
      expect(response.body.setupRequired).toBe(true);
    });

    it('lists exactly the four supported chains', async () => {
      const response = await client.get('/api/v1/meta');
      expect(response.body.data.supportedChains.map((chain: { id: string }) => chain.id)).toEqual([
        'base',
        'bsc',
        'robinhood',
        'solana',
      ]);
    });

    it('reports the model as UNTRAINED', async () => {
      const response = await client.get('/api/v1/meta');
      expect(response.body.data.modelStatus).toBe('UNTRAINED');
    });
  });

  describe('security guards', () => {
    it('rejects a request with an unexpected Host header', async () => {
      const response = await client.get('/health', { host: 'evil.example.com' });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('rejects a write without the dashboard header', async () => {
      const response = await client.post(
        '/api/v1/auth/setup',
        { password: PASSWORD },
        { omitClientHeader: true },
      );
      expect(response.status).toBe(403);
    });

    it('requires a session for protected routes', async () => {
      const response = await client.get('/api/v1/wallet');
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    });

    it('returns problem+json for errors', async () => {
      const response = await client.get('/api/v1/wallet');
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(response.body.requestId).toBeDefined();
    });

    it('returns 404 for an unknown API path', async () => {
      const response = await client.get('/api/v1/nonexistent');
      expect(response.status).toBe(404);
    });

    it('refuses setup from a non-local address', async () => {
      client.remoteAddress = '203.0.113.7';
      const response = await client.post('/api/v1/auth/setup', { password: PASSWORD });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('LOOPBACK_ONLY');
    });

    it('fails closed when the client address is unknown', async () => {
      client.remoteAddress = undefined;
      const response = await client.post('/api/v1/auth/setup', { password: PASSWORD });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('LOOPBACK_ONLY');
    });

    it('accepts an IPv4-mapped loopback address', async () => {
      client.remoteAddress = '::ffff:127.0.0.1';
      const response = await client.post('/api/v1/auth/setup', { password: PASSWORD });
      expect(response.status).toBe(201);
    });

    it('accepts a configured private range, as a container needs', async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        ATRA_MODE: 'ci',
        ATRA_LOG_LEVEL: 'silent',
        ATRA_DATA_DIR: './.test-data',
        ATRA_LOCAL_CLIENTS: '127.0.0.0/8,::1,172.16.0.0/12',
      });
      const container = buildServices(config, {
        databaseFile: ':memory:',
        adapters: new Map(),
        kdfParams: FAST_KDF,
      });
      const bridge = new TestClient(createApp(container));
      bridge.remoteAddress = '172.17.0.1';

      const response = await bridge.post('/api/v1/auth/setup', { password: PASSWORD });
      expect(response.status).toBe(201);

      bridge.remoteAddress = '203.0.113.7';
      const outside = await bridge.get('/api/v1/meta');
      // Reads are fine from anywhere the host guard admits; only setup/export
      // are local-only.
      expect(outside.status).toBe(200);

      shutdownServices(container);
    });

    it('rejects a malformed local-client entry at startup', () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        ATRA_MODE: 'ci',
        ATRA_LOG_LEVEL: 'silent',
        ATRA_DATA_DIR: './.test-data',
        ATRA_LOCAL_CLIENTS: 'not-an-address',
      });
      const broken = buildServices(config, {
        databaseFile: ':memory:',
        adapters: new Map(),
        kdfParams: FAST_KDF,
      });
      const c = new TestClient(createApp(broken));
      // The list is built lazily on first use, and a bad entry must surface
      // as a server error rather than silently admitting or refusing everyone.
      return c.post('/api/v1/auth/setup', { password: PASSWORD }).then((response) => {
        expect(response.status).toBe(422);
        shutdownServices(broken);
      });
    });
  });

  describe('first-run setup', () => {
    it('walks the whole wizard and ends in PAPER mode', async () => {
      const setup = await client.post('/api/v1/auth/setup', { password: PASSWORD });
      expect(setup.status).toBe(201);
      expect(setup.body.data.vaultUnlocked).toBe(true);

      const wallets = await client.post('/api/v1/setup/wallets');
      expect(wallets.status).toBe(201);
      expect(wallets.body.data).toHaveLength(2);

      const evm = wallets.body.data.find((w: { family: string }) => w.family === 'evm');
      const solana = wallets.body.data.find((w: { family: string }) => w.family === 'solana');
      expect(evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(solana.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(evm.chains).toEqual(['base', 'bsc', 'robinhood']);
      expect(solana.chains).toEqual(['solana']);

      const complete = await client.post('/api/v1/setup/complete', {
        name: 'Test install',
        chains: ['base', 'solana'],
        paperAcknowledged: true,
      });
      expect(complete.status).toBe(200);
      expect(complete.body.data.mode).toBe('PAPER');

      const ready = await client.get('/ready');
      expect(ready.status).toBe(200);
    });

    it('never returns private keys from the setup endpoint', async () => {
      await client.post('/api/v1/auth/setup', { password: PASSWORD });
      const wallets = await client.post('/api/v1/setup/wallets');
      const serialized = JSON.stringify(wallets.body);

      expect(serialized).not.toMatch(/0x[0-9a-f]{64}/i);
      expect(Object.keys(wallets.body.data[0]).sort()).toEqual([
        'address',
        'chains',
        'createdAt',
        'family',
      ]);
    });

    it('does not create a second pair of wallets on a repeated call', async () => {
      await client.post('/api/v1/auth/setup', { password: PASSWORD });
      const first = await client.post('/api/v1/setup/wallets');
      const second = await client.post('/api/v1/setup/wallets');

      expect(second.body.data.map((w: { address: string }) => w.address).sort()).toEqual(
        first.body.data.map((w: { address: string }) => w.address).sort(),
      );
    });

    it('refuses to complete setup before wallets exist', async () => {
      await client.post('/api/v1/auth/setup', { password: PASSWORD });
      const response = await client.post('/api/v1/setup/complete', {
        chains: ['base'],
        paperAcknowledged: true,
      });
      expect(response.status).toBe(409);
    });

    it('requires the PAPER acknowledgement', async () => {
      await client.post('/api/v1/auth/setup', { password: PASSWORD });
      await client.post('/api/v1/setup/wallets');
      const response = await client.post('/api/v1/setup/complete', { chains: ['base'] });
      expect(response.status).toBe(422);
    });

    it('refuses a second setup attempt', async () => {
      await client.post('/api/v1/auth/setup', { password: PASSWORD });
      const again = await client.post('/api/v1/auth/setup', { password: PASSWORD });
      expect(again.status).toBe(409);
    });

    it('rejects a short password', async () => {
      const response = await client.post('/api/v1/auth/setup', { password: 'short' });
      expect(response.status).toBe(422);
      expect(response.body.errors[0].path).toBe('password');
    });
  });

  describe('authenticated session', () => {
    beforeEach(async () => {
      await client.post('/api/v1/auth/setup', { password: PASSWORD });
      await client.post('/api/v1/setup/wallets');
      await client.post('/api/v1/setup/complete', {
        chains: ['base', 'solana'],
        paperAcknowledged: true,
      });
    });

    it('reports balances with provenance', async () => {
      const response = await client.get('/api/v1/wallet/balances');
      expect(response.status).toBe(200);
      expect(response.body.meta.source).toBe('rpc');
      expect(response.body.meta.asOf).not.toBeNull();

      const base = response.body.data.find((r: { chain: string }) => r.chain === 'base');
      expect(base.native.amount).toBe('1000000000000000000');
      expect(base.error).toBeNull();
    });

    it('reports an unreadable chain as an error, never as a zero balance', async () => {
      services.adapters.set(
        'base',
        stubAdapter('base', {
          getNativeBalance: () => Promise.reject(new Error('RPC down')),
        }),
      );

      const response = await client.get('/api/v1/wallet/balances?chain=base');
      const base = response.body.data[0];
      expect(base.native).toBeNull();
      expect(base.error).toContain('RPC down');
      expect(response.body.meta.stale).toBe(true);
      expect(response.body.meta.source).toBe('none');
    });

    it('gives a deposit address per enabled chain with a network warning', async () => {
      const response = await client.get('/api/v1/wallet/deposit-address');
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0].warning).toContain('Only send');
    });

    it('reports portfolio value as unavailable rather than zero', async () => {
      const response = await client.get('/api/v1/overview');
      expect(response.body.data.portfolio.totalValueUsd).toBeNull();
      expect(response.body.data.portfolio.reason).toBeTruthy();
    });

    it('ships a conservative default risk policy', async () => {
      const response = await client.get('/api/v1/risk');
      expect(response.status).toBe(200);
      expect(response.body.data.policy.maxAmountPerTradeUsd).toBe('25');
      expect(response.body.data.policy.globalPause).toBe(false);
      expect(response.body.data.policy.lp.maxCapitalPerLpUsd).toBe('0');
    });

    it('persists a risk policy update', async () => {
      const current = await client.get('/api/v1/risk');
      const updated = await client.put('/api/v1/risk', {
        ...current.body.data.policy,
        maxAmountPerTradeUsd: '10',
      });

      expect(updated.status).toBe(200);
      const reread = await client.get('/api/v1/risk');
      expect(reread.body.data.policy.maxAmountPerTradeUsd).toBe('10');
      expect(reread.body.data.version).toBe(2);
    });

    it('rejects an invalid risk policy and keeps the previous one', async () => {
      const current = await client.get('/api/v1/risk');
      const response = await client.put('/api/v1/risk', {
        ...current.body.data.policy,
        maxAmountPerTradeUsd: '999999',
      });

      expect(response.status).toBe(422);
      const reread = await client.get('/api/v1/risk');
      expect(reread.body.data.policy.maxAmountPerTradeUsd).toBe('25');
    });

    it('pauses and resumes', async () => {
      const paused = await client.post('/api/v1/control/pause', { reason: 'testing' });
      expect(paused.body.data.globalPause).toBe(true);

      const resumed = await client.post('/api/v1/control/resume');
      expect(resumed.body.data.globalPause).toBe(false);
    });

    it('engages the emergency stop without a model or a network call', async () => {
      const response = await client.post('/api/v1/control/emergency-stop', {
        reason: 'operator pulled the plug',
      });

      expect(response.status).toBe(200);
      expect(response.body.data.emergencyStop).toBe(true);
      expect(response.body.data.mode).toBe('PAPER');
    });

    it('refuses to resume while the emergency stop is engaged', async () => {
      await client.post('/api/v1/control/emergency-stop', { reason: 'halt' });
      const response = await client.post('/api/v1/control/resume');
      expect(response.status).toBe(409);
    });

    it('will not switch to LIVE with an incomplete checklist', async () => {
      const reauth = await client.post('/api/v1/auth/reauth', {
        password: PASSWORD,
        purpose: 'mode.live',
      });
      client.setReauth(reauth.body.data.token);

      const response = await client.post('/api/v1/control/mode/live', undefined, { reauth: true });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('LIVE_ACTIVATION_INCOMPLETE');
    });

    it('switches to LIVE only after every step and a re-authentication', async () => {
      for (const step of [
        'acknowledged',
        'reauthenticated',
        'riskReviewed',
        'walletFunded',
        'gasChecked',
        'adapterChecked',
      ]) {
        await client.post('/api/v1/control/activation/step', { step });
      }

      const reauth = await client.post('/api/v1/auth/reauth', {
        password: PASSWORD,
        purpose: 'mode.live',
      });
      client.setReauth(reauth.body.data.token);

      const response = await client.post('/api/v1/control/mode/live', undefined, { reauth: true });
      expect(response.status).toBe(200);
      expect(response.body.data.mode).toBe('LIVE');

      // And the emergency stop takes it straight back to PAPER.
      const stop = await client.post('/api/v1/control/emergency-stop', { reason: 'abort' });
      expect(stop.body.data.mode).toBe('PAPER');
    });

    it('will not switch to LIVE without a re-authentication token', async () => {
      const response = await client.post('/api/v1/control/mode/live');
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('REAUTH_REQUIRED');
    });

    it('records an audit trail of everything that happened', async () => {
      const response = await client.get('/api/v1/activity');
      const actions = response.body.data.map((event: { action: string }) => event.action);

      expect(actions).toContain('wallet.created');
      expect(actions).toContain('setup.completed');
      expect(actions).toContain('password.set');
    });

    it('never puts secret material in the audit trail', async () => {
      const response = await client.get('/api/v1/activity?limit=200');
      const serialized = JSON.stringify(response.body);

      expect(serialized).not.toMatch(/0x[0-9a-f]{64}/i);
      expect(serialized).not.toContain(PASSWORD);
    });
  });

  describe('wallet export', () => {
    beforeEach(async () => {
      await client.post('/api/v1/auth/setup', { password: PASSWORD });
      await client.post('/api/v1/setup/wallets');
      await client.post('/api/v1/setup/complete', {
        chains: ['base', 'solana'],
        paperAcknowledged: true,
      });
    });

    it('refuses without a re-authentication token', async () => {
      const response = await client.post('/api/v1/wallet/export', {
        format: 'evm-private-key',
        confirmation: 'EXPORT',
      });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('REAUTH_REQUIRED');
    });

    it('refuses when the password is wrong', async () => {
      const response = await client.post('/api/v1/auth/reauth', {
        password: 'definitely not the password',
        purpose: 'wallet.export',
      });
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('refuses without the typed confirmation', async () => {
      const reauth = await client.post('/api/v1/auth/reauth', {
        password: PASSWORD,
        purpose: 'wallet.export',
      });
      client.setReauth(reauth.body.data.token);

      const response = await client.post(
        '/api/v1/wallet/export',
        { format: 'evm-private-key' },
        { reauth: true },
      );
      expect(response.status).toBe(422);
    });

    it('exports an EVM private key after re-authentication, with a warning', async () => {
      const reauth = await client.post('/api/v1/auth/reauth', {
        password: PASSWORD,
        purpose: 'wallet.export',
      });
      client.setReauth(reauth.body.data.token);

      const response = await client.post(
        '/api/v1/wallet/export',
        { format: 'evm-private-key', confirmation: 'EXPORT' },
        { reauth: true },
      );

      expect(response.status).toBe(200);
      expect(response.body.data.material).toMatch(/^0x[0-9a-f]{64}$/);
      expect(response.body.data.warning).toContain('controls the wallet');
      expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('refuses to reuse a re-authentication token', async () => {
      const reauth = await client.post('/api/v1/auth/reauth', {
        password: PASSWORD,
        purpose: 'wallet.export',
      });
      client.setReauth(reauth.body.data.token);

      const first = await client.post(
        '/api/v1/wallet/export',
        { format: 'evm-private-key', confirmation: 'EXPORT' },
        { reauth: true },
      );
      expect(first.status).toBe(200);

      const second = await client.post(
        '/api/v1/wallet/export',
        { format: 'evm-private-key', confirmation: 'EXPORT' },
        { reauth: true },
      );
      expect(second.status).toBe(403);
      expect(second.body.code).toBe('REAUTH_INVALID');
    });

    it('refuses a token issued for a different purpose', async () => {
      const reauth = await client.post('/api/v1/auth/reauth', {
        password: PASSWORD,
        purpose: 'mode.live',
      });
      client.setReauth(reauth.body.data.token);

      const response = await client.post(
        '/api/v1/wallet/export',
        { format: 'evm-private-key', confirmation: 'EXPORT' },
        { reauth: true },
      );
      expect(response.status).toBe(403);
    });

    it('exports a Solana keypair in both documented formats', async () => {
      for (const format of ['solana-id-json', 'solana-base58']) {
        const reauth = await client.post('/api/v1/auth/reauth', {
          password: PASSWORD,
          purpose: 'wallet.export',
        });
        client.setReauth(reauth.body.data.token);

        const response = await client.post(
          '/api/v1/wallet/export',
          { format, confirmation: 'EXPORT' },
          { reauth: true },
        );
        expect(response.status).toBe(200);
      }
    });

    it('records the export in the audit trail without the key', async () => {
      const reauth = await client.post('/api/v1/auth/reauth', {
        password: PASSWORD,
        purpose: 'wallet.export',
      });
      client.setReauth(reauth.body.data.token);
      const exported = await client.post(
        '/api/v1/wallet/export',
        { format: 'evm-private-key', confirmation: 'EXPORT' },
        { reauth: true },
      );

      const activity = await client.get('/api/v1/activity?category=wallet');
      const event = activity.body.data.find(
        (e: { action: string }) => e.action === 'wallet.exported',
      );

      expect(event).toBeDefined();
      expect(JSON.stringify(event)).not.toContain(exported.body.data.material);
    });
  });

  describe('restart behaviour', () => {
    it('keeps configuration, wallets and the vault across a restart', async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        ATRA_MODE: 'ci',
        ATRA_LOG_LEVEL: 'silent',
        ATRA_DATA_DIR: './.test-data',
      });

      // A file-backed database so the second instance sees the first one's work.
      const file = `./.test-data/restart-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const first = buildServices(config, {
        databaseFile: file,
        adapters: new Map(),
        kdfParams: FAST_KDF,
      });
      const firstClient = new TestClient(createApp(first));

      await firstClient.post('/api/v1/auth/setup', { password: PASSWORD });
      await firstClient.post('/api/v1/setup/wallets');
      await firstClient.post('/api/v1/setup/complete', {
        chains: ['base'],
        paperAcknowledged: true,
      });
      await firstClient.post('/api/v1/control/emergency-stop', { reason: 'before restart' });

      const before = await firstClient.get('/api/v1/wallet');
      shutdownServices(first);

      const second = buildServices(config, {
        databaseFile: file,
        adapters: new Map(),
        kdfParams: FAST_KDF,
      });
      const secondClient = new TestClient(createApp(second));

      // A fresh process starts locked: the session cookie is gone and the vault
      // key was never persisted.
      const locked = await secondClient.get('/api/v1/wallet');
      expect(locked.status).toBe(401);

      await secondClient.post('/api/v1/auth/login', { password: PASSWORD });
      const after = await secondClient.get('/api/v1/wallet');

      expect(after.body.data.wallets).toEqual(before.body.data.wallets);
      expect(after.body.data.vaultUnlocked).toBe(true);

      // The emergency stop survived the restart.
      const status = await secondClient.get('/api/v1/status');
      expect(status.body.data.switches.emergencyStop).toBe(true);
      expect(status.body.data.runtime.status).toBe('stopped');

      shutdownServices(second);
    });

    it('rejects the wrong password after a restart', async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        ATRA_MODE: 'ci',
        ATRA_LOG_LEVEL: 'silent',
        ATRA_DATA_DIR: './.test-data',
      });
      const file = `./.test-data/restart-bad-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

      const first = buildServices(config, {
        databaseFile: file,
        adapters: new Map(),
        kdfParams: FAST_KDF,
      });
      const firstClient = new TestClient(createApp(first));
      await firstClient.post('/api/v1/auth/setup', { password: PASSWORD });
      await firstClient.post('/api/v1/setup/wallets');
      shutdownServices(first);

      const second = buildServices(config, {
        databaseFile: file,
        adapters: new Map(),
        kdfParams: FAST_KDF,
      });
      const secondClient = new TestClient(createApp(second));

      const login = await secondClient.post('/api/v1/auth/login', { password: 'wrong password!!' });
      expect(login.status).toBe(401);

      const wallet = await secondClient.get('/api/v1/wallet');
      expect(wallet.status).toBe(401);

      shutdownServices(second);
    });
  });
});

describe('Phase 3 routes', () => {
  let services: Services;
  let app: Hono<AppEnv>;
  let client: TestClient;

  beforeEach(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ATRA_MODE: 'ci',
      ATRA_LOG_LEVEL: 'silent',
      ATRA_DATA_DIR: './.test-data',
    });
    const adapters = new Map<ChainId, ChainAdapter>([
      ['base', stubAdapter('base')],
      ['bsc', stubAdapter('bsc')],
      ['robinhood', stubAdapter('robinhood')],
      ['solana', stubAdapter('solana')],
    ]);
    services = buildServices(config, { databaseFile: ':memory:', adapters, kdfParams: FAST_KDF });
    app = createApp(services);
    client = new TestClient(app);

    await client.post('/api/v1/auth/setup', { password: PASSWORD });
    await client.post('/api/v1/setup/wallets');
    await client.post('/api/v1/setup/complete', {
      chains: ['base', 'solana'],
      paperAcknowledged: true,
    });
  });

  afterEach(() => {
    shutdownServices(services);
  });

  it('reports the trading view with no positions, no decisions and no executable Robinhood Chain', async () => {
    const response = await client.get('/api/v1/trading');
    expect(response.status).toBe(200);
    expect(response.body.data.positions).toEqual([]);
    expect(response.body.data.decisions).toEqual([]);
    expect(response.body.data.status.enabled).toBe(false);
    expect(response.body.data.modelStatus).toBe('UNTRAINED');
    const robinhood = response.body.data.execution.find(
      (row: { chain: string }) => row.chain === 'robinhood',
    );
    expect(robinhood.executable).toBe(false);
    expect(robinhood.reason).toMatch(/no execution adapter/);
  });

  it('seeds and lists paper balances, refusing unknown tokens', async () => {
    const bad = await client.put('/api/v1/trading/paper-balances', {
      chain: 'base',
      token: '0x' + 'ab'.repeat(20),
      amount: '1000000',
    });
    expect(bad.status).toBe(422);

    const ok = await client.put('/api/v1/trading/paper-balances', {
      chain: 'base',
      token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      amount: '250000000',
    });
    expect(ok.status).toBe(200);

    const list = await client.get('/api/v1/trading/paper-balances');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].symbol).toBe('USDC');
    expect(list.body.data[0].formatted).toBe('250');
  });

  it('refuses to run a cycle while paused, and runs one (to no action) otherwise', async () => {
    await client.post('/api/v1/control/pause', { reason: 'test' });
    const paused = await client.post('/api/v1/trading/run', {
      chain: 'base',
      token: '0x4200000000000000000000000000000000000006',
    });
    expect(paused.status).toBe(409);

    await client.post('/api/v1/control/resume');
    const run = await client.post('/api/v1/trading/run', {
      chain: 'base',
      token: '0x4200000000000000000000000000000000000006',
    });
    expect(run.status).toBe(202);
    // CI mode: no market providers, no model, no execution adapter.
    expect(['no_action', 'skipped']).toContain(run.body.data.outcome);
    expect(run.body.data.execution).toBeNull();
  });

  it('configures the scheduler and refuses to enable it under emergency stop', async () => {
    const bad = await client.put('/api/v1/trading/scheduler', {
      enabled: true,
      intervalSeconds: 10,
    });
    expect(bad.status).toBe(422);

    const on = await client.put('/api/v1/trading/scheduler', {
      enabled: true,
      intervalSeconds: 300,
    });
    expect(on.status).toBe(200);
    expect(on.body.data.enabled).toBe(true);
    expect(on.body.data.nextRunAt).not.toBeNull();

    await client.post('/api/v1/control/emergency-stop', { reason: 'test' });
    const after = await client.get('/api/v1/trading/scheduler');
    expect(after.body.data.enabled).toBe(false);

    const blocked = await client.put('/api/v1/trading/scheduler', {
      enabled: true,
      intervalSeconds: 300,
    });
    expect(blocked.status).toBe(409);
  });

  it('validates withdrawal destinations and requires re-authentication to submit', async () => {
    const invalid = await client.post('/api/v1/wallet/withdraw/quote', {
      chainId: 'base',
      asset: 'USDC',
      destination: '0x0000000000000000000000000000000000000000',
      amount: '1',
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.errors[0].message).toBe('INVALID_ADDRESS');

    // The stub chain adapter cannot prepare transfers, so quoting is 503.
    const quote = await client.post('/api/v1/wallet/withdraw/quote', {
      chainId: 'base',
      asset: 'USDC',
      destination: '0x' + '11'.repeat(20),
      amount: '1',
    });
    expect(quote.status).toBe(503);
    expect(quote.body.code).toBe('ADAPTER_UNAVAILABLE');

    const submit = await client.post('/api/v1/wallet/withdraw', {
      quoteId: '00000000-0000-4000-8000-000000000000',
      ack: true,
    });
    expect(submit.status).toBe(403);
    expect(submit.body.code).toBe('REAUTH_REQUIRED');
  });

  it('mounts the liquidity and telegram routers on the app', async () => {
    // The routers are unit-tested on their own; this proves createApp wires
    // them, which a mounting mistake would otherwise hide until runtime.
    const liquidity = await client.get('/api/v1/liquidity');
    expect(liquidity.status).toBe(200);
    expect(liquidity.body.data.positions).toEqual([]);
    expect(liquidity.body.data.automation.enabled).toBe(false);

    const telegram = await client.get('/api/v1/telegram');
    expect(telegram.status).toBe(200);
    expect(telegram.body.data.configured).toBe(false);
    expect(telegram.body.data.paired).toBe(false);

    // Pairing is refused while no transport is configured, rather than
    // handing out a code that could never be redeemed.
    const pair = await client.post('/api/v1/telegram/pair', {});
    expect(pair.status).toBe(409);
  });

  it('lists withdrawals as an empty history before any are made', async () => {
    const response = await client.get('/api/v1/wallet/transactions');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
});
