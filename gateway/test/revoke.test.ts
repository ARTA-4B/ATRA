import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOSE_REVOKED } from '../src/hub.js';
import { UPSTREAMS } from '../src/rpc.js';
import {
  adminCall,
  call,
  connectRuntime,
  jsonResponse,
  linkRow,
  mintToken,
  openSocket,
  pairRuntime,
  postJson,
  stubTelegram,
  stubUpstreams,
  wsRequest,
} from './helpers.js';
import type { TelegramStub, UpstreamStub } from './helpers.js';

let telegram: TelegramStub | null = null;
let upstream: UpstreamStub | null = null;
afterEach(() => {
  telegram?.restore();
  telegram = null;
  upstream?.restore();
  upstream = null;
});

const blockNumber = { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 };

describe('admin authentication', () => {
  it('every admin endpoint needs the admin token', async () => {
    const paths: Array<[string, string]> = [
      ['GET', '/v1/admin/installs'],
      ['POST', '/v1/admin/installs'],
      ['POST', '/v1/admin/installs/some-install-id/revoke'],
      ['DELETE', '/v1/admin/installs/some-install-id'],
      ['GET', '/v1/admin/usage'],
    ];
    for (const [method, path] of paths) {
      const none = await call(path, { method });
      expect(none.response.status, `${method} ${path} without token`).toBe(401);
      const wrong = await call(path, { method, token: 'not-the-admin-token' });
      expect(wrong.response.status, `${method} ${path} wrong token`).toBe(401);
      // An installation token is not an admin token.
      const install = await mintToken();
      const runtime = await call(path, { method, token: install.token });
      expect(runtime.response.status, `${method} ${path} install token`).toBe(401);
    }
    const unconfigured = { ...env, ADMIN_TOKEN: undefined } as unknown as typeof env;
    const off = await call('/v1/admin/usage', { method: 'GET', env: unconfigured });
    expect(off.response.status).toBe(503);
    expect(off.body.code).toBe('not_configured');
  });
});

describe('GET /v1/admin/installs', () => {
  it('lists installations with scopes, pairing, online state and usage', async () => {
    telegram = stubTelegram();
    const minted = await mintToken({ installId: 'listed-install-01', scopes: ['telegram', 'rpc'] });
    const runtime = await connectRuntime(minted.token, minted.installId);
    await runtime.hello();
    await pairRuntime(runtime, telegram, { userId: 700_000_001, username: 'dana' });

    const { response, body } = await adminCall('/v1/admin/installs');
    expect(response.status).toBe(200);
    expect(typeof body.day).toBe('string');
    expect(body.limits).toMatchObject({ rpc: 5000, market: 2000, inference: 200, ws: 500 });
    const row = body.installs.find((i: any) => i.installId === 'listed-install-01');
    expect(row).toMatchObject({
      installId: 'listed-install-01',
      scopes: ['telegram', 'rpc'],
      tokens: { total: 1, active: 1 },
      revoked: false,
      paired: true,
      online: true,
    });
    expect(row.usage.ws.used).toBe(1);
    expect(typeof row.expiresAt).toBe('number');
    // No token material in the listing.
    expect(JSON.stringify(body)).not.toContain(minted.token);
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}/);
    await runtime.close();
  });
});

describe('revocation', () => {
  let telegramUser = 710_000_000;
  beforeEach(() => {
    telegramUser += 1;
  });

  it('closes the open socket, refuses the next connect and the next proxied call', async () => {
    telegram = stubTelegram();
    const minted = await mintToken({ installId: 'revoked-install-01' });
    const runtime = await connectRuntime(minted.token, minted.installId);
    await runtime.hello();

    const { response, body } = await adminCall('/v1/admin/installs/revoked-install-01/revoke', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      installId: 'revoked-install-01',
      revokedTokens: 1,
      closedSockets: 1,
      unlinked: false,
    });
    expect(typeof body.revokedAt).toBe('number');
    expect(body.note).toContain('Rotation is not implemented');

    const closed = await runtime.closed;
    expect(closed.code).toBe(CLOSE_REVOKED);

    // The token is dead everywhere.
    expect((await openSocket(wsRequest(minted.token))).status).toBe(401);
    telegram.restore();
    telegram = null;
    upstream = stubUpstreams({
      [UPSTREAMS.base.publicUrl]: () => jsonResponse({ jsonrpc: '2.0', id: 0, result: '0x1' }),
    });
    const proxied = await postJson('/v1/rpc/base', minted.token, blockNumber);
    expect(proxied.response.status).toBe(401);
    expect(proxied.body.detail).toContain('revoked');
    expect(upstream.calls).toHaveLength(0);

    // Revoking again is idempotent; the row is still known.
    const again = await adminCall('/v1/admin/installs/revoked-install-01/revoke', {
      method: 'POST',
    });
    expect(again.response.status).toBe(200);
    expect(again.body).toMatchObject({ revokedTokens: 0, closedSockets: 0 });

    // The listing shows it as revoked.
    const listing = await adminCall('/v1/admin/installs');
    const row = listing.body.installs.find((i: any) => i.installId === 'revoked-install-01');
    expect(row).toMatchObject({
      revoked: true,
      tokens: { total: 1, active: 0 },
      scopes: [],
      online: false,
    });
  });

  it('revokes every token of the installation, and a fresh mint works again', async () => {
    const first = await mintToken({ installId: 'multi-token-install' });
    const second = await mintToken({ installId: 'multi-token-install' });
    const { body } = await adminCall('/v1/admin/installs/multi-token-install/revoke', {
      method: 'POST',
    });
    expect(body.revokedTokens).toBe(2);
    expect((await openSocket(wsRequest(first.token))).status).toBe(401);
    expect((await openSocket(wsRequest(second.token))).status).toBe(401);

    const reminted = await adminCall('/v1/admin/installs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installId: 'multi-token-install' }),
    });
    expect(reminted.response.status).toBe(201);
    expect((await openSocket(wsRequest(reminted.body.token))).status).toBe(101);
  });

  it('DELETE also drops the Telegram link', async () => {
    telegram = stubTelegram();
    const minted = await mintToken({ installId: 'deleted-install-01' });
    const runtime = await connectRuntime(minted.token, minted.installId);
    await runtime.hello();
    await pairRuntime(runtime, telegram, { userId: telegramUser });
    expect(await linkRow('deleted-install-01')).not.toBeNull();

    const { response, body } = await adminCall('/v1/admin/installs/deleted-install-01', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ revokedTokens: 1, closedSockets: 1, unlinked: true });
    expect(await linkRow('deleted-install-01')).toBeNull();
    expect((await runtime.closed).code).toBe(CLOSE_REVOKED);
  });

  it('answers 404 for an unknown installation and 400 for a malformed id', async () => {
    const unknown = await adminCall('/v1/admin/installs/never-minted-0001/revoke', {
      method: 'POST',
    });
    expect(unknown.response.status).toBe(404);
    expect(unknown.body.code).toBe('unknown_install');
    const malformed = await adminCall('/v1/admin/installs/x/revoke', { method: 'POST' });
    expect(malformed.response.status).toBe(400);
    expect(malformed.body.code).toBe('invalid_install_id');
  });
});

describe('GET /v1/admin/usage', () => {
  it('summarises a day and validates the day parameter', async () => {
    const today = await adminCall('/v1/admin/usage');
    expect(today.response.status).toBe(200);
    expect(today.body).toMatchObject({ limits: { rpc: 5000 } });
    expect(today.body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(today.body.resetAt).toBe(
      new Date(Date.parse(`${today.body.day}T00:00:00Z`) + 24 * 60 * 60_000).toISOString(),
    );
    expect(Array.isArray(today.body.installs)).toBe(true);
    expect(typeof today.body.openSockets).toBe('number');
    expect(today.body.totals).toMatchObject({ rpc: {}, market: {}, inference: {}, ws: {} });

    const past = await adminCall('/v1/admin/usage?day=2020-01-01');
    expect(past.response.status).toBe(200);
    expect(past.body).toMatchObject({ day: '2020-01-01', installs: [] });

    const bad = await adminCall('/v1/admin/usage?day=yesterday');
    expect(bad.response.status).toBe(400);
    expect(bad.body.code).toBe('invalid_day');
  });
});
