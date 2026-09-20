# atra-gateway

The hosted gateway for ATRA: one Cloudflare Worker that lets a user's local
ATRA runtime (behind NAT, on their own machine) talk to a Telegram bot, read
the chains through project-owned RPC credentials and read market data through
a shared cache, without exposing a port, a key or a password to anyone.

> **Status: NOT deployed.** No Worker, no D1 database, no KV namespace, no
> Analytics Engine dataset and no Telegram bot exist until a human performs
> the steps under [Deploying](#deploying). Everything in this directory has
> been verified by the test suite (95 tests inside workerd: local D1, local KV,
> the real Hub Durable Object, real WebSockets, every upstream stubbed), by
> `wrangler deploy --dry-run` for both environments, and by one local
> `wrangler dev` session on 2026-09-20 that proxied read-only calls to the
> live public endpoints (see [What was verified live](#what-was-verified-live)).
> Nothing has been load-tested and no cost figure below is a measurement.

## What it is

```
Telegram ──webhook──▶ Worker (atra-gateway) ──RPC──▶ Hub Durable Object ──WebSocket──▶ user's runtime
                         │                             (hibernating sockets,
                         │                              SQLite quota counters)
                         ├── D1: install_tokens, pair_codes, tg_links, tg_updates
                         ├── KV (optional): 60 s market-data cache
                         ├── Cache API: 5-30 s JSON-RPC read cache
                         ├── Analytics Engine (optional): one row per proxied request
                         └── secrets: RPC URLs, bot token, pepper, admin token
runtime ──POST /v1/rpc/{chain}──▶ Worker ──▶ keyed upstream RPC (or the public endpoint)
runtime ──GET  /v1/market/...───▶ Worker ──▶ DexScreener / GeckoTerminal
```

- The **runtime connects outbound** to `GET /v1/ws` with an installation token
  and keeps one WebSocket open. The gateway never connects to the runtime.
- **Telegram calls the webhook**; the Worker forwards the user's command to
  that user's runtime through the Hub and relays the runtime's reply.
- The **RPC proxy** forwards read-only JSON-RPC to a hard-coded upstream per
  chain. The upstream URL (and any API key inside it) is a Worker secret; the
  runtime sees only a scoped installation token.
- The **market proxy** answers in the runtime's own `MarketSnapshot` shape,
  cached for 60 s, always with `source` and `asOf`.
- The **Hub** holds every runtime socket with the Durable Object hibernation
  API and, in its SQLite storage, the per-install daily quota counters.
- **D1** stores only hashes and ids: installation tokens as
  `HMAC-SHA256(TOKEN_PEPPER, token)`, pair codes as `SHA-256(code)`, the
  Telegram link as user id + chat id + display name, and `(chat_id, update_id)`
  for webhook replay protection.

What the gateway never does:

- **broadcasts or signs.** `eth_sendRawTransaction`, `eth_sendTransaction`,
  `sendTransaction`, `eth_sign*`, `personal_sign` and `requestAirdrop` are
  refused by name with HTTP 403 `method_refused`; every other method must be
  on the per-chain read allowlist. A gateway that can broadcast is a gateway
  that can be made to broadcast. The runtime broadcasts through its own RPC
  connection, and its private keys never leave its machine;
- sees or stores a private key, a vault password or a provider API key of the
  user's: there is no frame or endpoint to carry them;
- forwards wallet export or withdrawal commands over Telegram (`/export`,
  `/withdraw`, `/seed`, `/privatekey`, ... are refused before reaching any
  runtime; the runtime refuses them too);
- interprets a trading command: `/pause`, `/emergency` and friends are the
  runtime's business, and the emergency stop works with no gateway at all;
- invents data: a provider miss is a 404, a missing price is `null` with a
  reason, an upstream failure is a 502/503 problem document. Never a
  plausible-looking number;
- token-gates the software: ATRA runs with no gateway at all (see
  [Running without the gateway](#running-without-the-gateway-graceful-fallback-and-byok)).

## Endpoints

| Method | Path                                                        | Auth                                  | Purpose                                                                                      |
| ------ | ----------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/health`                                                   | none                                  | `{status, version, env}`                                                                     |
| POST   | `/tg/webhook`                                               | `X-Telegram-Bot-Api-Secret-Token`     | Telegram updates; always answers 200 after the secret check                                  |
| GET    | `/v1/ws`                                                    | installation token, scope `telegram`  | Runtime WebSocket, subprotocol `atra.v1`; counts against the `ws` quota                      |
| POST   | `/v1/rpc/{chain}`                                           | installation token, scope `rpc`       | Read-only JSON-RPC proxy, `chain` in `base, bsc, robinhood, solana`                          |
| GET    | `/v1/market/search?q=&chain=`                               | installation token, scope `market`    | DexScreener search, supported chains only                                                    |
| GET    | `/v1/market/{chain}/tokens/{address}/pools?source=`         | installation token, scope `market`    | Pools trading a token, deepest first                                                         |
| GET    | `/v1/market/{chain}/tokens/{address}/price?source=`         | installation token, scope `market`    | USD price of a token, `null` with a reason when unknown                                      |
| GET    | `/v1/market/{chain}/pools/{poolId}?source=`                 | installation token, scope `market`    | One pool; 404 when the provider does not know it                                             |
| GET    | `/v1/market/{chain}/pools/{poolId}/ohlcv?timeframe=&limit=` | installation token, scope `market`    | Candles (GeckoTerminal only), chronological                                                  |
| POST   | `/v1/inference`                                             | installation token, scope `inference` | Optional chat completion; **501 unless a provider is configured**                            |
| POST   | `/v1/admin/installs`                                        | `ADMIN_TOKEN`                         | Mint an installation token                                                                   |
| GET    | `/v1/admin/installs`                                        | `ADMIN_TOKEN`                         | List installations with scopes, pairing, online state and today's usage                      |
| POST   | `/v1/admin/installs/{id}/revoke`                            | `ADMIN_TOKEN`                         | Revoke every token of an installation and close its socket                                   |
| DELETE | `/v1/admin/installs/{id}`                                   | `ADMIN_TOKEN`                         | Revoke, close, and drop the Telegram link                                                    |
| GET    | `/v1/admin/usage?day=YYYY-MM-DD`                            | `ADMIN_TOKEN`                         | Per-install usage and rejections for one UTC day, from the Hub                               |
| cron   | `*/5 * * * *`                                               | —                                     | Purge `tg_updates` older than 24 h and dead pair codes; hourly, quota rows older than 7 days |

All bearer tokens go in `Authorization: Bearer …`. The Phase 5 routes (proxies,
quotas, admin list/revoke/usage) answer errors as RFC 9457 problem documents
(`application/problem+json`, stable `code`, `type: https://atra.local/errors/<code>`),
the same convention as the runtime's HTTP layer. The Phase 4 routes (webhook,
`/v1/ws`, the admin mint) keep their `{ "error": "..." }` bodies.

Installation token scopes: `telegram`, `rpc`, `market`, `inference`. The mint
endpoint grants `["telegram","rpc","market"]` unless told otherwise;
`inference` must be asked for explicitly because the route is off by default
and costs the project money when on.

### RPC proxy

`POST /v1/rpc/{chain}` takes one JSON-RPC 2.0 request or a batch of at most
20 and forwards it as one upstream request. The whole request is refused when
any item is not allowed; nothing is forwarded partially.

| Chain       | Family | Public endpoint (used when the secret is unset) | Secret with a keyed URL |
| ----------- | ------ | ----------------------------------------------- | ----------------------- |
| `base`      | EVM    | `https://mainnet.base.org`                      | `RPC_URL_BASE`          |
| `bsc`       | EVM    | `https://bsc-dataseed.bnbchain.org`             | `RPC_URL_BSC`           |
| `robinhood` | EVM    | `https://rpc.mainnet.chain.robinhood.com`       | `RPC_URL_ROBINHOOD`     |
| `solana`    | Solana | `https://api.mainnet-beta.solana.com`           | `RPC_URL_SOLANA`        |

The map is hard-coded in `src/rpc.ts`; nothing in a request can choose where it
goes. A secret that is not an `http(s)` URL is ignored with a warning that
names the secret, not its value. Upstream URLs never appear in a response or a
log line, and a keyed URL (and any 16+ character path or query segment of it)
is scrubbed from upstream error messages before they are relayed.

Allowed methods (reads only):

- EVM: `eth_call`, `eth_getBalance`, `eth_blockNumber`,
  `eth_getTransactionReceipt`, `eth_getTransactionCount`, `eth_gasPrice`,
  `eth_feeHistory`, `eth_estimateGas`, `eth_getLogs`, `eth_chainId`,
  `net_version`.
- Solana: `getBalance`, `getAccountInfo`, `getTokenAccountsByOwner`,
  `getLatestBlockhash`, `getSignatureStatuses`, `getTransaction`, `getSlot`,
  `getGenesisHash`, `getMinimumBalanceForRentExemption`, `simulateTransaction`.

Refused by name with 403 `method_refused` and a message that says the gateway
never broadcasts or signs: `eth_sendRawTransaction`, `eth_sendTransaction`,
`eth_sendPrivateTransaction`, `eth_sign`, `eth_signTransaction`,
`eth_signTypedData*`, `personal_sign`, `sendTransaction`,
`sendRawTransaction`, `requestAirdrop`. Anything else not on the allowlist is
403 `method_not_allowed`.

Cache (Cache API, per data centre, single requests only; batches bypass it
because a batch of 20 would cost 40 cache subrequests against the Worker's
budget of 25):

| TTL  | Methods                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 30 s | `eth_chainId`, `net_version`, `getGenesisHash`, `getMinimumBalanceForRentExemption`                                                                                         |
| 10 s | `eth_gasPrice`, `eth_feeHistory`, `eth_getLogs`, `getTransaction`                                                                                                           |
| 5 s  | `eth_blockNumber`, `eth_call`, `eth_getBalance`, `getBalance`, `getAccountInfo`, `getTokenAccountsByOwner`, `getSlot`, `getLatestBlockhash`                                 |
| none | `eth_getTransactionCount` (a stale nonce breaks the runtime's own broadcast), `eth_getTransactionReceipt`, `eth_estimateGas`, `getSignatureStatuses`, `simulateTransaction` |

Every response carries `x-atra-cache: hit | miss | bypass` and the quota
headers `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`
(epoch seconds of the next UTC midnight). Cached answers still count against
the quota: the quota is a request budget, which is what the platform bills.

Errors: 400 `not_json | empty_batch | batch_too_large | invalid_request`,
403 `method_refused | method_not_allowed | scope_missing`, 404 `unknown_chain`,
429 `rate_limited` (burst) or `quota_exceeded` (daily), 502
`upstream_error | upstream_unreachable`, 503 `upstream_rate_limited` with
`Retry-After` copied from the upstream.

### Market proxy

Read-through over DexScreener (default, `?source=dexscreener`) and
GeckoTerminal (`?source=geckoterminal`; the only source for OHLCV). Both are
keyless; the gateway adds the cache, the quota and nothing else, so a runtime
can make the same calls directly with no gateway (its own providers in
`runtime/src/market/providers/` do exactly that).

Every 200 answers

```json
{
  "data": …,
  "source": "dexscreener",
  "asOf": "2026-09-20T01:33:29.968Z",
  "fetchedAt": "2026-09-20T01:33:29.968Z",
  "cache": "miss",
  "ttlSeconds": 60
}
```

where `data` is a `MarketSnapshot`, a `MarketSnapshot[]`, a
`{ chain, token, priceUsd, reason? }` or an `OhlcvSeries`, in the shapes of
`runtime/src/market/types.ts` (decimal strings, never floats; basis points for
changes; `null` with a reason when a value is missing or unparsable; a `"0"`
price is "no price"). Neither provider stamps its rows, so `asOf` is when the
provider was read; on a cache hit it is the original read time, not now.

A pool the provider does not know is `404 not_found` with `source`, `asOf` and
`cache` in the problem document. Misses are cached for the same 60 s as hits.
A provider failure is `503 upstream_rate_limited` (with `Retry-After`) or
`502 upstream_error | upstream_unreachable`, naming the provider, never a
substitute value.

The cache is the `KV` namespace when bound (one 60 s snapshot shared by every
data centre) and the Cache API otherwise (per data centre). The cache key
includes the provider, the chain and the lower-cased address, so the two
providers never answer for each other.

### Quotas and burst protection

Two layers, both configurable, both per installation:

1. **Burst** — Workers rate limiting bindings. `RL_PROXY` (60 requests per
   10 s, shared by the three proxies) guards the proxies; `RL_WS`,
   `RL_WEBHOOK` and `RL_UNPAIRED` are unchanged from Phase 4. Namespace ids
   are 2001-2004 (production) and 2101-2104 (staging). **Ids 1001-1004
   belong to another Worker on this account and would share counters; never
   use them.** The bindings do not exist in dev or tests; the code guards them
   with `typeof` checks and treats "absent" as "allow". A refusal is
   `429 rate_limited` with `Retry-After: 10`.
2. **Daily quota** — counted in the Hub Durable Object's SQLite table
   `quota_usage (day, install_id, kind, used, rejected)`, per install, per UTC
   day, exact, and durable across eviction (a test evicts the object and
   checks the counter). A refusal is `429 quota_exceeded`:

   ```json
   {
     "type": "https://atra.local/errors/quota_exceeded",
     "title": "Quota exceeded",
     "status": 429,
     "code": "quota_exceeded",
     "detail": "the rpc quota of 5000 requests per UTC day is exhausted; it resets at 2026-09-21T00:00:00.000Z",
     "quota": "rpc",
     "limit": 5000,
     "used": 5000,
     "window": "utc_day",
     "windowStart": "2026-09-20T00:00:00.000Z",
     "resetAt": "2026-09-21T00:00:00.000Z",
     "retryAfterSeconds": 41567
   }
   ```

   with `Retry-After` set to the seconds until the reset.

| Kind        | Counts                                                         | Default per install per UTC day | Var                         |
| ----------- | -------------------------------------------------------------- | ------------------------------- | --------------------------- |
| `rpc`       | every `POST /v1/rpc/*` that passes validation, cached or not   | 5,000                           | `QUOTA_RPC_PER_DAY`         |
| `market`    | every `GET /v1/market/*` that passes validation, cached or not | 2,000                           | `QUOTA_MARKET_PER_DAY`      |
| `inference` | every `POST /v1/inference` that reaches a provider             | 200                             | `QUOTA_INFERENCE_PER_DAY`   |
| `ws`        | every accepted `GET /v1/ws` upgrade                            | 500                             | `QUOTA_WS_CONNECTS_PER_DAY` |

The defaults are a design choice, not a measurement: generous for one
household (a runtime polling balances, gas and a handful of pools every minute
uses a fraction of them) and small enough that ten installations stay inside
the Free plan's account-wide 100,000 requests/day. A var that is missing or
not a non-negative integer falls back to the default, never to "unlimited";
`0` switches a kind off. Requests refused by validation or by the method
allowlist are not counted (they cost the project nothing upstream) but are
metered to Analytics Engine.

### Revocation

`POST /v1/admin/installs/{id}/revoke` sets `revoked_at` on every live token
row of the installation and asks the Hub to close its socket (close code
`4003`). The next `/v1/ws` connect and the next proxied call fail with 401,
because `authenticateInstallToken` rejects a revoked row. `DELETE
/v1/admin/installs/{id}` does the same and also removes the Telegram link and
any unused pair codes. Both return
`{ installId, revokedAt, revokedTokens, closedSockets, unlinked }` and are
idempotent; an id that never had a token is 404.

**Rotation is still a TODO.** There is no endpoint that mints a replacement
token with a grace window for the old one (`rotated_from` exists in the
schema, the code does not). Until then, rotating means: mint a new token for
the same `installId`, update `ATRA_GATEWAY_TOKEN` on the runtime, restart it,
then revoke — which revokes every token of that installation, including the
new one. So today the order is revoke first, mint second, and accept the gap.

### Observability

- **Analytics Engine** (binding `AE`, dataset `atra_usage`, optional): one
  data point per proxied request and per WebSocket connect attempt —
  `indexes: [installId]`, `blobs: [route, chain, outcome, cached, env]`,
  `doubles: [1]`. `route` is `rpc | market | inference | ws`; `outcome` is
  `ok | invalid | refused | rate_limited | quota_exceeded | upstream_error |
not_configured`; `cached` is `hit | miss`. No request bodies, no addresses,
  no tokens, no IPs, no Telegram identities. The write is skipped when the
  binding is absent and logged (never thrown) when it fails.
- **`GET /v1/admin/usage?day=`**: the exact per-install counters and
  rejections for a UTC day from the Hub's SQLite (kept 7 days), plus the
  configured limits and the number of open sockets. `GET /v1/admin/installs`
  merges today's counters into the installation listing.
- **Workers Logs** (`observability.enabled`, 20 % head sampling): structured
  JSON lines from `src/log.ts`, which redacts any field named like a secret.
  Upstream URLs are never logged; an upstream failure logs the chain, the
  failure kind and whether the keyed URL was in use.

### Inference (optional, off by default)

`POST /v1/inference` with `{ messages: [{ role, content }], maxTokens?,
temperature? }` proxies one chat completion **only if** the operator has
configured a provider:

- `INFERENCE_MODEL` plus a Workers AI binding `AI` (add
  `"ai": { "binding": "AI" }` to the environment block in `wrangler.jsonc`;
  it is deliberately not there), or
- `INFERENCE_MODEL` plus `INFERENCE_URL` (an OpenAI-compatible
  `/v1/chat/completions` endpoint) and optionally `INFERENCE_API_KEY`.

With neither, the route answers `501 inference_not_configured` with the
detail `no inference provider is configured on this gateway`, and a runtime
falls back to its own provider. The response is
`{ data: { model, output, finishReason, usage }, source: "workers-ai" | "upstream", asOf }`;
the gateway echoes the configured model name and claims nothing about it.

Two things this section will not say: that inference is free (Workers AI has
an account-wide daily allowance and every provider bills past it; the quota
above exists so one installation cannot spend it), and that ATRA-4B is
served here. ATRA-4B is **UNTRAINED**: no fine-tuning run has completed and
`evaluate.py` has not passed, so it is not hosted anywhere, and the runtime's
BYOK provider (or a local model) remains the documented default.

## Running without the gateway (graceful fallback and BYOK)

The runtime does not need this Worker. Every gateway feature has a local
equivalent that the runtime already implements, and the gateway is only a
convenience layer over them:

| Gateway feature              | Local equivalent in the runtime                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/rpc/{chain}`       | the chain's public RPC (`runtime/src/chains/registry.ts`, the same URLs as the table above) or an operator-supplied keyed URL (BYOK) |
| `GET /v1/market/...`         | direct DexScreener and GeckoTerminal calls (`runtime/src/market/providers/`), same shapes, same keyless APIs                         |
| `POST /v1/inference`         | the operator's own LLM provider key or a local model (`docs/specs/llm-provider-spec.md`); this is the default                        |
| Telegram via `/v1/ws`        | the operator's own bot token, `ATRA_TELEGRAM_BOT_TOKEN`, polling Telegram directly (`docs/specs/telegram-protocol.md`)               |
| quotas, revocation, metering | not needed: there is nothing shared to protect                                                                                       |

Today the runtime does not call `/v1/rpc` or `/v1/market` at all; wiring an
`ATRA_GATEWAY_URL`-aware provider into it is runtime work. When it does, the
contract is: a gateway outage (or a 429, 501, 502, 503) degrades the runtime
to the local equivalent — public RPC, direct provider calls, the operator's own
keys — and never to fabricated data. The gateway's own answers already make
that easy: a miss is a 404, a missing value is `null` with a reason, and every
successful market answer says where and when it came from.

The core software is not token-gated: nothing in the runtime, the dashboard or
the model pipeline checks for an installation token, and the gateway's only
job is to make a hosted Telegram bot and shared credentials possible for
people who want them.

## Wire protocol (runtime ⇄ gateway, v1)

The runtime side is specified in `docs/specs/telegram-protocol.md` (written by
the runtime engineer). The gateway implements exactly this:

**Transport.** The runtime opens `GET {ATRA_GATEWAY_URL}/v1/ws` with
`Authorization: Bearer <installation token>` and
`Sec-WebSocket-Protocol: atra.v1`. Text frames only. Every 30 s the runtime
sends the literal text frame `ping` and expects the literal `pong` (answered by
the Durable Object's auto-response; the gateway also closes a socket with code
`4004` when no ping has arrived for 120 s). Three missed pongs mean reconnect
with exponential backoff (1 s .. 60 s, jitter). A new connection for the same
installation closes the previous one with code `4001`; a revoked installation
is closed with `4003`.

**Envelope.** Every JSON frame is
`{ "v": 1, "type": <string>, "id": <uuid per frame>, "ts": <epoch ms>, ...payload }`.
Frames larger than 16 KiB, non-JSON frames and frames that fail validation are
answered with an `error` frame and otherwise ignored. The first frame after
connect must be `hello`; anything else first gets `error{code:"hello_required"}`.

Runtime → gateway:

| type          | payload                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`       | `{ installationId, runtimeVersion, capabilities: ["telegram"] }` — `installationId` is the runtime's own installation id and is logged only; the bearer token decides which installation the socket belongs to |
| `pair.offer`  | `{ codeHash, expiresAt }` — `codeHash` = lowercase hex `sha256(code with the dash removed, upper-case)`; replaces the installation's unused code; `expiresAt` is clamped to now + 10 min                       |
| `pair.revoke` | `{}` — deletes the Telegram link and unused codes; answered with `unpaired{reason:"revoked by runtime"}`                                                                                                       |
| `reply`       | `{ requestId, text }` — plain text (≤ 4096 chars) sent to the paired chat with no parse mode                                                                                                                   |
| `notify`      | `{ kind, text }` — forwarded to the paired chat; silently ignored when unpaired                                                                                                                                |

Gateway → runtime:

| type       | payload                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `welcome`  | `{ paired, telegram: { userId, chatId, displayName } \| null, botUsername }` — right after `hello`                          |
| `paired`   | `{ telegram, pairedAt }`                                                                                                    |
| `unpaired` | `{ reason }`                                                                                                                |
| `command`  | `{ requestId, updateId, telegram, text, receivedAt }` — `receivedAt` is Telegram's message `date` in ms; `text` ≤ 512 chars |
| `error`    | `{ requestId?, code, message }`                                                                                             |

Webhook behaviour, pair code format and the runtime's own verification duties
are unchanged from Phase 4: `/start` and `/help` are answered by the gateway,
`/pair CODE` consumes the code atomically, any other text from a linked user
is forwarded and answered within 8 s or with "ATRA runtime is offline or not
responding", an unlinked user gets one rate-limited hint, duplicates are
ignored, and the runtime must still verify `telegram.userId`/`chatId`, check
`updateId` monotonicity and message age, and rate limit.

## Deploying

Everything below is done by a human with access to the Cloudflare account and
to Telegram. Nothing in CI deploys, and as of this commit none of it has been
done.

1. **Create two bots with @BotFather** (staging and production; a webhook
   disables `getUpdates`, so one bot cannot serve both). Put the usernames into
   `vars.BOT_USERNAME` of the matching `env` block in `wrangler.jsonc`.

2. **Create the databases** and record the ids in `wrangler.jsonc`
   (`REPLACE_WITH_STAGING_D1_ID` / `REPLACE_WITH_PRODUCTION_D1_ID`):

   ```sh
   cd gateway
   pnpm install
   npx wrangler d1 create atra-gateway-staging
   npx wrangler d1 create atra-gateway-production
   npx wrangler d1 migrations apply atra-gateway-staging --env staging --remote
   npx wrangler d1 migrations apply atra-gateway-production --env production --remote
   ```

3. **Create the KV namespaces** (optional; delete the `kv_namespaces` block of
   an environment to fall back to the per-colo Cache API) and record the ids
   (`REPLACE_WITH_STAGING_KV_ID` / `REPLACE_WITH_PRODUCTION_KV_ID`):

   ```sh
   npx wrangler kv namespace create atra-gateway-staging-market
   npx wrangler kv namespace create atra-gateway-production-market
   ```

4. **Analytics Engine** (optional; delete the `analytics_engine_datasets`
   block to skip metering): the dataset `atra_usage` is created on first
   write, but Analytics Engine may need to be enabled once in the dashboard
   (Workers & Pages → Analytics Engine) before `wrangler deploy` accepts the
   binding. Whether this account needs that step is unverified.

5. **Set the secrets** (per environment; generate random values with
   `openssl rand -base64 32` or similar; never commit them). The first four
   are required; the RPC URLs are optional and default to the public
   endpoints; the inference ones are optional and leave the route at 501:

   ```sh
   for env in staging production; do
     npx wrangler secret put TELEGRAM_BOT_TOKEN --env $env        # from BotFather
     npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env $env   # random, 1-256 chars [A-Za-z0-9_-]
     npx wrangler secret put TOKEN_PEPPER --env $env              # random, 32+ bytes
     npx wrangler secret put ADMIN_TOKEN --env $env               # random, 32+ bytes
     npx wrangler secret put RPC_URL_BASE --env $env              # optional keyed https URL
     npx wrangler secret put RPC_URL_BSC --env $env               # optional
     npx wrangler secret put RPC_URL_ROBINHOOD --env $env         # optional; the public endpoint is rate limited
     npx wrangler secret put RPC_URL_SOLANA --env $env            # recommended, see "What was verified live"
     npx wrangler secret put INFERENCE_URL --env $env             # optional
     npx wrangler secret put INFERENCE_API_KEY --env $env         # optional
     npx wrangler secret put INFERENCE_MODEL --env $env           # optional; required for inference
   done
   ```

   Quota overrides go in `vars` of the environment block
   (`QUOTA_RPC_PER_DAY` etc.), not in secrets.

6. **Deploy**:

   ```sh
   npx wrangler deploy --env staging
   npx wrangler deploy --env production
   ```

   `GET /health` must return `{"status":"ok",...}`.

7. **Point Telegram at the webhook** (per bot, with that environment's secret):

   ```sh
   curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -H 'content-type: application/json' \
     -d '{"url":"https://<worker-host>/tg/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message"],"drop_pending_updates":true}'
   ```

8. **Mint an installation token** for each runtime (the clear-text token is
   returned once and stored only as an HMAC):

   ```sh
   curl -sS -X POST "https://<worker-host>/v1/admin/installs" \
     -H "authorization: Bearer <ADMIN_TOKEN>" \
     -H 'content-type: application/json' \
     -d '{"installId":"<the runtime's installation id>"}'
   # {"installId":"…","token":"atra_01….…","scopes":["telegram","rpc","market"],"expiresAt":…}
   ```

   Optional body fields: `installId` (`^[A-Za-z0-9_-]{8,64}$`), `scopes`
   (subset of `telegram, rpc, market, inference`), `ttlDays` (1..3650, or
   `null` for no expiry; default 365 days).

9. **Configure the runtime** with `ATRA_GATEWAY_URL=wss://<worker-host>` and
   `ATRA_GATEWAY_TOKEN=atra_…`.

10. **Check usage** with `GET /v1/admin/usage` and the installation list with
    `GET /v1/admin/installs`; revoke with `POST /v1/admin/installs/{id}/revoke`.

### Cloudflare Free plan caveats

- **100,000 requests/day are account-wide**, shared with every other Worker on
  the account. When the quota is exhausted every Worker fails closed with
  error 1027. Each proxied request is one Worker request plus one Durable
  Object request (the quota check) plus one D1 read (the token). Enable
  Workers Paid ($5/month) before inviting anyone.
- **D1 Free**: 5 million rows read/day, 100,000 rows written/day,
  hard-enforced. Each authenticated call costs 1 read.
- **Durable Objects on the Free plan** are limited to SQLite-backed classes
  (`Hub` is one), with 100,000 requests/day. Every quota check is one DO
  request; `ping`/`pong` auto-responses are not.
- **KV Free**: 100,000 reads/day, 1,000 writes/day. A market cache miss is one
  write; at 60 s TTL the writes are bounded by how many distinct pools the
  installations look at per minute. If that bound is a problem, drop the KV
  block and the Cache API takes over at no cost.
- **Rate limiting bindings** are per Cloudflare location, eventually
  consistent, and only allow 10 s or 60 s windows: a burst guard, not
  accounting. The daily quota in the Hub is the accounting.
- **Analytics Engine** has a free allowance of data points per day; the
  gateway writes one per proxied request.
- `limits.cpu_ms: 10` and `limits.subrequests: 25` in `wrangler.jsonc` cap the
  blast radius of a bug. The RPC cache is limited to single requests for that
  reason.

## What was verified live

On 2026-09-20, from this machine, read-only, with no deployment:

- `eth_chainId` on the four public endpoints in `UPSTREAMS` answered
  `0x2105` (Base), `0x38` (BSC), `0x1237` (Robinhood Chain) and Solana's
  `getGenesisHash` answered `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`;
  Base accepted a JSON-RPC batch.
- DexScreener answers `[]` for an unknown token and `{"pairs":null}` for an
  unknown pair; GeckoTerminal answers HTTP 404 `{"errors":[…]}` for an
  unknown pool and lists the `robinhood` network. The proxy's miss handling
  is built on those shapes.
- Through `wrangler dev` (workerd on this machine, local D1/KV): mint →
  `eth_chainId` on Base (miss, then hit), Robinhood Chain, a BSC batch →
  `eth_sendRawTransaction` refused → USDC price on Base from both providers →
  unknown pool 404 → 30 WETH pools on Robinhood Chain → inference 501 →
  admin usage → revoke → 401. All as documented above.
- **Not verified / found:** Solana's public RPC answered **HTTP 403** to the
  proxy running under workerd while the same request from `curl` and Node
  got 200. Whether a deployed Worker is also refused is unknown (nothing is
  deployed). Set `RPC_URL_SOLANA` to a keyed provider before relying on the
  Solana proxy; the runtime's direct connection to the public endpoint is
  unaffected.

## Development

```sh
cd gateway
pnpm install                 # standalone project; do not run from the repo root
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test                # 95 tests inside workerd (~30 s)
pnpm run dev                 # wrangler dev with the top-level (local) config
```

`wrangler dev` needs a `.dev.vars` file (gitignored) with the secrets, or
`--var NAME:value` on the command line, to exercise anything beyond `/health`;
the local D1 needs `npx wrangler d1 migrations apply atra-gateway-local --local`
once.

The test suite uses `@cloudflare/vitest-plugin` (the successor of
`@cloudflare/vitest-pool-workers`; same configuration and APIs). Tests create
real WebSockets against the Hub, apply the D1 migrations, use the local KV
namespace, and replace `globalThis.fetch` so that every upstream (Telegram,
the RPC endpoints, DexScreener, GeckoTerminal, an inference upstream) is a
stub; the suite never reaches the network. The rate limiting, Analytics
Engine and AI bindings do not exist locally; the code guards them with
`typeof` checks and the tests inject stubs to exercise the limited, metered
and configured paths.

### Layout

```
wrangler.jsonc        Worker, Hub DO, D1, KV, Analytics Engine, cron, per-env rate limits
migrations/0001_init.sql
src/index.ts          Hono app: webhook, /v1/ws, mounts the route modules, scheduled handler
src/hub.ts            Hub Durable Object: hibernating WebSockets, alarm sweep, quota_usage SQLite, revoke close
src/rpc.ts            POST /v1/rpc/{chain}: UPSTREAMS map, allowlists, refusals, batch, Cache API
src/market.ts         GET /v1/market/*: DexScreener + GeckoTerminal, MarketSnapshot shape, 60 s cache
src/inference.ts      POST /v1/inference: 501 unless AI binding or INFERENCE_URL + INFERENCE_MODEL
src/admin.ts          mint, list, revoke, delete, usage (ADMIN_TOKEN)
src/auth.ts           requireInstall(scope) and requireAdmin middleware
src/quota.ts          quota kinds, defaults, vars, UTC windows, the 429 document
src/proxy.ts          burst limit + quota guard shared by the proxies
src/cache.ts          Cache API / KV store abstraction
src/usage.ts          Analytics Engine data points (guarded)
src/problem.ts        RFC 9457 problem documents
src/context.ts        Hono env type (Bindings + the authenticated install)
src/protocol.ts       frame schemas and envelope
src/webhook.ts        Telegram update handling
src/pairing.ts        pair codes and tg_links (D1)
src/tokens.ts         installation tokens (mint, HMAC, authenticate; rotation TODO)
src/telegram.ts       Update schema, sendMessage
src/ratelimit.ts      guarded rate limit bindings
src/crypto.ts         sha256, hmac, uuidv7, constant-time compare
src/log.ts            structured logs with key scrubbing
test/                 vitest (workerd) suite: admin, ws, webhook, unit, rpc, market, quota, revoke, inference
```

Rate limit namespace ids 1001-1004 belong to another Worker on this account and
would share counters: this Worker uses 2001-2004 (production) and 2101-2104
(staging) and must never be changed to the lower range.
