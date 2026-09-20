# Telegram

Written for: an operator who wants to watch and stop ATRA from a phone, and
a reviewer asking what a phone can make ATRA do. State of the code on
2026-09-20.

**Nothing here has touched a real Telegram account.** The runtime side and
the gateway are complete and tested against fakes and a stubbed
`api.telegram.org`; the hosted gateway is not deployed and no official bot
exists yet. The self-hosted transport (your own bot token) works today with
the same code, and has the same tests.

## What Telegram can and cannot do

**Can:** show status, portfolio, positions, trades, LP summary and risk
usage; pause and resume; engage the emergency stop; toggle alerts.

**Cannot, and the runtime refuses regardless of what any gateway forwards:**
export a key, withdraw, change a limit, allowlist a token, switch to LIVE,
clear an emergency stop, run a trading cycle, or read anything that is not
in the list above. The command router (`runtime/src/telegram/commands.ts`)
has no import of the vault, the executors, the withdrawal service or the
policy store, so there is no code for a message to reach.

Every word that smells like a key (`/export`, `/withdraw`, `/key`, `/seed`,
`/privatekey`, ...) gets one fixed refusal and an audit row.

## Two transports

| | Official gateway | Your own bot |
|---|---|---|
| Configure | `ATRA_GATEWAY_URL` and `ATRA_GATEWAY_TOKEN` in `.env` | `ATRA_TELEGRAM_BOT_TOKEN` (and optionally `ATRA_TELEGRAM_BOT_USERNAME`) in `.env` |
| Where the bot token lives | On the gateway, as a Worker secret; never distributed | In your environment only |
| How the runtime connects | Dials **out** over WebSocket (`atra.v1`), heartbeats every 30 s, reconnects with backoff; no inbound port | Long-polls `getUpdates` every 25 s with a persisted offset; no inbound port |
| Status today | Code complete and tested in workerd (49 tests on the last commit, 95 in this checkout), **not deployed**: no Worker, no D1, no bot, no installation token exists | Works today; needs a bot from @BotFather |
| Nothing configured | `POST /api/v1/telegram/pair` answers `409 TELEGRAM_NOT_CONFIGURED`; everything else reports "not configured" | |

Selection is gateway, then direct, then none. `ATRA_MODE=ci` never opens a
transport. A gateway URL without its token is refused at boot, and so is a
cleartext one: `ATRA_GATEWAY_URL` must be `https:` or `wss:` unless the host
is `localhost`, `127.0.0.1` or `::1`. The installation token is sent in the
upgrade request's `Authorization` header, so an unencrypted hop off this
machine would hand it to whoever is carrying the packets.

Two gateway close codes are not treated as a blip. **4001** (another client
connected with this installation's token) reconnects as usual but writes a
`telegram.transport.superseded` audit row, so a stolen token in use elsewhere
shows up instead of hiding behind a normal-looking reconnect loop. **4003**
(the installation token was revoked) stops the reconnect loop for good, writes
`telegram.transport.revoked` and leaves `gateway token revoked; issue a new
token` in the transport status the dashboard shows.

Tokens are read from the environment once, at the composition root
(`readTelegramSecrets`), handed to the transport and held nowhere else: not on
the config object, not in the database, not in a frame, a reply, an audit
row, a notification or a log line. `telegram-service.test.ts` "secrecy" runs
every command with both tokens set and a real logger capturing every line,
and asserts neither token appears anywhere.

### Setting up your own bot (works today)

1. Talk to @BotFather, `/newbot`, keep the token.
2. Put `ATRA_TELEGRAM_BOT_TOKEN=<token>` in `.env` (and
   `ATRA_TELEGRAM_BOT_USERNAME=<name>` so the dashboard can link to it).
3. Restart the runtime. Pair as below.

The token is a secret that can send messages as your bot; it cannot move
funds or reach a key, but keep `.env` out of version control (it is
gitignored) and include it in your backups only because the backup is
encrypted.

## Pairing

1. Dashboard: `POST /api/v1/telegram/pair` returns a code like `K7ZQ-4MWD`
   (CSPRNG, alphabet without `0 1 O I`, 40 bits), shown once, valid five
   minutes. The database keeps only `sha256(code)`.
2. Send `/pair K7ZQ-4MWD` to the bot (case and dash do not matter).
3. Verification is one atomic `UPDATE ... WHERE used_at IS NULL AND expires_at > now`.
   A code works exactly once; issuing a new code retires every older unused
   one; a wrong or expired code never touches the link.
4. The Telegram user id, chat id and display name (public identifiers, not
   credentials) are written to the single `telegram_link` row. That row, and
   nothing else, decides who may command this runtime.
5. The dashboard polls `GET /api/v1/telegram/pair/{code}` until `confirmed`.

Unpairing from the dashboard deletes the row and, on the gateway transport,
tells the gateway to drop its side. On every gateway `welcome` the runtime
compares the two sides and fails closed on disagreement (a different user, or
one side paired and the other not: the link is dropped).

One installation, one Telegram user, and the link only ever changes after a
local unpair:

- While a link exists, `POST /api/v1/telegram/pair` answers
  `409 TELEGRAM_ALREADY_PAIRED`. There is no code to leak, because there is no
  code to issue.
- A code that reaches the bot from a different Telegram account is refused
  before it is consumed, so the operator's own code still works afterwards.
  The same account pairing a second chat is a re-pair and is allowed.
- A gateway `paired` frame naming a different account is refused and written
  to the audit trail as `telegram.pair.refused` (masked user id, status
  `failed`). The gateway is a server; it does not get to move the link.

So a phone move is: unpair in the dashboard, issue a code, pair again.

## Every message walks the same gates

```
replay   the update id must be greater than the last one seen for that chat
         (persisted per chat, so a stranger's chat cannot advance the cursor)
  -> age      at most 120 s old, at most 60 s in the future
    -> identity   user id AND chat id equal the stored link; anyone else gets
                  one generic "not paired" reply, at most 3 per 10 minutes,
                  and nothing changes
      -> rate limits   20 commands a minute; 5 a minute for /pause /resume
                       /emergency; 5 /pair attempts per 10 minutes
        -> the command
```

Every message writes a row to the append-only `telegram_commands` table (the
command word and the outcome, never the text) and an audit row in category
`telegram` with actor `telegram:******789` (the last three digits of the
user id).

## Commands

| Command | Does |
|---|---|
| `/status` | mode, pause, emergency, uptime, scheduler, chains, model status (`UNTRAINED` or `UNAVAILABLE`), transport state |
| `/portfolio`, `/positions` | the ledger marked at cross-checked prices; an unpriced position is reported as **unknown**, and so are the totals that depend on it |
| `/trades` | the last five trade rows with status and rejection code |
| `/lp` | the LP engine's summary, or "LP not available" |
| `/risk` | the policy limits and today's usage as a percentage of each |
| `/pause`, `/resume` | flip the global pause with actor `telegram`; `/resume` refuses while the emergency stop is engaged |
| `/emergency`, then `/emergency CONFIRM` within 60 s | engages the emergency stop through `StateStore.setEmergencyStop` alone: one row, no model, no network; LIVE drops to PAPER and both schedulers are disarmed |
| `/emergency clear` (any spelling) | refused: clearing needs the dashboard and a re-authentication |
| `/alerts on`, `/alerts off`, `/alerts status` | the notification master switch |
| `/help`, `/start` | the command list |
| anything about keys, exports or withdrawals | one fixed refusal, audited |

Replies are plain text (no parse mode), at most 3,500 characters, addresses
shortened, and every reply passes through the same secret scrubber the
logger uses before it leaves the process.

## Notifications

Kinds: `trade.filled`, `trade.rejected`, `trade.failed`, `lp.filled`,
`lp.rebalanced`, `lp.exited`, `risk.dailyLossNear`, `gas.low`,
`emergency.engaged`, `emergency.cleared`, `runtime.online`, `runtime.offline`,
`paused`, `resumed`.

Kept quiet by, in order: unpaired; `/alerts off`; the dashboard's category
toggle (`PUT /api/v1/telegram/notifications`); a one-hour dedupe on the same
message; a ten-minute cooldown per rejection code (the next message says how
many were swallowed); thirty messages an hour. A delivery failure is logged
and recorded, never thrown into the trading path.

`GasWatcher` checks `gasLow` every ten minutes and raises `gas.low` at most
once an hour per chain. `DailyLossWatcher` warns once per UTC day at 80 % of
`maxDailyLossUsd`.

Known gap on 2026-09-20: the three `lp.*` kinds exist in the vocabulary but
nothing raises them; the LP pipeline has no notification hook (Phase 4
report).

## What the gateway does and does not do

The hosted gateway (`gateway/`) is one Cloudflare Worker: Telegram calls its
webhook, it forwards the user's text to that user's runtime through a
Durable Object holding the WebSocket, and relays the plain-text reply. Its
D1 tables hold hashes and ids only: installation tokens as an HMAC, pair
codes as SHA-256, the Telegram link, and `(chat_id, update_id)` for replay
protection. It refuses export and withdrawal words before they reach any
runtime, talks only to private chats, and has no frame or endpoint that
could carry a key or a password.

The gateway filters first, but the runtime re-verifies the identity, the
update id and the age of every command. Defence in depth is the rule: the
gateway is a server, and the runtime trusts nothing it is told.

The gateway's owner is extending it in Phase 5 (RPC proxy, market cache,
optional inference, per-install quotas); `gateway/README.md` is authoritative
and includes the deployment steps a human must perform. Until those steps
are performed there is no official bot to pair with.

## Limits worth knowing

- The rate limiters and the 60-second emergency challenge are in memory and
  reset on restart. The replay cursor and the pairing link are persisted.
- Delivery is not confirmed. The runtime records the outcome of its send;
  whether Telegram showed the message to a human is not something it can
  know.
- Group chats are ignored on both transports.

## Where things live

| | File |
|---|---|
| Frame codec, pair-code alphabet and hashing | `runtime/src/telegram/protocol.ts` |
| `GatewayTransport`, `DirectBotTransport` | `runtime/src/telegram/transport.ts` |
| Codes, verification, the link | `runtime/src/telegram/pairing.ts` |
| The gates and the commands | `runtime/src/telegram/commands.ts` |
| Notifier, gas and daily-loss watchers | `runtime/src/telegram/notifications.ts` |
| The facade the composition root wires | `runtime/src/telegram/service.ts` |
| `/api/v1/telegram/*` | `runtime/src/http/routes/telegram.ts` |
| Schema | `runtime/src/db/migrations/004_telegram.sql` |
| The wire protocol | `docs/specs/telegram-protocol.md` |
| The gateway | `gateway/`, `gateway/README.md` |
| The skill | `skills/telegram/SKILL.md` |
