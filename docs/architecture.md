# Architecture

Written for: an engineer who needs to know which file owns which decision
before changing anything. Every box below names the file that implements it.
State of the tree on 2026-09-20; Phase 5 work (gateway proxies, treasury) is
marked where it is still landing.

## The one rule

**The model proposes. Deterministic code decides. Only the vault signs.**

There is no code path from a model's output to a signer that does not pass
through the risk engine, and there is no endpoint that accepts calldata or a
raw transaction. Everything else in this document is the consequence of
that rule.

## The runtime, layer by layer

```
                         ┌────────────────────────────────────────────────┐
                         │  Local dashboard (Vite, repo root src/)        │
                         │  and the operator's Telegram (see below)       │
                         └───────────────┬────────────────────────────────┘
                                         │ HTTP, loopback only
                                         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ HTTP layer             runtime/src/http/server.ts                          │
│   middleware           runtime/src/http/middleware.ts  (host, CSRF, local) │
│   routes               runtime/src/http/routes/*.ts   (one file per area)  │
│   envelope/problems    runtime/src/http/respond.ts                         │
├───────────────────────────────────────────────────────────────────────────┤
│ Composition root       runtime/src/core/services.ts   (builds everything)  │
│ Switches and mode      runtime/src/core/state.ts      (PAPER/LIVE, stop)   │
│ Auth and sessions      runtime/src/core/auth.ts                            │
│ Audit trail            runtime/src/audit/audit.ts     (append-only)        │
│ Database               runtime/src/db/database.ts + migrations/*.sql       │
└───────────────────────────────────────────────────────────────────────────┘

                    The five-step path every action walks

  1. RESEARCH            2. DECISION             3. PROPOSAL
  agents/research/       agents/trader/agent.ts  trading/proposal.ts
  agent.ts               agents/liquidity-       liquidity/proposal.ts
  facts with source,     manager/agent.ts        integer sizing, live quote,
  age, and separately    NO_ACTION / HOLD is     contracts to be touched,
  interpretation         the default; schema-    fee estimate, dated
                         validated; overridden   snapshot, idempotency key
        │                on contradiction              │
        └──────────────────────┬───────────────────────┘
                               ▼
  4. RISK ENGINE                                5. EXECUTOR
  risk/engine.ts   pure function, no model,      execution/paper.ts   PAPER swap
                   no clock, no network          execution/live.ts    LIVE swap
  risk/gate.ts     persists the decision,        liquidity/paper.ts   PAPER LP
                   idempotency, cooldowns        liquidity/live.ts    LIVE LP
  risk/policy.ts   the operator's limits              │
  risk/money.ts    integer money math                 │ only an `allowed`
  risk/store.ts    policy persistence                 │ trade row gets here
                               │                      ▼
                               │            wallet/service.ts useSigningKey()
                               │            wallet/vault.ts   (the only path
                               │                               to a key)
                               ▼                      │
                     trading/trades.ts                ▼
                     (state machine)       execution/{evm,solana}/signer.ts
                     trading/ledger.ts     execution/evm/v2-router.ts
                     (positions, fills)    execution/solana/jupiter.ts
                                           liquidity/evm/v2-pool.ts
                                                      │
                                                      ▼
                                           chains/evm/adapter.ts
                                           chains/solana/adapter.ts
                                           chains/registry.ts (the four chains,
                                           tokens, routers; nothing else exists)
```

### Orchestration around the path

| Box | File | What it owns |
|---|---|---|
| Auto-trade pipeline | `runtime/src/trading/pipeline.ts` | Runs steps 1 to 5 for one market; handles the ERC-20 approval as its own risk-checked action; writes every ending to the audit log |
| Auto-trade scheduler | `runtime/src/trading/scheduler.ts` | Off by default; a stored setting; walks the watchlist; disarmed by the emergency stop |
| LP pipeline and scheduler | `runtime/src/liquidity/pipeline.ts`, `scheduler.ts`, `service.ts` | The same shape for liquidity positions |
| LP store | `runtime/src/liquidity/store.ts` | `lp_positions`, append-only `lp_actions` |
| Market layer | `runtime/src/market/service.ts`, `providers/dexscreener.ts`, `providers/geckoterminal.ts` | Two keyless providers, median price, `disputed` past 200 bps, age on every snapshot |
| LLM abstraction | `runtime/src/llm/provider.ts` | Structured output only; refuses a prompt containing key material; the null provider says it has no answer |
| Withdrawals | `runtime/src/wallet/withdrawal.ts` | Operator-only transfers; re-auth, typed confirmation, hash recorded before broadcast; not routed through the risk engine because they are the operator's own money, not an agent action |
| Logging | `runtime/src/logging/logger.ts`, `redact.ts` | Every log object and audit detail passes the redactor |
| Configuration | `runtime/src/config/env.ts` | Environment only; secrets are read at the composition root and never stored on the config object |
| Errors | `runtime/src/util/errors.ts` | `AppError(ErrorCode, message, { errors, details })` everywhere |

### What talks to what

- Routes call services; services never import routes.
- The risk engine (`risk/engine.ts`) imports the registry, the policy types
  and the money helpers. It does not import the model, the market layer, the
  database or the clock; its inputs are a dated snapshot assembled by the
  gate.
- The executors import the wallet service, never the vault directly, and the
  wallet service is the only importer of `vault.useSecret` for signing.
- `core/services.ts` is the only file that constructs anything with I/O.
  Tests build the same graph against `:memory:` with fake adapters.

## Telegram

```
   operator's phone ──Telegram──▶ gateway (Cloudflare Worker) ──WebSocket──▶ runtime
                                  gateway/src/webhook.ts     (runtime dials out)
                                  gateway/src/hub.ts                    │
              or, self-hosted:                                          ▼
   operator's phone ──Telegram──▶ operator's own bot token ──long poll──▶ runtime

   runtime side, both transports:
     telegram/transport.ts   GatewayTransport, DirectBotTransport
     telegram/pairing.ts     codes (sha256 only), the single telegram_link row
     telegram/commands.ts    replay, age, identity, rate limits, then the command
     telegram/notifications.ts  notifier, gas and daily-loss watchers
     telegram/service.ts     the facade services.ts wires
     http/routes/telegram.ts /api/v1/telegram/*
```

The command router has no import of the vault, the executors, the withdrawal
service or the policy store. Telegram can look, pause, resume and engage the
emergency stop; the rest is refused with a fixed reply. Details:
[telegram.md](telegram.md).

## The hosted gateway

`gateway/` is a separate pnpm project: one Worker (`src/index.ts`), a
hibernating-WebSocket Durable Object (`src/hub.ts`), D1 tables of hashes and
ids only (`migrations/`). It never sees a key, a vault password or a
provider key; there is no frame or endpoint that could carry one. It is
**not deployed** on 2026-09-20. Its owner is extending it in Phase 5 with an
RPC proxy, a market cache, an inference endpoint and per-install quotas
(`src/rpc.ts`, `src/market.ts`, `src/inference.ts`, `src/quota.ts` are in the
tree, untracked, as this is written); `gateway/README.md` is authoritative
for whatever is committed.

The runtime does not need the gateway. Without it the runtime uses public
RPC, the two keyless market providers and whatever model the operator runs.

## The treasury (Phase 5, in progress)

`runtime/src/treasury/`, `runtime/src/agents/treasury/`,
`runtime/src/http/routes/treasury.ts` and migration `005_treasury.sql` are
landing in this tree as this document is written. The design rule they
implement, stated in the migration itself: the treasury wallet is
**watch-only**, no table references `vault_secrets`, the runtime cannot sign
for it by construction, and nothing in the treasury reads the ledger, trades,
LP or wallet tables. Treasury funds and user funds never mix. Its own
document is [treasury.md](treasury.md).

## The model pipeline

`model/atra-4b/` builds a synthetic dataset, fine-tunes Qwen3-4B with QLoRA,
and evaluates the result against eight metrics whose calibration is checked
in CI (an oracle must score 1.0, a null model must fail). It produces files
the operator serves with Ollama; the runtime only ever talks to an HTTP
endpoint (`llm/provider.ts`). Status and run log: [model-training.md](model-training.md).

## Persistence

One SQLite file, `atra.db`, opened through `node:sqlite` (no native addon)
in WAL mode with `synchronous = FULL`. Migrations are numbered SQL files
applied in order; a new one is added, an old one is never edited. Tables that
record a decision or a fill (`audit_events`, `action_decisions`, `fills`,
`lp_actions`, `telegram_commands`, treasury expenses and proposals) carry
triggers that reject `UPDATE` and `DELETE`. Money is text: base-unit integers
or decimal USD strings, never a float.

The vault lives inside the same file: `vault_header` (the wrapped
data-encryption key) and `vault_secrets` (per-secret ciphertext bound by AAD
to its row). Backing up `atra.db` backs up the wallet; the wallet is useless
without the dashboard password. See [wallet-recovery.md](wallet-recovery.md).

## Boot and shutdown

`runtime/src/index.ts`: load config, construct services, start the HTTP
server, then `startBackgroundServices`: reconcile in-flight trades by hash
(nothing is re-signed), arm the trade scheduler if the stored setting is on,
start the LP service, start Telegram. On SIGTERM: lock the vault first, stop
the transports, close the server, write `runtime.stopped`, checkpoint and
close the database, exit 0; a 10-second timer forces exit 1 if anything
hangs. A process that was LIVE comes back in PAPER (`state.ts`,
`#demoteOnBoot`).

Known defect on 2026-09-20, recorded in the Phase 4 report and not yet fixed:
the swap reconcile runs before the LP reconcile at boot and settles LP rows
without booking the LP position.

## Where the boundaries are enforced

| Boundary | Enforced in |
|---|---|
| Model never sees a key | `llm/provider.ts` refuses prompts containing key material; prompts are built from allowlisted fields |
| Model cannot sign or broadcast | no import path: agents return JSON; `useSigningKey` has exactly three callers: `execution/live.ts` and `liquidity/live.ts` (only for a trade row the gate marked `allowed`) and `wallet/withdrawal.ts` (an operator action behind re-authentication) |
| No arbitrary contract call | `execution/types.ts` and `liquidity/types.ts` have no `call(to, data)`; adapters are constructed only for registry addresses; the engine checks the contract and, on Solana, every top-level program |
| PAPER by default, LIVE deliberate | `core/state.ts`: created as PAPER, six timestamped steps within 10 minutes, re-auth, 12-hour session, demoted on restart, policy change and emergency stop |
| Emergency stop without the model | `core/state.ts` writes `runtime_state`; the engine, the executors, the schedulers and Telegram read it; hooks disarm the schedulers |
| Keys never in logs or audit rows | `logging/redact.ts` on every log object and audit detail; tests assert a real key never appears |
| Treasury and user funds never mix | migration `005_treasury.sql`: no reference to `vault_secrets` or the wallet and ledger tables |
