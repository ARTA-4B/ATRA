---
name: telegram
description: How the Telegram remote control works — pairing with the official bot, what each command may and may not do, how the runtime verifies every message on its own, and how notifications are kept quiet.
phase: 4
---

# Telegram

## The rule this skill exists to state

**Telegram can look, pause, resume and stop. It can never sign, export,
withdraw, change limits, go LIVE or clear an emergency stop.**

The list of things it cannot do is enforced in the runtime, not by the bot:
the command router has no path to a signer, an execution adapter, the vault,
the withdrawal service or the risk policy store, and it answers every
export-or-withdraw word with the same fixed refusal. The gateway filters too,
but the gateway is a server; the runtime is the process holding the keys and
it trusts nothing it is told.

## Two transports, one interface

| | Gateway (supported) | Direct bot (self-hosted) |
|---|---|---|
| Configure | `ATRA_GATEWAY_URL` + `ATRA_GATEWAY_TOKEN` | `ATRA_TELEGRAM_BOT_TOKEN` (+ optional `ATRA_TELEGRAM_BOT_USERNAME`) |
| Bot token | on the gateway; never distributed | in the operator's own environment |
| Link | runtime dials out over WebSocket (`atra.v1`), heartbeats every 30 s, reconnects with backoff | long-polls `getUpdates` (25 s) with a persisted offset |
| `/pair` | verified by the gateway, recorded by the runtime | verified by the runtime |
| Nothing set | `POST /api/v1/telegram/pair` → `409 TELEGRAM_NOT_CONFIGURED`; everything else reports "not configured" | |

Both hand every command to the same router and send the same plain text.
Selection is gateway → direct → none; `ATRA_MODE=ci` never opens either.

## Pairing

1. Dashboard: `POST /api/v1/telegram/pair` → a code like `K7ZQ-4MWD` (CSPRNG,
   alphabet without 0/1/O/I, 40 bits), shown once, valid 5 minutes. The
   database keeps only `sha256(code)`.
2. Operator sends `/pair K7ZQ-4MWD` to the bot.
3. Verification is one atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now`.
   A code works exactly once. Issuing a new code retires every older unused one.
4. The Telegram identity (user id, chat id, display name — public ids, not
   credentials) is written to the singleton `telegram_link` row. That row,
   and nothing else, decides who may command this runtime.
5. Dashboard polls `GET /api/v1/telegram/pair/{code}` until `confirmed`.

Unpair from the dashboard deletes the row and tells the gateway to drop its
side. On every gateway `welcome` the runtime compares the two sides and fails
closed on any disagreement (different user → revoke; gateway paired but
runtime not → revoke; runtime paired but gateway not → drop local link).

## Every message walks the same gates

```
replay (update id must advance, per chat, persisted)
  → age (≤ 120 s old, ≤ 60 s in the future)
    → identity (user id AND chat id equal the stored link; else one generic
      "not paired" reply, ≤ 3 per 10 min per stranger, nothing changes)
      → rate limits (20/min per user; 5/min for /pause /resume /emergency;
        5 /pair attempts per 10 min)
        → the command
```

Every message writes a row to the append-only `telegram_commands` table
(command word + outcome, never the text) and an audit row in category
`telegram` with actor `telegram:******789` (last three digits of the user id).

## Commands

| Command | Does |
|---|---|
| `/status` | mode, pause, emergency, uptime, scheduler, chains, model (`UNTRAINED` / `UNAVAILABLE`), transport state |
| `/portfolio`, `/positions` | ledger marked at cross-checked prices; an unpriced position is **unknown** and so are the totals that depend on it |
| `/trades` | last 5 trade rows with status and rejection code |
| `/lp` | the LP engine's summary, or "LP not available" |
| `/risk` | policy limits and today's usage as a % of each limit |
| `/pause` / `/resume` | `StateStore.setGlobalPause(…, "telegram")`; `/resume` refuses while the emergency stop is engaged |
| `/emergency` → `/emergency CONFIRM` within 60 s | `StateStore.setEmergencyStop(true, …, "telegram")`: one row, no model, no network; LIVE drops to PAPER and the scheduler is disarmed by the existing hook |
| `/emergency clear` (any spelling) | refused: clearing needs the dashboard and re-authentication |
| `/alerts on\|off\|status` | the notification master switch |
| `/export`, `/withdraw`, `/key`, `/seed`, … | fixed refusal, audited |

Replies are plain text (no parse mode), ≤ 3500 characters, addresses
shortened, and every one passes through the same secret scrubber the logger
uses before it leaves the process.

## Notifications

`TelegramService.notify({ kind, chain?, summary, detail?, correlationId?, dedupeKey?, rejectionCode? })`.

Kinds: `trade.filled | trade.rejected | trade.failed | lp.filled | lp.rebalanced |
lp.exited | risk.dailyLossNear | gas.low | emergency.engaged | emergency.cleared |
runtime.online | runtime.offline | paused | resumed`.

Kept quiet by, in order: unpaired → `/alerts off` → the dashboard's category
toggle → 1-hour dedupe → 10-minute cooldown per rejection code (the next
message says how many were swallowed) → 30 messages per hour. Failures are
logged and recorded, never thrown into the trading path. `GasWatcher` checks
`readBalances().gasLow` every 10 minutes; `DailyLossWatcher` warns once per
UTC day at 80 % of `maxDailyLossUsd`.

## Secrets

Tokens are read from the environment at the composition root
(`readTelegramSecrets()`), handed to the transport, and held nowhere else:
not on the config object, not in the database, not in a frame, reply, audit
row, notification or log line. The test suite constructs the service with
both tokens set, runs every command with a real logger capturing every line,
and asserts that neither token appears anywhere.

## Where things live

- `runtime/src/telegram/protocol.ts` — frame codec, pair-code alphabet and hashing
- `runtime/src/telegram/transport.ts` — `GatewayTransport`, `DirectBotTransport`
- `runtime/src/telegram/pairing.ts` — codes, verification, the link
- `runtime/src/telegram/commands.ts` — the gates and the commands
- `runtime/src/telegram/notifications.ts` — notifier, gas and daily-loss watchers
- `runtime/src/telegram/service.ts` — the facade the composition root wires
- `runtime/src/http/routes/telegram.ts` — `/api/v1/telegram/*`
- `docs/specs/telegram-protocol.md` — the wire protocol for the gateway engineer

## What this skill does not do

- It does not run the gateway. That is `gateway/`, a Cloudflare Worker.
- It does not claim delivery. A notification's outcome is recorded; whether
  Telegram showed it to a human is not something the runtime can know.
