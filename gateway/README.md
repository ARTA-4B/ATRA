# atra-gateway

The hosted Telegram gateway for ATRA: one Cloudflare Worker that lets a user's
local ATRA runtime (behind NAT, on their own machine) talk to a Telegram bot
without exposing a port, a key or a password to anyone.

> **Status: NOT deployed.** No Worker, no D1 database and no Telegram bot exist
> until a human performs the steps under [Deploying](#deploying). Everything in
> this directory has been verified only by the test suite (workerd, local D1,
> real WebSockets, `api.telegram.org` stubbed) and by `wrangler deploy --dry-run`.

## What it is

```
Telegram ──webhook──▶ Worker (atra-gateway) ──RPC──▶ Hub Durable Object ──WebSocket──▶ user's runtime
                         │                             (hibernating sockets)
                         └── D1: install_tokens, pair_codes, tg_links, tg_updates
```

- The **runtime connects outbound** to `GET /v1/ws` with an installation token
  and keeps one WebSocket open. The gateway never connects to the runtime.
- **Telegram calls the webhook**; the Worker forwards the user's command to
  that user's runtime through the Hub and relays the runtime's reply as plain
  text.
- The **Hub** holds every runtime socket with the Durable Object hibernation
  API: a `ping`/`pong` heartbeat is answered by `setWebSocketAutoResponse`
  without waking the object, and the only recurring cost is a 60 s sweep alarm
  that is re-armed only while sockets exist. One hub at launch (name `global`).
- **D1** stores only hashes and ids: installation tokens as
  `HMAC-SHA256(TOKEN_PEPPER, token)`, pair codes as `SHA-256(code)`, the
  Telegram link as user id + chat id + display name, and `(chat_id, update_id)`
  for webhook replay protection (purged after 24 h by a 5-minute cron).

What the gateway never does:

- sees or stores a private key, a vault password or a provider API key: those
  never leave the runtime, and the gateway has no frame or endpoint to carry them;
- forwards wallet export or withdrawal commands (`/export`, `/withdraw`,
  `/seed`, `/privatekey`, ... are refused before reaching any runtime; the
  runtime refuses them too);
- interprets a trading command: `/pause`, `/emergency` and friends are the
  runtime's business, and the emergency stop works with no gateway at all;
- talks to a group chat: only private chats are handled.

## Endpoints

| Method | Path                 | Auth                                         | Purpose                                                     |
| ------ | -------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| GET    | `/health`            | none                                         | `{status, version, env}`                                    |
| POST   | `/tg/webhook`        | `X-Telegram-Bot-Api-Secret-Token`            | Telegram updates; always answers 200 after the secret check |
| GET    | `/v1/ws`             | `Authorization: Bearer <installation token>` | Runtime WebSocket, subprotocol `atra.v1`                    |
| POST   | `/v1/admin/installs` | `Authorization: Bearer <ADMIN_TOKEN>`        | Mint an installation token (Phase 5 registration stand-in)  |
| cron   | `*/5 * * * *`        | —                                            | Purge `tg_updates` older than 24 h and dead pair codes      |

Webhook behaviour:

- `/start`, `/help` are answered by the gateway with the pairing instructions.
- `/pair CODE` is handled by the gateway: the code is upper-cased, the dash and
  whitespace removed, validated against `^[A-Z2-9]{8}$`, hashed with SHA-256
  and consumed with one atomic statement
  (`UPDATE pair_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>? RETURNING install_id`).
  Success links the user (one link per installation, one installation per
  Telegram user; a user who pairs a second installation is moved and the first
  one is told), sends `paired` to the runtime if connected, and replies
  `Paired with installation <first 8 chars>`. Any failure replies
  `Code invalid or expired`, rate limited.
- Any other text from a **linked** user is forwarded as a `command` frame and
  the gateway waits up to 8 s for the `reply`; no socket or no reply within the
  window gives `ATRA runtime is offline or not responding`.
- An **unlinked** user gets exactly one generic hint (rate limited): "This bot
  is not paired with an ATRA installation. Generate a code in your dashboard
  and send /pair CODE."
- Duplicate `(chat_id, update_id)` pairs are acknowledged and ignored.

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
installation closes the previous one with code `4001`.

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

The runtime **must** still verify `telegram.userId`/`chatId` against its own
stored pairing, check `updateId` monotonicity and message age, and rate limit:
the gateway only forwards commands from the linked user, but defense in depth
is the rule.

Pair code format as shown to the user: `^[A-Z2-9]{4}-[A-Z2-9]{4}$` (no 0/1/O/I),
5-minute TTL, single use.

## Deploying

Everything below is done by a human with access to the Cloudflare account and
to Telegram. Nothing in CI deploys.

1. **Create two bots with @BotFather** (staging and production; a webhook
   disables `getUpdates`, so one bot cannot serve both). Note each bot's
   token and username. Put the usernames into `vars.BOT_USERNAME` of the
   matching `env` block in `wrangler.jsonc` (they are public; the tokens are not).

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

3. **Set the secrets** (four per environment; generate random values with
   `openssl rand -base64 32` or similar; never commit them):

   ```sh
   for env in staging production; do
     npx wrangler secret put TELEGRAM_BOT_TOKEN --env $env        # from BotFather
     npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env $env   # random, 1-256 chars [A-Za-z0-9_-]
     npx wrangler secret put TOKEN_PEPPER --env $env              # random, 32+ bytes
     npx wrangler secret put ADMIN_TOKEN --env $env               # random, 32+ bytes
   done
   ```

4. **Deploy**:

   ```sh
   npx wrangler deploy --env staging
   npx wrangler deploy --env production
   ```

   The Worker is reachable at `https://atra-gateway-staging.<subdomain>.workers.dev`
   and `https://atra-gateway-production.<subdomain>.workers.dev` (the exact
   hostname is printed by the deploy). `GET /health` must return
   `{"status":"ok",...}`.

5. **Point Telegram at the webhook** (per bot, with that environment's secret):

   ```sh
   curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -H 'content-type: application/json' \
     -d '{"url":"https://<worker-host>/tg/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message"],"drop_pending_updates":true}'
   curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
   ```

6. **Mint an installation token** for each runtime (the clear-text token is
   returned once and stored only as an HMAC):

   ```sh
   curl -sS -X POST "https://<worker-host>/v1/admin/installs" \
     -H "authorization: Bearer <ADMIN_TOKEN>" \
     -H 'content-type: application/json' \
     -d '{}'
   # {"installId":"01…","token":"atra_01….…","scopes":["telegram"],"expiresAt":…}
   ```

   Optional body fields: `installId` (`^[A-Za-z0-9_-]{8,64}$`), `ttlDays`
   (1..3650, or `null` for no expiry; default 365 days). The runtime generates
   its own installation id at setup and reports it in `hello`; the gateway
   routes by the token, not by that id, so the two need not match. Passing the
   runtime's id as `installId` when minting keeps the logs easy to correlate.

7. **Configure the runtime** with

   ```
   ATRA_GATEWAY_URL=wss://<worker-host>
   ATRA_GATEWAY_TOKEN=atra_…
   ```

   The runtime connects to `${ATRA_GATEWAY_URL}/v1/ws`; the dashboard's
   Telegram page then shows the bot and the pairing code flow.

Revoking a token today means `UPDATE install_tokens SET revoked_at = <now> WHERE install_id = '…'`
through `wrangler d1 execute`. Rotation with a 300 s grace window is Phase 5
(`rotated_from` exists in the schema; see the TODO in `src/tokens.ts`).

### Cloudflare Free plan caveats

- **100,000 requests/day are account-wide**, shared with every other Worker on
  the account (this account already runs other Workers). When the quota is
  exhausted every Worker fails closed with error 1027. Enable Workers Paid
  ($5/month) before inviting anyone.
- **D1 Free**: 5 GB total, 5 million rows read/day, 100,000 rows written/day,
  hard-enforced. Each webhook costs 1 write (dedupe) + 1-2 reads; each `/v1/ws`
  connect costs 1 read; the cron purge is a few writes per run.
- **Durable Objects on the Free plan** are limited to SQLite-backed classes
  (`new_sqlite_classes`, which `Hub` uses), with 100,000 requests/day and
  13,000 GB-s/day of duration. WebSocket messages and alarm invocations count
  as requests, `ping`/`pong` auto-responses do not; the 60 s sweep alarm is one
  request per minute while at least one runtime is connected (1,440/day).
- **Rate limiting bindings** are per Cloudflare location, eventually consistent,
  and only allow 10 s or 60 s windows: they are a burst guard, not accounting.
- `limits.cpu_ms: 10` and `limits.subrequests: 25` in `wrangler.jsonc` cap the
  blast radius of a bug; a webhook that forwards a command spends most of its
  time waiting, not computing.

## Development

```sh
cd gateway
pnpm install                 # standalone project; do not run from the repo root
pnpm run typecheck
pnpm run lint
pnpm run test                # 49 tests inside workerd (~20 s)
pnpm run dev                 # wrangler dev with the top-level (local) config
```

`wrangler dev` needs a `.dev.vars` file (gitignored) with the four secrets to
exercise anything beyond `/health`.

The test suite uses `@cloudflare/vitest-plugin` (the successor of
`@cloudflare/vitest-pool-workers`; same configuration and APIs). Tests create
real WebSockets against the Hub, apply the D1 migrations from `migrations/`,
and replace `globalThis.fetch` so that `sendMessage` calls are captured instead
of reaching Telegram. The rate limiting bindings do not exist locally; the
code guards them with `typeof` checks and the tests inject stub bindings to
exercise the limited path.

### Layout

```
wrangler.jsonc        Worker, Hub DO, D1, cron, per-env rate limits (ids 2001-2003 / 2101-2103)
migrations/0001_init.sql
src/index.ts          Hono routes + scheduled handler, exports Hub
src/hub.ts            Hub Durable Object (hibernating WebSockets, alarm sweep, RPC)
src/protocol.ts       frame schemas and envelope
src/webhook.ts        Telegram update handling
src/pairing.ts        pair codes and tg_links (D1)
src/tokens.ts         installation tokens (mint, HMAC, authenticate)
src/telegram.ts       Update schema, sendMessage
src/ratelimit.ts      guarded rate limit bindings
src/crypto.ts         sha256, hmac, uuidv7, constant-time compare
src/log.ts            structured logs with key scrubbing
test/                 vitest (workerd) suite
```

Rate limit namespace ids 1001-1004 belong to another Worker on this account and
would share counters: this Worker uses 2001-2003 (production) and 2101-2103
(staging) and must never be changed to the lower range.
