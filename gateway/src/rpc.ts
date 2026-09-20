/**
 * POST /v1/rpc/{chain}: a read-only JSON-RPC proxy.
 *
 * What it is for: a runtime that has no keyed RPC provider of its own can
 * read balances, gas, receipts and logs through the project's keyed upstream
 * without ever seeing the key. What it is not: a way to broadcast. A gateway
 * that can broadcast is a gateway that can be made to broadcast, so the
 * write methods are refused by name with a clear error, every other method
 * must be on the per-chain read allowlist, and the upstream URL comes from a
 * hard-coded map plus a secret, never from the request.
 *
 * Reads that are safe to repeat are cached in the Cache API for 5-30 s by
 * method (single requests only: a batch of 20 would cost 40 cache
 * subrequests against a budget of 25). Nonces, receipts, estimates,
 * signature statuses and simulations are never cached: a stale nonce makes
 * the runtime's own broadcast fail and a stale receipt delays confirmation.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { requireInstall } from './auth.js';
import { rpcStore } from './cache.js';
import type { AppEnv } from './context.js';
import { sha256Hex } from './crypto.js';
import { GATEWAY_VERSION, isChainId } from './env.js';
import type { ChainId, Env } from './env.js';
import { logger } from './log.js';
import { badGateway, badRequest, forbidden, notFound, upstreamBusy } from './problem.js';
import { guardProxy, readJson } from './proxy.js';
import { quotaHeaders } from './quota.js';
import { recordUsage } from './usage.js';
import type { UsageOutcome } from './usage.js';

const log = logger('rpc');

export const MAX_BATCH = 20;
export const UPSTREAM_TIMEOUT_MS = 10_000;
/**
 * Largest upstream body that is parsed. A batch of 20 eth_getLogs answers
 * fits in a fraction of this; anything bigger is a misbehaving provider or
 * an attempt to make the Worker allocate until it is killed.
 */
export const MAX_UPSTREAM_BODY_BYTES = 2 * 1024 * 1024;
/** Sent on every upstream call; some public RPCs answer 403 to a request with no User-Agent. */
export const USER_AGENT = `atra-gateway/${GATEWAY_VERSION}`;

type Family = 'evm' | 'solana';

interface Upstream {
  family: Family;
  /** Keyless public endpoint, used when the secret is unset. Same as the runtime's registry. */
  publicUrl: string;
  /** The secret holding a keyed URL for this chain. */
  secret: 'RPC_URL_BASE' | 'RPC_URL_BSC' | 'RPC_URL_ROBINHOOD' | 'RPC_URL_SOLANA';
}

/** Hard-coded on purpose: nothing in a request can choose where it goes. */
export const UPSTREAMS: Record<ChainId, Upstream> = {
  base: { family: 'evm', publicUrl: 'https://mainnet.base.org', secret: 'RPC_URL_BASE' },
  bsc: { family: 'evm', publicUrl: 'https://bsc-dataseed.bnbchain.org', secret: 'RPC_URL_BSC' },
  robinhood: {
    family: 'evm',
    publicUrl: 'https://rpc.mainnet.chain.robinhood.com',
    secret: 'RPC_URL_ROBINHOOD',
  },
  solana: {
    family: 'solana',
    publicUrl: 'https://api.mainnet-beta.solana.com',
    secret: 'RPC_URL_SOLANA',
  },
};

export const EVM_READ_METHODS: ReadonlySet<string> = new Set([
  'eth_call',
  'eth_getBalance',
  'eth_blockNumber',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_estimateGas',
  'eth_getLogs',
  'eth_chainId',
  'net_version',
]);

export const SOLANA_READ_METHODS: ReadonlySet<string> = new Set([
  'getBalance',
  'getAccountInfo',
  'getTokenAccountsByOwner',
  'getLatestBlockhash',
  'getSignatureStatuses',
  'getTransaction',
  'getSlot',
  'getGenesisHash',
  'getMinimumBalanceForRentExemption',
  'simulateTransaction',
]);

/**
 * Refused by name, with their own error, whatever chain they arrive on.
 * Anything that broadcasts, signs or moves funds. The allowlist alone would
 * reject them too; naming them makes the refusal legible in a log.
 */
export const REFUSED_METHODS: ReadonlySet<string> = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_sendPrivateTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'personal_sign',
  'sendTransaction',
  'sendRawTransaction',
  'requestAirdrop',
]);

/** Cache TTL in seconds by method. Absent means never cached. */
export const CACHE_TTL_SECONDS: Readonly<Record<string, number>> = {
  eth_chainId: 30,
  net_version: 30,
  getGenesisHash: 30,
  getMinimumBalanceForRentExemption: 30,
  eth_gasPrice: 10,
  eth_feeHistory: 10,
  eth_getLogs: 10,
  getTransaction: 10,
  eth_blockNumber: 5,
  eth_call: 5,
  eth_getBalance: 5,
  getBalance: 5,
  getAccountInfo: 5,
  getTokenAccountsByOwner: 5,
  getSlot: 5,
  getLatestBlockhash: 5,
};

const rpcIdSchema = z.union([z.string().max(128), z.number(), z.null()]);

const rpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1).max(64),
  params: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
  id: rpcIdSchema.optional(),
});

type RpcRequest = z.infer<typeof rpcRequestSchema>;
type RpcId = z.infer<typeof rpcIdSchema>;

export type MethodVerdict =
  { ok: true } | { ok: false; reason: 'refused' | 'not_allowed'; method: string };

/** The allowlist decision for one method on one chain. */
export function checkMethod(chain: ChainId, method: string): MethodVerdict {
  if (REFUSED_METHODS.has(method)) return { ok: false, reason: 'refused', method };
  const allowed = UPSTREAMS[chain].family === 'evm' ? EVM_READ_METHODS : SOLANA_READ_METHODS;
  return allowed.has(method) ? { ok: true } : { ok: false, reason: 'not_allowed', method };
}

/**
 * The upstream for a chain. A malformed secret (not an http(s) URL) falls
 * back to the public endpoint with a warning that names the secret, never
 * its value.
 */
export function upstreamUrl(env: Env, chain: ChainId): { url: string; keyed: boolean } {
  const spec = UPSTREAMS[chain];
  const configured = env[spec.secret];
  if (typeof configured === 'string' && configured.trim().length > 0) {
    try {
      const parsed = new URL(configured.trim());
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return { url: parsed.href, keyed: true };
      }
    } catch {
      // fall through
    }
    log.warn('rpc secret is not a valid URL; using the public endpoint', { secret: spec.secret });
  }
  return { url: spec.publicUrl, keyed: false };
}

/**
 * Remove a keyed upstream URL, and the key-looking tail of its path, from
 * any text that is about to leave the gateway. Providers do not normally
 * echo their own URL, but "normally" is not a guarantee.
 */
export function scrubUpstream(text: string, url: string): string {
  let out = text.split(url).join('[upstream]');
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split('/').filter(Boolean).at(-1);
    if (tail && tail.length >= 16) out = out.split(tail).join('[redacted]');
    for (const value of parsed.searchParams.values()) {
      if (value.length >= 16) out = out.split(value).join('[redacted]');
    }
  } catch {
    // unparsable: the plain replacement above is all that can be done
  }
  return out;
}

async function cacheKey(chain: ChainId, request: RpcRequest): Promise<string> {
  return sha256Hex(`${chain}:${request.method}:${JSON.stringify(request.params ?? [])}`);
}

type UpstreamResult =
  | { ok: true; body: unknown }
  | { ok: false; kind: 'rate_limited'; retryAfter: number }
  | { ok: false; kind: 'http'; status: number }
  | { ok: false; kind: 'unreachable' }
  | { ok: false; kind: 'not_json' }
  | { ok: false; kind: 'too_large' };

/**
 * Read a body as text, giving up (and cancelling the stream) as soon as more
 * than `limit` bytes have arrived. Null means too large. Content-Length is
 * only a hint: a chunked or lying upstream is bounded by the count, not the
 * header.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | null> {
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function callUpstream(url: string, payload: unknown): Promise<UpstreamResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    // Not logged with the error text: a network error can carry the URL.
    return { ok: false, kind: 'unreachable' };
  }
  if (response.status === 429) {
    const header = Number(response.headers.get('retry-after') ?? '10');
    return { ok: false, kind: 'rate_limited', retryAfter: Number.isFinite(header) ? header : 10 };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, kind: 'http', status: response.status };
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BODY_BYTES) {
    await response.body?.cancel();
    return { ok: false, kind: 'too_large' };
  }
  let text: string | null;
  try {
    text = await readBounded(response.body, MAX_UPSTREAM_BODY_BYTES);
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
  if (text === null) return { ok: false, kind: 'too_large' };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, kind: 'not_json' };
  }
}

interface UpstreamReply {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function asReplies(body: unknown): UpstreamReply[] {
  const list = Array.isArray(body) ? body : [body];
  return list.filter((r): r is UpstreamReply => r !== null && typeof r === 'object');
}

function replyFor(id: RpcId, reply: UpstreamReply | undefined): Record<string, unknown> {
  if (reply === undefined) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'the upstream returned no response for this request' },
    };
  }
  if ('error' in reply && reply.error !== undefined) {
    return { jsonrpc: '2.0', id, error: reply.error };
  }
  return { jsonrpc: '2.0', id, result: reply.result ?? null };
}

export function rpcRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/v1/rpc/:chain', requireInstall('rpc'), async (c) => {
    const chainParam = c.req.param('chain');
    if (!isChainId(chainParam)) {
      return notFound('unknown_chain', 'the gateway proxies base, bsc, robinhood and solana', {
        chain: chainParam.slice(0, 32),
      });
    }
    const chain = chainParam;
    const install = c.get('install');
    const meter = (outcome: UsageOutcome, cached = false) =>
      recordUsage(c.env, { installId: install.installId, route: 'rpc', chain, outcome, cached });

    const parsed = await readJson(c);
    if (!parsed.ok) {
      meter('invalid');
      return badRequest('not_json', 'the body is not JSON');
    }
    const isBatch = Array.isArray(parsed.body);
    const rawItems: unknown[] = isBatch ? (parsed.body as unknown[]) : [parsed.body];
    if (rawItems.length === 0) {
      meter('invalid');
      return badRequest('empty_batch', 'a batch must contain at least one request');
    }
    if (rawItems.length > MAX_BATCH) {
      meter('invalid');
      return badRequest('batch_too_large', `a batch may contain at most ${MAX_BATCH} requests`, {
        max: MAX_BATCH,
        received: rawItems.length,
      });
    }

    const requests: RpcRequest[] = [];
    for (const [index, item] of rawItems.entries()) {
      const result = rpcRequestSchema.safeParse(item);
      if (!result.success) {
        meter('invalid');
        return badRequest('invalid_request', `request ${index} is not a JSON-RPC 2.0 request`, {
          index,
          issue: result.error.issues[0]?.message ?? 'invalid',
        });
      }
      requests.push(result.data);
    }

    for (const request of requests) {
      const verdict = checkMethod(chain, request.method);
      if (verdict.ok) continue;
      meter('refused');
      log.warn('method refused', { installId: install.installId, chain, method: verdict.method });
      if (verdict.reason === 'refused') {
        return forbidden(
          'method_refused',
          `${verdict.method} is refused: the gateway never broadcasts or signs. The runtime broadcasts through its own RPC connection.`,
          { method: verdict.method, chain },
        );
      }
      return forbidden(
        'method_not_allowed',
        `${verdict.method} is not on the read-only allowlist for ${chain}`,
        { method: verdict.method, chain },
      );
    }

    const guard = await guardProxy(c, 'rpc', 'rpc', chain);
    if (!guard.ok) return guard.response;
    const headers = { ...quotaHeaders(guard.decision), 'content-type': 'application/json' };

    // Cache: single requests only, idempotent methods only.
    const single = !isBatch ? requests[0] : undefined;
    const ttl = single ? (CACHE_TTL_SECONDS[single.method] ?? 0) : 0;
    const store = rpcStore();
    const key = single && ttl > 0 ? await cacheKey(chain, single) : null;
    if (single && key !== null) {
      const hit = await store.get(key);
      if (hit !== null) {
        meter('ok', true);
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: single.id ?? null,
            result: JSON.parse(hit) as unknown,
          }),
          { status: 200, headers: { ...headers, 'x-atra-cache': 'hit' } },
        );
      }
    }

    // Ids are renumbered for the upstream so duplicate or null client ids
    // still map back unambiguously.
    const payload = requests.map((request, index) => ({
      jsonrpc: '2.0',
      id: index,
      method: request.method,
      ...(request.params === undefined ? {} : { params: request.params }),
    }));
    const upstream = upstreamUrl(c.env, chain);
    const result = await callUpstream(upstream.url, isBatch ? payload : payload[0]);
    if (!result.ok) {
      meter('upstream_error');
      log.warn('upstream failed', { chain, kind: result.kind, keyed: upstream.keyed });
      if (result.kind === 'rate_limited') {
        return upstreamBusy(
          'upstream_rate_limited',
          `the ${chain} upstream is rate limiting; retry later or configure your own RPC URL`,
          result.retryAfter,
          { chain },
        );
      }
      if (result.kind === 'http') {
        return badGateway(
          'upstream_error',
          `the ${chain} upstream answered HTTP ${result.status}`,
          {
            chain,
            upstreamStatus: result.status,
          },
        );
      }
      if (result.kind === 'too_large') {
        return badGateway(
          'upstream_too_large',
          `the ${chain} upstream answered with more than ${MAX_UPSTREAM_BODY_BYTES / (1024 * 1024)} MB; narrow the request`,
          { chain, maxBytes: MAX_UPSTREAM_BODY_BYTES },
        );
      }
      return badGateway(
        'upstream_unreachable',
        result.kind === 'not_json'
          ? `the ${chain} upstream did not answer with JSON`
          : `the ${chain} upstream did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} s`,
        { chain },
      );
    }

    const byId = new Map<number, UpstreamReply>();
    for (const reply of asReplies(result.body)) {
      if (typeof reply.id === 'number') byId.set(reply.id, reply);
    }
    const replies = requests.map((request, index) => replyFor(request.id ?? null, byId.get(index)));

    if (single && key !== null) {
      const only = replies[0];
      if (only && 'result' in only && only.result !== null && only.result !== undefined) {
        c.executionCtx.waitUntil(store.put(key, JSON.stringify(only.result), ttl));
      }
    }

    meter('ok');
    const text = JSON.stringify(isBatch ? replies : replies[0]);
    return new Response(upstream.keyed ? scrubUpstream(text, upstream.url) : text, {
      status: 200,
      headers: { ...headers, 'x-atra-cache': key !== null ? 'miss' : 'bypass' },
    });
  });

  return app;
}
