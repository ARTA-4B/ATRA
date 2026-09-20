import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { GATEWAY_VERSION } from '../src/env.js';
import { TOKEN_RE } from '../src/tokens.js';
import { ADMIN_TOKEN, BASE, connectRuntime, stubTelegram } from './helpers.js';
import type { TelegramStub } from './helpers.js';

let telegram: TelegramStub;
beforeEach(() => {
  telegram = stubTelegram();
});
afterEach(() => {
  telegram.restore();
});

function parseMaybeJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { response, body: parseMaybeJson(text) };
}

describe('GET /health', () => {
  it('reports ok with the version', async () => {
    const { response, body } = await call('/health');
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', version: GATEWAY_VERSION, env: 'dev' });
  });

  it('answers unknown paths with 404 json', async () => {
    const { response, body } = await call('/nope');
    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
  });
});

describe('POST /v1/admin/installs', () => {
  it('requires the admin token', async () => {
    expect((await call('/v1/admin/installs', { method: 'POST' })).response.status).toBe(401);
    expect(
      (
        await call('/v1/admin/installs', {
          method: 'POST',
          headers: { authorization: 'Bearer wrong' },
        })
      ).response.status,
    ).toBe(401);
    expect(
      (
        await call('/v1/admin/installs', {
          method: 'POST',
          headers: { authorization: `Bearer ${ADMIN_TOKEN}x` },
        })
      ).response.status,
    ).toBe(401);
  });

  it('mints a token that can open the WebSocket', async () => {
    const { response, body } = await call('/v1/admin/installs', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(201);
    expect(body.token).toMatch(TOKEN_RE);
    expect(body.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.scopes).toEqual(['telegram', 'rpc', 'market']);
    expect(typeof body.expiresAt).toBe('number');

    // Only the HMAC is stored.
    const row = await env.DB.prepare(
      'SELECT token_hash, scopes FROM install_tokens WHERE install_id = ?',
    )
      .bind(body.installId)
      .first<{ token_hash: string; scopes: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toContain(body.token);
    expect(row?.scopes).toBe('["telegram","rpc","market"]');

    const runtime = await connectRuntime(body.token, body.installId);
    const welcome = await runtime.hello();
    expect(welcome.type).toBe('welcome');
    await runtime.close();
  });

  it('accepts an explicit installId and ttl, and rejects junk', async () => {
    const ok = await call('/v1/admin/installs', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ installId: 'my-lab-runtime-01', ttlDays: null }),
    });
    expect(ok.response.status).toBe(201);
    expect(ok.body.installId).toBe('my-lab-runtime-01');
    expect(ok.body.expiresAt).toBeNull();

    const bad = await call('/v1/admin/installs', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ installId: 'x', scopes: ['wallet'] }),
    });
    expect(bad.response.status).toBe(422);

    const notJson = await call('/v1/admin/installs', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: '{nope',
    });
    expect(notJson.response.status).toBe(400);
  });
});
