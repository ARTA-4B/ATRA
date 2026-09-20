/**
 * Short-lived response caching for the proxies.
 *
 * Two backends behind one interface: the Cache API (per data centre, free,
 * no binding needed) and KV (global, needs a namespace, 60 s minimum TTL).
 * The JSON-RPC proxy always uses the Cache API: its TTLs are 5-30 s and a
 * per-colo cache is exactly right for "the same eth_call twice in a row".
 * The market proxy prefers KV when the namespace is bound so every colo
 * shares one 60 s snapshot per pool, and falls back to the Cache API.
 *
 * A cache failure is never an error: every call is wrapped, and a miss is
 * the worst outcome. Values are opaque strings; callers serialize.
 */
import type { Env } from './env.js';
import { errorSummary, logger } from './log.js';

const log = logger('cache');

export interface CacheStore {
  readonly backend: 'cache-api' | 'kv';
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** A synthetic origin: Cache API keys must be http(s) URLs, nothing is ever fetched from it. */
const CACHE_ORIGIN = 'https://atra-gateway.cache';

export function cacheApiStore(namespace: string): CacheStore {
  const keyUrl = (key: string) => `${CACHE_ORIGIN}/${namespace}/${encodeURIComponent(key)}`;
  return {
    backend: 'cache-api',
    async get(key) {
      try {
        const hit = await caches.default.match(keyUrl(key));
        return hit ? await hit.text() : null;
      } catch (error) {
        log.warn('cache api match failed', { error: errorSummary(error) });
        return null;
      }
    },
    async put(key, value, ttlSeconds) {
      const ttl = Math.max(1, Math.floor(ttlSeconds));
      try {
        await caches.default.put(
          keyUrl(key),
          new Response(value, {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'cache-control': `public, max-age=${ttl}`,
            },
          }),
        );
      } catch (error) {
        log.warn('cache api put failed', { error: errorSummary(error) });
      }
    },
  };
}

export function kvStore(kv: KVNamespace, namespace: string): CacheStore {
  return {
    backend: 'kv',
    async get(key) {
      try {
        return await kv.get(`${namespace}:${key}`, 'text');
      } catch (error) {
        log.warn('kv get failed', { error: errorSummary(error) });
        return null;
      }
    },
    async put(key, value, ttlSeconds) {
      try {
        // KV refuses a TTL under 60 s.
        await kv.put(`${namespace}:${key}`, value, {
          expirationTtl: Math.max(60, Math.floor(ttlSeconds)),
        });
      } catch (error) {
        log.warn('kv put failed', { error: errorSummary(error) });
      }
    },
  };
}

function hasKv(env: Env): env is Env & { KV: KVNamespace } {
  return env.KV !== undefined && typeof env.KV.get === 'function';
}

/** KV when bound, else the Cache API. */
export function marketStore(env: Env): CacheStore {
  return hasKv(env) ? kvStore(env.KV, 'market') : cacheApiStore('market');
}

export function rpcStore(): CacheStore {
  return cacheApiStore('rpc');
}
