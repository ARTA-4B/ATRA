# ATRA Telegram protocol

| Field | Value |
|---|---|
| Spec ID | `telegram-protocol` |
| Version | 1.0.0 (2026-09-20) |
| Status | IMPLEMENTED in `runtime/src/telegram/` (runtime side); gateway side per this document |
| Owner | runtime (`C:\ATRA\runtime`), gateway (`C:\ATRA\gateway`), dashboard (`C:\ATRA\src`) |
| Audience | the gateway engineer (§2–§4), the dashboard engineer (§6), anyone reviewing the security model (§5) |

Telegram is a remote control with a small, closed set of commands. It can read
status, pause, resume and engage the emergency stop. It cannot export a key,
withdraw funds, change the risk policy, switch the runtime to LIVE or clear an
emergency stop. Every one of those needs the local dashboard and a
re-authentication, and the runtime refuses them over Telegram with a fixed
reply regardless of what the gateway forwards.

Two transports exist behind one interface:

| Transport | Selected when | Bot token lives | Pairing verified by |
|---|---|---|---|
| **Gateway** (supported path) | `ATRA_GATEWAY_URL` + `ATRA_GATEWAY_TOKEN` are set | on the gateway only; never distributed | the gateway (atomic, single use); the runtime records the result |
| **Direct bot** (self-hosted fallback) | no gateway URL, `ATRA_TELEGRAM_BOT_TOKEN` set | in the operator's environment only | the runtime, locally |
| none | neither | — | `POST /api/v1/telegram/pair` → `409 TELEGRAM_NOT_CONFIGURED` |

`ATRA_MODE=ci` never opens a transport.

---

## 1. Actors and trust

```
 Telegram user ──/cmd──> Telegram ──webhook──> Gateway (Cloudflare Worker + Hub DO)
                                                  │  WebSocket, atra.v1, outbound from the runtime
                                                  ▼
                                               Runtime (holds keys, decides everything)
```

- The **gateway** owns the project bot token, receives webhooks, answers
  `/start`, `/help` and `/pair CODE` itself, and forwards every other command
  from the *linked* Telegram user to the *linked* installation. It never sees
  or stores the runtime's private keys, passwords or provider API keys, and it
  never forwards wallet-export or withdrawal commands (the runtime refuses
  them anyway).
- The **runtime** treats every frame from the gateway as a claim, not a fact.
  It re-checks the Telegram identity against its own `telegram_link` row,
  enforces update-id monotonicity and message age, rate limits, and audits.
  The gateway is a server; the runtime is the thing holding the money.
- The **dashboard** talks only to the runtime (§6). It never talks to the
  gateway or to Telegram.

---

## 2. Wire protocol (runtime ↔ gateway)

**Transport.** WebSocket. The runtime connects outbound to
`GET {ATRA_GATEWAY_URL}/v1/ws` (http→ws, https→wss; query and fragment
dropped) with:

```
Authorization: Bearer <installation token>
Sec-WebSocket-Protocol: atra.v1
```

Text frames only. Binary frames are ignored.

**Heartbeat.** The runtime sends the literal text frame `ping` every 30 s and
expects the literal text frame `pong`. The gateway uses the Durable Object's
`setWebSocketAutoResponse("ping" → "pong")` so hibernation is not broken. If
the runtime receives `ping` it answers `pong`. Three consecutive unanswered
pings (i.e. the fourth tick finds three missed) → the runtime closes the
socket (code 4002) and reconnects with exponential backoff: 1 s doubling to a
60 s cap, ±25 % jitter, reset to zero on the next `welcome`. A connection that
does not reach `welcome` within 20 s is closed (code 4001) and retried.

**Frame envelope.** Every JSON frame:

```json
{ "v": 1, "type": "<string>", "id": "<uuid per frame>", "ts": <epoch ms>, ...payload }
```

`payload` fields are spread at the top level (not nested). Unknown `type`
values are ignored by the runtime, so the gateway may add frame types without
breaking older runtimes. A known type that fails validation is ignored and
logged.

### 2.1 Runtime → Gateway

| `type` | Payload | When |
|---|---|---|
| `hello` | `{ installationId: string, runtimeVersion: string, capabilities: ["telegram"] }` | First frame after the socket opens. `installationId` is `"pending-setup"` before first-run setup. |
| `pair.offer` | `{ codeHash: string, expiresAt: epoch ms }` | The dashboard issued a code. `codeHash` = lowercase hex `sha256(code with the dash removed, upper-case)`, e.g. `sha256("ABCD2345")`. Re-sent after every `welcome` while a code is still pending and the runtime is unpaired. |
| `pair.revoke` | `{}` | Operator unpaired from the dashboard, or the runtime found the gateway's link inconsistent with its own (§5.2). Gateway deletes the Telegram link and any unused codes. |
| `reply` | `{ requestId: string, text: string }` | Answer to a `command`. Plain text, ≤ 4000 chars; the gateway sends it to the paired chat with **no parse mode**. |
| `notify` | `{ kind: string, text: string }` | Unsolicited message to the paired chat. Ignored by the gateway when unpaired. `kind` is one of §4.3. |

### 2.2 Gateway → Runtime

| `type` | Payload | When |
|---|---|---|
| `welcome` | `{ paired: boolean, telegram: { userId: number, chatId: number, displayName: string } \| null, botUsername: string }` | Right after `hello`. The runtime is not "connected" until it arrives. |
| `paired` | `{ telegram: { userId, chatId, displayName }, pairedAt: epoch ms }` | A `/pair CODE` matched an offered `codeHash`. The runtime consumes its pending code and stores the identity. |
| `unpaired` | `{ reason: string }` | The gateway dropped the link (e.g. a Telegram-side `/unpair`, if the gateway offers one). The runtime clears its link. |
| `command` | `{ requestId: string, updateId: number, telegram: { userId, chatId, displayName }, text: string, receivedAt: epoch ms }` | A command from the linked user. The gateway waits up to 8 s for a `reply` with the same `requestId`; otherwise it tells the chat "ATRA runtime is offline or not responding". |
| `error` | `{ requestId?: string, code: string, message: string }` | Informational. Logged by the runtime, never acted on. |

`telegram.userId` and `chatId` are numbers (Telegram ids); a frame carrying
them as strings is rejected by the runtime's schema.

### 2.3 Gateway behaviour the runtime relies on

- `/start`, `/help` and `/pair CODE` are answered by the gateway; every other
  command from the linked user is forwarded.
- An **unlinked** Telegram user gets exactly one generic message — *"This bot
  is not paired with an ATRA installation. Generate a code in your dashboard
  and send /pair CODE."* — and is rate limited. Nothing about which
  installations exist is revealed.
- Pair code format `^[A-Z2-9]{4}-[A-Z2-9]{4}$`, 5-minute TTL, single use.
  The gateway hashes `/pair CODE` the same way (strip the dash, upper-case,
  sha256, lowercase hex) and matches an offered hash **atomically**: the same
  code can never pair twice, and an expired offer never matches. Matching
  replaces any previous link for that installation and for that Telegram user.
- The gateway never forwards `/export`, `/withdraw` and their synonyms. The
  runtime refuses them too (§3).

---

## 3. Command reference

Commands are case-insensitive; a `@botname` suffix is stripped. Replies are
plain text, at most 3500 characters, addresses shortened (`0x1234…abcd`),
never a secret, never a private key, never a provider key.

| Command | Reply | Side effect |
|---|---|---|
| `/start` | Installation name + pointer to `/help` | — |
| `/help` | Command list, plus what is *not* available here | — |
| `/pair CODE` | Gateway transport: answered by the gateway. Direct transport: verifies the code locally; generic failure text on any error | Direct: writes `telegram_link` |
| `/status` | mode, paused, emergency stop, uptime, scheduler (on/off, interval, next run, last cycle), enabled chains, model status (`UNTRAINED` when an endpoint answers, `UNAVAILABLE` otherwise), transport + connected | — |
| `/portfolio` | `LedgerService.mark` for the current mode at cross-checked prices: count, value, deployed, unrealized, realized today, then one line per position. A position without an undisputed price is **unknown**, and the totals that depend on it are **unknown** — never a guess | — |
| `/positions` | The position lines only | — |
| `/trades` | The last 5 rows of `TradeStore.list`, with mode, chain, pair, USD size and status (rejections carry the code) | — |
| `/lp` | `LiquiditySummary.summary()` when wired, else "LP not available in this build." | — |
| `/risk` | Policy limits (per trade, daily loss, deployed cap, fee, slippage, price impact, min liquidity, cooldowns, chains) and today's usage (daily loss and deployed, each as a % of its limit), pause and emergency state | — |
| `/pause` | "Automation paused." (or "already paused") | `StateStore.setGlobalPause(true, reason, "telegram")` |
| `/resume` | "Automation resumed." / "not paused" / refusal while the emergency stop is engaged | `StateStore.setGlobalPause(false, null, "telegram")` — never clears an emergency stop |
| `/emergency` | The 60-second challenge: what the stop does, and "send `/emergency CONFIRM`" | Opens a challenge bound to this user |
| `/emergency CONFIRM` | "EMERGENCY STOP ENGAGED …" when a live challenge exists, else "No pending emergency challenge" | `StateStore.setEmergencyStop(true, reason, "telegram")` — one DB row, no model, no network; drops LIVE to PAPER and disarms the scheduler through the existing hook |
| `/emergency clear` (also `off`, `reset`, `resume`) | "Clearing the emergency stop requires the local dashboard and re-authentication." | none |
| `/alerts` / `/alerts status` | master switch state + the four category toggles | — |
| `/alerts on` / `/alerts off` | same, after switching | `telegram_state.alerts_enabled` |
| `/export`, `/withdraw`, `/withdrawal`, `/send`, `/transfer`, `/sweep`, `/key`, `/keys`, `/privatekey`, `/private_key`, `/seed`, `/mnemonic`, `/backup`, `/keystore` | "Not available over Telegram. Wallet export and withdrawals are done in the local dashboard, with re-authentication." | audit `telegram.refused` |
| anything else | "Unknown command. Send /help for the list." | — |
| plain text | "Send /help for the list of commands." | — |

Every accepted, refused or dropped message writes one row to the append-only
`telegram_commands` table (command word and outcome, never the message text)
and, except for silently dropped floods, one audit row in category `telegram`
with actor `telegram:<userId masked to its last 3 digits>`.

---

## 4. Security model

### 4.1 Gates, in order

Every inbound command walks these gates; the first failure ends it.

1. **Replay.** `updateId` must be strictly greater than the highest seen for
   that `chatId` (`telegram_chat_cursor`, persisted). A replay is dropped
   silently and audited as `telegram.replay`.
2. **Age.** `receivedAt` older than 120 s, or more than 60 s in the future, is
   dropped silently and audited as `telegram.stale`.
3. **Identity.** `userId` **and** `chatId` must equal the stored
   `telegram_link` row. Anything else — including a user the gateway claims is
   linked — gets the generic unpaired reply, at most 3 replies per 10 minutes
   per foreign user (audited as `telegram.unauthorized` while replying, logged
   afterwards), and changes nothing. The reply does not reveal whether the
   installation is paired with someone else.
4. **Rate limits.** 20 commands per minute per user; 5 per minute for the
   control commands `/pause`, `/resume`, `/emergency`; 5 `/pair` attempts per
   10 minutes per user (direct transport). The first denial in a streak gets a
   "Too many …" reply; the rest are silent.
5. **The command itself** (§3).

### 4.2 Pairing

- The dashboard issues a code from a CSPRNG over the 32-symbol alphabet
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (5 bits per symbol, no modulo bias; 40
  bits per code). The database stores only `sha256(code)`, `expires_at`
  (5 minutes), `used_at`, `invalidated_at`.
- Issuing a new code invalidates every older unused one: exactly one code can
  succeed at any moment.
- Verification is one `UPDATE … SET used_at = now WHERE code_hash = ? AND
  used_at IS NULL AND invalidated_at IS NULL AND expires_at > now`; `changes = 1`
  is the only success. Expired, superseded, used, unknown and malformed codes
  all produce the same reply to the user; the distinction goes to the audit
  log only.
- On the gateway transport the gateway verifies and the runtime records the
  `paired` frame; on the direct transport the runtime verifies. Both write the
  same singleton `telegram_link` row (`user_id`, `chat_id`, `display_name`,
  `transport`, `paired_at`).
- Unpairing from the dashboard deletes the row, retires unused codes and sends
  `pair.revoke`.

### 4.3 Reconciliation on `welcome` (gateway transport)

The runtime's own row is authoritative. On every `welcome`:

| Runtime | Gateway says | Action |
|---|---|---|
| paired with U | paired with U | nothing |
| paired with U | paired with V ≠ U | drop local link; send `pair.revoke` |
| paired with U | unpaired | drop local link (audited) |
| unpaired | paired with anyone | send `pair.revoke` (the runtime has no record of that user; they must pair again) |
| unpaired, pending code | unpaired | re-send `pair.offer` |

Failing closed here costs the operator one `/pair`; trusting the gateway would
cost them the ability to say who may command their runtime.

### 4.4 Secrets

- The bot token (direct) and the installation token (gateway) are read from
  the environment by `readTelegramSecrets()` at the composition root, handed
  to the transport, and held in a private field. They are **not** on the
  `RuntimeConfig` object, not in the database, not in any frame, reply, audit
  row or notification.
- Every error string the direct transport logs is scrubbed of the token first
  (the token is part of every Bot API URL); the logger's deep redactor and the
  `tg-token` value pattern are the second and third lines.
- Every reply and notification passes through `finalize()`, which caps the
  length and runs the same secret scrubber the logger uses.
- A test constructs the service with both tokens set, drives every command,
  captures every log line through the production redactor, and asserts that
  neither token appears in replies, audit rows, notifications, the view, the
  transport status, the `telegram_commands` rows or the logs.

### 4.5 What Telegram can never do

- Sign or broadcast anything. No path from `runtime/src/telegram/` reaches a
  signer, an execution adapter or `WalletService.useSigningKey`.
- Export a key or withdraw. Fixed refusal (§3).
- Change the risk policy, switch to LIVE, or clear an emergency stop.
- Bypass the risk engine: `/pause`, `/resume` and `/emergency` write the same
  `runtime_state` row the dashboard writes; the engine reads it on every
  decision.

---

## 5. Notifications

Emitted through `TelegramService.notify(event)`; the composition root wires
the sources (state hooks, the pipeline's cycle report, the LP engine, the gas
and daily-loss watchers).

| `kind` | Dashboard category | Source |
|---|---|---|
| `trade.filled`, `trade.failed` | `tradeDecisions` | pipeline cycle report |
| `trade.rejected` | `riskRejections` | pipeline cycle report (carries the rejection code) |
| `lp.filled`, `lp.rebalanced`, `lp.exited` | `liquidityUpdates` | LP engine |
| `risk.dailyLossNear` | `runtimeAlerts` | `DailyLossWatcher`: once per UTC day at 80 % of `maxDailyLossUsd` |
| `gas.low` | `runtimeAlerts` | `GasWatcher`: every 10 min via `WalletService.readBalances(...).gasLow`, deduplicated per chain for an hour |
| `emergency.engaged`, `emergency.cleared` | `runtimeAlerts` | `StateStore.onEmergencyStop` |
| `paused`, `resumed` | `runtimeAlerts` | `StateStore.onPauseChanged` |
| `runtime.online` | `runtimeAlerts` | transport connected (deduplicated for an hour, so a flapping link does not spam) |
| `runtime.offline` | `runtimeAlerts` | `stop()`, best-effort with a 2 s budget on SIGTERM |

Anti-spam, in order: nothing while unpaired → master switch (`/alerts`) →
category toggle → 1-hour dedupe by key → `trade.rejected` cooldown of 10 min
per rejection code (the next message says how many were swallowed) → global
cap of 30 messages per hour. Slots are reserved before the send and returned
on failure. The last 100 outcomes are kept in memory (`TelegramService.status().recent`).

Message text: line 1 `[ATRA <MODE>] <title> — <chain>`, then the summary,
then the detail, then the suppressed count. Plain text, no parse mode.

---

## 6. Dashboard API

All routes: session cookie required; writes need `X-ATRA-Client: atra-dashboard`
and pass the host/origin guards. Bodies are `{ data, meta }` envelopes; errors
are problem+json.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/telegram` | — | `TelegramView` |
| POST | `/api/v1/telegram/pair` | `{}` | `201 PairCode`; `409 TELEGRAM_NOT_CONFIGURED` when no transport |
| GET | `/api/v1/telegram/pair/{code}` | — | `{ status: 'pending' \| 'confirmed' \| 'expired' }`; `422` for a code that cannot match the format. Unknown codes read as `expired`. Poll every 3 s. |
| POST | `/api/v1/telegram/unpair` | `{}` | `TelegramView` |
| PUT or PATCH | `/api/v1/telegram/notifications` | `Partial<{ riskRejections, tradeDecisions, liquidityUpdates, runtimeAlerts }>` (unknown keys → 422) | `TelegramView` |

```ts
interface TelegramView {
  configured: boolean; paired: boolean; botUrl: string | null; botUsername: string | null;
  account: { displayName: string; userIdMasked: string; pairedAt: IsoDate } | null;
  installation: string;
  notifications: { riskRejections: boolean; tradeDecisions: boolean; liquidityUpdates: boolean; runtimeAlerts: boolean };
  // additive, beyond the contract:
  transport: 'gateway' | 'direct' | null;
  connected: boolean;       // gateway welcomed / direct polling; show "reconnecting" when false but configured
  alertsEnabled: boolean;   // the /alerts master switch
}
interface PairCode { code: string; command: string; expiresAt: IsoDate; botUrl: string | null }
```

`botUrl` is `https://t.me/<username>` from the gateway's `welcome` or from
`ATRA_TELEGRAM_BOT_USERNAME`; `null` when neither is known. `userIdMasked`
keeps the last three digits (`******789`).

UI notes: show the code once, large, with the `command` string copyable; poll
`/pair/{code}` and flip to "paired" on `confirmed`; when `configured` is true
but `connected` is false, warn that the code will be offered when the gateway
reconnects. The emergency stop cannot be cleared from Telegram, so the
"clear" control stays where it is (control page, re-auth).

---

## 7. Environment

```
# Transport A: the official gateway (supported)
ATRA_GATEWAY_URL=https://gateway.example      # http(s) or ws(s); /v1/ws is appended
ATRA_GATEWAY_TOKEN=<installation token>       # required when the URL is set; never logged

# Transport B: your own bot (fallback; used only when no gateway URL is set)
ATRA_TELEGRAM_BOT_TOKEN=<token from BotFather> # never logged, never stored
ATRA_TELEGRAM_BOT_USERNAME=my_atra_bot         # optional; for the dashboard link
```

A gateway URL without a token fails `loadConfig` with a field error, at boot.

---

## 8. Tables (migration `004_telegram.sql`)

| Table | Purpose | Mutability |
|---|---|---|
| `telegram_pair_codes` | `code_hash`, `transport`, `expires_at`, `used_at`, `invalidated_at` | state machine; single-use by atomic UPDATE |
| `telegram_link` | singleton identity | replaced on re-pair, deleted on unpair |
| `telegram_chat_cursor` | highest `update_id` per chat | monotonic |
| `telegram_state` | notification toggles, master switch, direct-poll offset, daily-loss warned day | mutable settings |
| `telegram_commands` | every message: command word + outcome | **append-only** (triggers) |

No table holds a token, a code in clear, or message text.
