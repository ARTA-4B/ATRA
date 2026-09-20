import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_TTL_SECONDS,
  EVM_READ_METHODS,
  MAX_BATCH,
  MAX_UPSTREAM_BODY_BYTES,
  REFUSED_METHODS,
  SOLANA_READ_METHODS,
  UPSTREAMS,
  checkMethod,
  scrubUpstream,
} from '../src/rpc.js';
import { jsonResponse, mintToken, postJson, stubUpstreams } from './helpers.js';
import type { UpstreamStub } from './helpers.js';

const BASE_RPC = UPSTREAMS.base.publicUrl;
const SOLANA_RPC = UPSTREAMS.solana.publicUrl;

/** A well-behaved EVM upstream: answers every request by id with a fixed result. */
function evmUpstream(result: unknown = '0x1'): UpstreamStub {
  return stubUpstreams({
    [BASE_RPC]: ({ body }) => {
      const answer = (r: any) => ({ jsonrpc: '2.0', id: r.id, result });
      return jsonResponse(Array.isArray(body) ? body.map(answer) : answer(body));
    },
    [SOLANA_RPC]: ({ body }) =>
      jsonResponse({ jsonrpc: '2.0', id: body.id, result: { value: 42 } }),
  });
}

let upstream: UpstreamStub | null = null;
afterEach(() => {
  upstream?.restore();
  upstream = null;
});

const rpc = (method: string, params: unknown[] = [], id: unknown = 1) => ({
  jsonrpc: '2.0',
  method,
  params,
  id,
});

describe('method allowlist', () => {
  it('accepts every listed read and refuses everything that writes or signs', () => {
    for (const method of EVM_READ_METHODS)
      expect(checkMethod('base', method)).toEqual({ ok: true });
    for (const method of SOLANA_READ_METHODS)
      expect(checkMethod('solana', method)).toEqual({ ok: true });
    for (const method of REFUSED_METHODS) {
      expect(checkMethod('base', method)).toMatchObject({ ok: false, reason: 'refused' });
      expect(checkMethod('solana', method)).toMatchObject({ ok: false, reason: 'refused' });
    }
    // A Solana read is not an EVM read and vice versa.
    expect(checkMethod('base', 'getBalance')).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(checkMethod('solana', 'eth_call')).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(checkMethod('bsc', 'debug_traceTransaction')).toMatchObject({ ok: false });
  });

  it('never caches nonce, receipt, estimate, signature status or simulation', () => {
    for (const method of [
      'eth_getTransactionCount',
      'eth_getTransactionReceipt',
      'eth_estimateGas',
      'getSignatureStatuses',
      'simulateTransaction',
    ]) {
      expect(CACHE_TTL_SECONDS[method]).toBeUndefined();
    }
    for (const ttl of Object.values(CACHE_TTL_SECONDS)) {
      expect(ttl).toBeGreaterThanOrEqual(5);
      expect(ttl).toBeLessThanOrEqual(30);
    }
  });
});

describe('POST /v1/rpc/{chain}', () => {
  let token: string;
  let installId: string;
  beforeEach(async () => {
    const minted = await mintToken();
    token = minted.token;
    installId = minted.installId;
  });

  it('requires an installation token with the rpc scope', async () => {
    upstream = evmUpstream();
    const anon = await postJson('/v1/rpc/base', null, rpc('eth_blockNumber'));
    expect(anon.response.status).toBe(401);
    expect(anon.response.headers.get('content-type')).toContain('application/problem+json');
    expect(anon.body.code).toBe('unauthorized');

    const telegramOnly = await mintToken({ scopes: ['telegram'] });
    const scoped = await postJson('/v1/rpc/base', telegramOnly.token, rpc('eth_blockNumber'));
    expect(scoped.response.status).toBe(403);
    expect(scoped.body).toMatchObject({ code: 'scope_missing', scope: 'rpc' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('proxies an allowed read to the hard-coded upstream and keeps the client id', async () => {
    upstream = evmUpstream('0xabc');
    const { response, body } = await postJson(
      '/v1/rpc/base',
      token,
      rpc('eth_blockNumber', [], 'req-7'),
    );
    expect(response.status).toBe(200);
    expect(body).toEqual({ jsonrpc: '2.0', id: 'req-7', result: '0xabc' });
    expect(response.headers.get('x-atra-cache')).toBe('miss');
    expect(response.headers.get('x-ratelimit-limit')).toBe('5000');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('4999');
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe(new URL(BASE_RPC).href);
    // Renumbered for the upstream; the client id never travels.
    expect(upstream.calls[0]!.body).toEqual({
      jsonrpc: '2.0',
      id: 0,
      method: 'eth_blockNumber',
      params: [],
    });
    expect(installId).toBeTruthy();
  });

  it('refuses eth_sendRawTransaction with a clear error and never calls upstream', async () => {
    upstream = evmUpstream();
    const { response, body } = await postJson(
      '/v1/rpc/base',
      token,
      rpc('eth_sendRawTransaction', ['0xdead']),
    );
    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      code: 'method_refused',
      method: 'eth_sendRawTransaction',
      chain: 'base',
    });
    expect(body.detail).toContain('never broadcasts');
    expect(upstream.calls).toHaveLength(0);

    const sol = await postJson('/v1/rpc/solana', token, rpc('sendTransaction', ['AAAA']));
    expect(sol.response.status).toBe(403);
    expect(sol.body).toMatchObject({ code: 'method_refused', method: 'sendTransaction' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('refuses a batch that hides a write among reads, and an unlisted method', async () => {
    upstream = evmUpstream();
    const mixed = await postJson('/v1/rpc/base', token, [
      rpc('eth_blockNumber', [], 1),
      rpc('eth_sendTransaction', [{}], 2),
    ]);
    expect(mixed.response.status).toBe(403);
    expect(mixed.body.code).toBe('method_refused');

    const unlisted = await postJson('/v1/rpc/bsc', token, rpc('debug_traceCall'));
    expect(unlisted.response.status).toBe(403);
    expect(unlisted.body).toMatchObject({ code: 'method_not_allowed', method: 'debug_traceCall' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('forwards a batch of up to 20 as one upstream request and refuses 21', async () => {
    upstream = evmUpstream('0x5');
    const batch = Array.from({ length: MAX_BATCH }, (_, i) => rpc('eth_gasPrice', [], `c${i}`));
    const ok = await postJson('/v1/rpc/base', token, batch);
    expect(ok.response.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect(ok.body).toHaveLength(MAX_BATCH);
    expect(ok.body[3]).toEqual({ jsonrpc: '2.0', id: 'c3', result: '0x5' });
    expect(ok.response.headers.get('x-atra-cache')).toBe('bypass');
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toHaveLength(MAX_BATCH);

    const tooMany = await postJson('/v1/rpc/base', token, [...batch, rpc('eth_gasPrice')]);
    expect(tooMany.response.status).toBe(400);
    expect(tooMany.body).toMatchObject({ code: 'batch_too_large', max: 20, received: 21 });
    expect(upstream.calls).toHaveLength(1);
  });

  it('rejects non-JSON, an empty batch, a malformed request and an unknown chain', async () => {
    upstream = evmUpstream();
    expect((await postJson('/v1/rpc/base', token, '{nope')).body.code).toBe('not_json');
    expect((await postJson('/v1/rpc/base', token, [])).body.code).toBe('empty_batch');
    const bad = await postJson('/v1/rpc/base', token, { jsonrpc: '1.0', method: 'eth_call' });
    expect(bad.response.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'invalid_request', index: 0 });
    const chain = await postJson('/v1/rpc/ethereum', token, rpc('eth_blockNumber'));
    expect(chain.response.status).toBe(404);
    expect(chain.body.code).toBe('unknown_chain');
    expect(upstream.calls).toHaveLength(0);
  });

  it('serves a repeated idempotent read from the cache and does not cache a nonce', async () => {
    upstream = evmUpstream('0x10');
    const params = ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'latest'];
    const first = await postJson('/v1/rpc/base', token, rpc('eth_getBalance', params, 1));
    expect(first.response.headers.get('x-atra-cache')).toBe('miss');
    const second = await postJson('/v1/rpc/base', token, rpc('eth_getBalance', params, 2));
    expect(second.response.status).toBe(200);
    expect(second.response.headers.get('x-atra-cache')).toBe('hit');
    expect(second.body).toEqual({ jsonrpc: '2.0', id: 2, result: '0x10' });
    expect(upstream.callsTo(BASE_RPC)).toHaveLength(1);

    // Different params, different entry.
    const other = await postJson(
      '/v1/rpc/base',
      token,
      rpc('eth_getBalance', [params[0], '0x1'], 3),
    );
    expect(other.response.headers.get('x-atra-cache')).toBe('miss');
    expect(upstream.callsTo(BASE_RPC)).toHaveLength(2);

    // The nonce always goes upstream.
    await postJson('/v1/rpc/base', token, rpc('eth_getTransactionCount', params, 4));
    const nonce = await postJson('/v1/rpc/base', token, rpc('eth_getTransactionCount', params, 5));
    expect(nonce.response.headers.get('x-atra-cache')).toBe('bypass');
    expect(upstream.callsTo(BASE_RPC)).toHaveLength(4);

    // Cached reads still count against the quota.
    expect(nonce.response.headers.get('x-ratelimit-remaining')).toBe(String(5000 - 5));
  });

  it('uses the keyed secret when set and never echoes it, even when the upstream does', async () => {
    const keyed = 'https://keyed.example/v2/SECRETKEY0123456789';
    upstream = stubUpstreams({
      [keyed]: () =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: -32000,
            message: `bad request to ${keyed}: key SECRETKEY0123456789 rejected`,
          },
        }),
      [BASE_RPC]: () => {
        throw new Error('public endpoint must not be used when the secret is set');
      },
    });
    const withSecret = { ...env, RPC_URL_BASE: keyed } as typeof env;
    const { response, body } = await postJson('/v1/rpc/base', token, rpc('eth_chainId'), {
      env: withSecret,
    });
    expect(response.status).toBe(200);
    expect(upstream.calls[0]!.url).toBe(keyed);
    const text = JSON.stringify(body);
    expect(text).not.toContain('SECRETKEY');
    expect(text).not.toContain('keyed.example');
    expect(body.error.message).toContain('[upstream]');
    expect(body.error.message).toContain('[redacted]');
  });

  it('answers 502/503 problems for a failing upstream without naming it', async () => {
    upstream = stubUpstreams({
      [BASE_RPC]: () => new Response('nope', { status: 500 }),
      [SOLANA_RPC]: () =>
        new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
    });
    const http = await postJson(
      '/v1/rpc/base',
      token,
      rpc('eth_feeHistory', ['0x4', 'latest', []]),
    );
    expect(http.response.status).toBe(502);
    expect(http.body).toMatchObject({ code: 'upstream_error', upstreamStatus: 500, chain: 'base' });
    expect(JSON.stringify(http.body)).not.toContain('mainnet.base.org');

    const busy = await postJson('/v1/rpc/solana', token, rpc('getSlot'));
    expect(busy.response.status).toBe(503);
    expect(busy.response.headers.get('retry-after')).toBe('7');
    expect(busy.body).toMatchObject({ code: 'upstream_rate_limited', retryAfterSeconds: 7 });
  });

  it('is burst limited by RL_PROXY when the binding is present', async () => {
    upstream = evmUpstream();
    const limited = {
      ...env,
      RL_PROXY: { limit: () => Promise.resolve({ success: false }) },
    } as typeof env;
    const { response, body } = await postJson('/v1/rpc/base', token, rpc('eth_blockNumber'), {
      env: limited,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('10');
    expect(body.code).toBe('rate_limited');
    expect(upstream.calls).toHaveLength(0);
  });

  it('writes one Analytics Engine point per request when the binding exists', async () => {
    upstream = evmUpstream();
    const points: any[] = [];
    const metered = {
      ...env,
      AE: { writeDataPoint: (p: unknown) => points.push(p) },
    } as typeof env;
    // eth_call with fresh params: the Cache API is shared across the tests in
    // this file, and a hit would be reported as such.
    const call = rpc('eth_call', [
      { to: '0x4200000000000000000000000000000000000006', data: '0x06fdde03' },
      'latest',
    ]);
    await postJson('/v1/rpc/base', token, call, { env: metered });
    await postJson('/v1/rpc/base', token, rpc('eth_sendRawTransaction', ['0x']), { env: metered });
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      indexes: [installId],
      blobs: ['rpc', 'base', 'ok', 'miss', 'dev'],
      doubles: [1],
    });
    expect(points[1].blobs).toEqual(['rpc', 'base', 'refused', 'miss', 'dev']);
    // No bodies, no params, no tokens.
    expect(JSON.stringify(points)).not.toContain(token);
  });

  it('refuses signing, broadcasting and wallet methods, and case variants of them', async () => {
    upstream = evmUpstream();
    // The refusal list is matched exactly, so a case variant is not refused by
    // name; it is not on the read allowlist either, which is what rejects it.
    const cases = [
      { chain: 'base', method: 'eth_sign', code: 'method_refused' },
      { chain: 'base', method: 'personal_sign', code: 'method_refused' },
      { chain: 'base', method: 'eth_signTypedData_v4', code: 'method_refused' },
      { chain: 'solana', method: 'sendTransaction', code: 'method_refused' },
      { chain: 'base', method: 'ETH_SENDRAWTRANSACTION', code: 'method_not_allowed' },
      { chain: 'base', method: 'Eth_SendRawTransaction', code: 'method_not_allowed' },
      { chain: 'base', method: 'wallet_sendCalls', code: 'method_not_allowed' },
      { chain: 'base', method: 'wallet_requestPermissions', code: 'method_not_allowed' },
      { chain: 'solana', method: 'signTransaction', code: 'method_not_allowed' },
      { chain: 'solana', method: 'signAllTransactions', code: 'method_not_allowed' },
    ];
    for (const { chain, method, code } of cases) {
      const { response, body } = await postJson(`/v1/rpc/${chain}`, token, rpc(method));
      expect(response.status, method).toBe(403);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(body).toMatchObject({ code, method, chain });
    }
    expect(upstream.calls).toHaveLength(0);
  });

  it('refuses a nested array and a non-object item inside a batch', async () => {
    upstream = evmUpstream();
    const nested = await postJson('/v1/rpc/base', token, [
      rpc('eth_blockNumber', [], 1),
      [rpc('eth_call', [], 2)],
    ]);
    expect(nested.response.status).toBe(400);
    expect(nested.body).toMatchObject({ code: 'invalid_request', index: 1 });

    for (const item of ['eth_blockNumber', 7, null, true]) {
      const { response, body } = await postJson('/v1/rpc/base', token, [item]);
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ code: 'invalid_request', index: 0 });
    }
    expect(upstream.calls).toHaveLength(0);
  });

  it('refuses an upstream that declares a body over the cap, without parsing it', async () => {
    // A cap that drifts upward is a cap that no longer protects the isolate's
    // memory, so the bound itself is pinned and not only the behaviour.
    expect(MAX_UPSTREAM_BODY_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024);
    // A valid, small reply behind a lying Content-Length: a 200 here would
    // mean the header was ignored and the body parsed anyway.
    upstream = stubUpstreams({
      [BASE_RPC]: () =>
        jsonResponse({ jsonrpc: '2.0', id: 0, result: '0x1' }, 200, {
          'content-length': String(MAX_UPSTREAM_BODY_BYTES + 1),
        }),
    });
    const { response, body } = await postJson(
      '/v1/rpc/base',
      token,
      rpc('eth_getTransactionCount', ['0xabc', 'latest']),
    );
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(body).toMatchObject({
      code: 'upstream_too_large',
      chain: 'base',
      maxBytes: MAX_UPSTREAM_BODY_BYTES,
    });
    expect(JSON.stringify(body)).not.toContain('mainnet.base.org');
  });

  it('stops reading a streamed upstream body at the cap and cancels it', async () => {
    let pulls = 0;
    let cancelled = false;
    // No Content-Length: the byte count, not the header, is what bounds this.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 8) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    upstream = stubUpstreams({
      [BASE_RPC]: () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
    });
    const { response, body } = await postJson(
      '/v1/rpc/base',
      token,
      rpc('eth_getTransactionCount', ['0xdef', 'latest']),
    );
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: 'upstream_too_large', maxBytes: MAX_UPSTREAM_BODY_BYTES });
    expect(cancelled).toBe(true);
    // Three megabytes read, not the whole stream.
    expect(pulls).toBeLessThanOrEqual(4);
  });
});

describe('scrubUpstream', () => {
  it('removes the URL, a long path tail and long query values', () => {
    const url = 'https://rpc.example/v1/abcdefghijklmnopqrstuvwxyz?key=0123456789abcdef0123';
    const out = scrubUpstream(`x ${url} y abcdefghijklmnopqrstuvwxyz z 0123456789abcdef0123`, url);
    expect(out).toBe('x [upstream] y [redacted] z [redacted]');
  });
});
