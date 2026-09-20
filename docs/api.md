# Runtime API

Written for: the dashboard developer wiring the UI to the runtime.

Base URL in production: same origin as the dashboard (the runtime serves both).
In development the Vite dev server proxies `/api` and `/health` to
`http://127.0.0.1:3000`.

This documents what is **implemented**, not what is planned. Phase 5 routes
(settings) and SSE events are not listed because they do not exist yet. The
full intended contract is in
[`specs/dashboard-api-contract.md`](specs/dashboard-api-contract.md).

---

## Conventions

### Every request that changes state needs two things

```
x-atra-client: atra-dashboard
cookie: atra_session=…          (set by /auth/setup or /auth/login)
```

The header is a CSRF defence: a cross-origin form cannot set it. Requests
without it get `403 FORBIDDEN_ORIGIN`.

### Every success is an envelope

```json
{
  "data": …,
  "meta": {
    "source": "rpc | provider | local | cache | none",
    "asOf": "2026-09-20T03:00:00.000Z | null",
    "stale": false,
    "mode": "PAPER | LIVE | NONE",
    "requestId": "uuid",
    "reason": "present when a value is missing or stale",
    "nextCursor": "present on paginated lists"
  }
}
```

`source: 'none'` with a `reason` means ATRA does not know. Render it as
unavailable. It is never zero in disguise.

### Every error is a problem document

```json
{
  "type": "https://atra.local/errors/unauthenticated",
  "title": "Unauthenticated",
  "status": 401,
  "detail": "Sign in to continue",
  "code": "UNAUTHENTICATED",
  "requestId": "uuid",
  "errors": [{ "path": "password", "message": "must be at least 12 characters" }]
}
```

`code` is stable. `errors[]` is present on `422 SCHEMA_INVALID` and maps to
form fields.

| Code | Status | Meaning |
|---|---|---|
| `SETUP_REQUIRED` | 401 | No password yet; run setup |
| `UNAUTHENTICATED` | 401 | No or expired session |
| `INVALID_CREDENTIALS` | 401 | Wrong password |
| `VAULT_LOCKED` | 401 | Session valid but vault auto-locked; re-authenticate |
| `REAUTH_REQUIRED` | 403 | Needs an `x-atra-reauth` token |
| `REAUTH_INVALID` | 403 | Token used, expired, or for another purpose |
| `FORBIDDEN_ORIGIN` | 403 | CSRF / host check failed |
| `LOOPBACK_ONLY` | 403 | Must be called from the machine itself |
| `LIVE_ACTIVATION_INCOMPLETE` | 403 | Checklist not complete |
| `SCHEMA_INVALID` | 422 | Body failed validation; see `errors[]` |
| `ALREADY_INITIALIZED` / `CONFLICT` | 409 | Already done |
| `TELEGRAM_NOT_CONFIGURED` | 409 | No Telegram transport is configured; see [Telegram](#telegram) |
| `NOT_FOUND` | 404 | |
| `CHAIN_UNSUPPORTED` | 503 | Not one of the four chains |
| `UPSTREAM_UNAVAILABLE` / `UPSTREAM_TIMEOUT` | 503 / 504 | RPC or provider failed |
| `RATE_LIMITED` | 429 | Has `retryAfterSec` |

### Sensitive actions need a re-authentication token

1. `POST /api/v1/auth/reauth` with `{ password, purpose }` → `{ token, expiresAt }`
2. Send it as `x-atra-reauth: <token>` on the sensitive request.

Tokens are single-use, expire in 5 minutes, and are bound to the purpose and
the session. Purposes: `wallet.export`, `wallet.withdraw`, `mode.live`,
`auth.password`, `settings.reset`, `settings.secret`.

---

## Unauthenticated

| Route | Returns |
|---|---|
| `GET /health` | `{ status, uptimeSec, mode, runtimeMode, database, version }` — plain JSON, no envelope |
| `GET /ready` | 200 when setup is complete, 503 with `{ setupRequired: true }` otherwise |
| `GET /api/v1/meta` | `{ name, version, setupRequired, passwordSet, mode, supportedChains[], enabledChains[], modelStatus: "UNTRAINED" }` |
| `GET /api/v1/auth/session` | `{ authenticated, expiresAt, vaultUnlocked, setupRequired }` |

## Setup and auth

| Route | Body | Notes |
|---|---|---|
| `POST /api/v1/auth/setup` | `{ password }` | Loopback only. Sets password, creates vault, returns session cookie. 201. |
| `POST /api/v1/auth/login` | `{ password }` | Returns session cookie, unlocks vault |
| `POST /api/v1/auth/logout` | — | Revokes session, locks vault |
| `POST /api/v1/auth/reauth` | `{ password, purpose }` | `{ token, expiresAt, header }` |
| `POST /api/v1/auth/password` | `{ currentPassword, newPassword }` + reauth `auth.password` | Rewraps vault, revokes all sessions |
| `GET /api/v1/setup` | — | `{ completed, steps: { passwordSet, vaultCreated, walletsCreated, chainsSelected, riskConfigured }, installation, wallets[] }` |
| `POST /api/v1/setup/wallets` | — | Loopback + session. Creates both wallets; idempotent. Returns addresses only. 201. |
| `POST /api/v1/setup/complete` | `{ name?, chains[], risk?: { maxAmountPerTradeUsd?, maxDailyLossUsd?, maxTotalDeployedUsd? }, paperAcknowledged: true }` | Seeds the risk policy; runtime stays PAPER |

Password minimum is 12 characters. There are no composition rules.

## Overview and status

| Route | Returns |
|---|---|
| `GET /api/v1/status` | `{ runtime: { status: "running|paused|stopped", uptimeSec, startedAt, runtimeMode }, mode, activation, switches, installation, chains: ChainHealth[], agents[], model: { name, status: "UNTRAINED", endpoint } }` |
| `GET /api/v1/overview` | `{ mode, switches, wallets[], balances[], portfolio: { totalValueUsd: null, reason }, warnings[], recentActivity[] }` |

`balances[].native` is `null` with `error` set when a chain could not be read.
`portfolio.totalValueUsd` is still `null`: pricing is not wired to wallet
balances in this build (Phase 4 did not change that). `warnings[]` includes
`gasLow` per chain.

`chains[]` entries: `{ chain, healthy, height, latencyMs, endpoint, error, identity, identityMatches }`.

## Wallet

| Route | Returns / Body |
|---|---|
| `GET /api/v1/wallet` | `{ wallets: [{ family, address, chains[], createdAt }], vaultUnlocked }` |
| `GET /api/v1/wallet/deposit-address` | `[{ chain, address, nativeSymbol, explorerUrl, warning }]` — one per enabled chain |
| `GET /api/v1/wallet/balances?chain=` | `[{ chain, address, native: { symbol, decimals, amount } \| null, tokens: [{ address, symbol, decimals, amount }], observedAt, source, error, gasLow }]` |
| `GET /api/v1/wallet/transactions?limit=` | `WithdrawResult[]` — operator withdrawals, newest first |
| `GET /api/v1/wallet/transactions/:txId` | one withdrawal, re-read from the chain if still `submitted` |
| `POST /api/v1/wallet/withdraw/quote` | `{ chainId, asset: "USDC"\|"ETH"\|"BNB"\|"SOL", destination, amount: "<decimal>"\|"all" }` → `WithdrawQuote` |
| `POST /api/v1/wallet/withdraw` | `{ quoteId, ack: true, confirmation?: "WITHDRAW" }` + reauth `wallet.withdraw` (+ `Idempotency-Key`) → `WithdrawResult`, 202 |
| `POST /api/v1/wallet/export` | `{ format, keystorePassword?, confirmation: "EXPORT" }` + reauth `wallet.export`; loopback only |

Amounts are **base-unit strings** (wei, lamports, token base units). Convert
with `decimals` for display; never parse to float for arithmetic.

Export formats: `evm-private-key`, `evm-keystore` (needs `keystorePassword`,
≥12 chars), `solana-id-json`, `solana-base58`. Response:
`{ format, address, material, warning }`. Show `warning` before `material`.

### Withdrawals

Withdrawals are the operator moving their own funds. They do **not** go
through the risk engine and they work in PAPER mode and under emergency stop.

`WithdrawQuote`:

```json
{
  "quoteId": "…", "expiresAt": "…", "chainId": "base", "asset": "USDC", "destination": "0x…",
  "amount": { "raw": "25000000", "decimals": 6, "formatted": "25", "symbol": "USDC" },
  "availableBalance": { … } | null,
  "fee": { "native": { … } | null, "usd": 0.06 | null, "source": "chain-rpc" | "none" },
  "remainingBalance": { … } | null,
  "requiresTypedConfirmation": false,
  "warnings": [],
  "mode": "PAPER",
  "submittable": true
}
```

Rules the server enforces:

- quotes expire after **90 s** and are consumed on use;
- `requiresTypedConfirmation` is true for `"all"`, for ≥ 1,000 USD, and when
  the USD value is unknown; then `confirmation` must be exactly `WITHDRAW`
  (422 otherwise);
- `submittable: false` (fee unknown, balance short) → submit is 409;
- EVM destinations: 40 hex, not the zero address, EIP-55 checksum enforced
  when mixed-case; Solana: base58 32-byte key; the agent wallet itself is
  refused;
- the transaction hash is written to the local record **before** broadcast.

`WithdrawResult`: `{ txId, txHash, status: "submitted"|"confirmed"|"failed", explorerUrl, activityId }`.

## Risk

| Route | Body | Returns |
|---|---|---|
| `GET /api/v1/risk` | — | `{ policy, hash, version }` or `data: null` with `source: 'none'` before setup |
| `PUT /api/v1/risk` | the whole policy object | validated atomically; 422 with `errors[]` leaves the old policy in force |

Policy shape: see `runtime/src/risk/policy.ts`. Money fields are decimal
strings (`"25"`, `"0.5"`), percentages are basis points (integers),
allowlists are per chain.

## Control

| Route | Body / header | Effect |
|---|---|---|
| `POST /api/v1/control/pause` | `{ reason? }` | `globalPause = true` |
| `POST /api/v1/control/resume` | — | 409 if emergency stop is engaged |
| `POST /api/v1/control/emergency-stop` | `{ reason }` | Engages; reverts LIVE → PAPER. **No reauth needed.** |
| `POST /api/v1/control/emergency-stop/clear` | reauth `mode.live` | |
| `GET /api/v1/control/activation` | — | `{ mode, activation: { acknowledged, reauthenticated, riskReviewed, walletFunded, gasChecked, adapterChecked, activatedAt, missing[] } }` |
| `POST /api/v1/control/activation/step` | `{ step }` | Records one checklist step |
| `POST /api/v1/control/mode/live` | reauth `mode.live` | 403 `LIVE_ACTIVATION_INCOMPLETE` unless `missing` is empty |
| `POST /api/v1/control/mode/paper` | — | Always allowed |

## Activity

| Route | Query | Returns |
|---|---|---|
| `GET /api/v1/activity` | `limit`, `before` (id cursor), `category`, `chain`, `status` | `[{ id, eventId, ts, category, action, status, chain, actor, mode, summary, detail }]`, `meta.nextCursor` |
| `GET /api/v1/activity/:eventId` | | one event |

Categories: `setup auth wallet risk mode control trade liquidity market research telegram system`.
Statuses: `ok rejected failed pending hold`. `hold` is the trader's
`NO_ACTION` and the Liquidity Manager's `HOLD`: the agent looked and chose
not to act.

## Market

| Route | Query / body | Returns |
|---|---|---|
| `GET /api/v1/market/providers` | — | `{ providers: [{ source, healthy, latencyMs, error, chains[] }], configured[], model: { name, kind, status, available, detail } }` |
| `GET /api/v1/market?chain=&token=` | | pools for a token, deepest first |
| `GET /api/v1/market?q=&chain=` | | search |
| `GET /api/v1/market` | | the watchlist resolved to live snapshots |
| `GET /api/v1/market/:chain/:poolId?timeframe=1h` | | `{ pool, history: { timeframe, candles[], source } \| null, historyReason }` |
| `POST /api/v1/market/research` | `{ chain, token? \| poolId?, includeHistory? }` | a `ResearchResult` |
| `GET /api/v1/market/research/history?limit=` | | persisted results |
| `GET /api/v1/watchlist` | | rows |
| `POST /api/v1/watchlist` | `{ chain, poolId, label }` | 201 |
| `DELETE /api/v1/watchlist/:chain/:poolId` | | |

Market row shape:

```json
{
  "chain": "robinhood", "poolId": "0x52e6…", "dex": "uniswap", "pair": "WETH/USDG",
  "base": { "address", "symbol", "name", "decimals": null },
  "quote": { … },
  "priceUsd": "2646.50", "liquidityUsd": "24171411.77", "volume24hUsd": "…",
  "change24hBps": 125, "source": "dexscreener",
  "observedAt": "…", "freshnessMs": 30, "reason": null
}
```

`decimals` is `null` from market providers; the chain adapter is
authoritative for decimals.

Research result:

```json
{
  "id", "createdAt", "chain", "poolId", "token",
  "status": "OK | INSUFFICIENT_DATA | ERROR",
  "facts": [{ "key", "value", "source", "observedAt", "ageMs", "stale" }],
  "interpretation": ["…"],
  "staleInputs": ["…"],
  "sources": ["dexscreener", "geckoterminal"],
  "model": "none", "modelStatus": "UNTRAINED | TRAINED | UNAVAILABLE",
  "hallucinatedValues": [],
  "summary": "…"
}
```

Render `facts` and `interpretation` as separate sections. Never merge them.
Show `modelStatus` — it is `UNAVAILABLE` when no model is configured and
`UNTRAINED` when one is.

---

## Trading

The dashboard **observes** trading. There is no route that executes a trade
from a token and an amount; the only operator action is "run a cycle now",
which walks the same research → decide → gate → execute path as the scheduler.

| Route | Body | Returns |
|---|---|---|
| `GET /api/v1/trading` | — | `{ status: { enabled, paused, running, lastCycleAt, lastCycleStatus, nextCycleAt, intervalSeconds }, positions[], decisions[], execution[], modelStatus: "UNTRAINED" }` |
| `GET /api/v1/trading/positions` | — | `[{ id, mode, chain, chainName, token, symbol, size: { raw, decimals, formatted, symbol }, costBasisUsd, status: "SIMULATED"\|"LIVE", source, openedAt, updatedAt }]` for the current mode |
| `GET /api/v1/trading/decisions?limit=` | — | `[{ actionId, decisionCycleId, chain, kind, mode, allowed, code, reason, createdAt }]` newest first |
| `GET /api/v1/trading/decisions/:actionId` | — | the full `RiskDecision`: every check with observed/limit, derived values |
| `GET /api/v1/trading/trades?limit=&status=` | — | trade rows (`proposed → rejected \| allowed → dispatched → signed → broadcast → filled \| failed \| cancelled`) |
| `GET /api/v1/trading/trades/:tradeId` | — | one trade row |
| `GET /api/v1/trading/execution` | — | `[{ chain, executable, protocol, reason }]` — Robinhood Chain is `executable: false` with the reason |
| `POST /api/v1/trading/run` | `{ chain, token? \| poolId? }` | `CycleReport`, 202; 409 while paused, stopped, or a cycle is running |
| `GET /api/v1/trading/scheduler` | — | `{ enabled, intervalSeconds, running, lastCycleId, lastCycleAt, lastCycleStatus, nextRunAt }` |
| `PUT /api/v1/trading/scheduler` | `{ enabled, intervalSeconds: 60..86400 }` | same; 409 when enabling under emergency stop |
| `GET /api/v1/trading/paper-balances` | — | `[{ chain, token, decimals, amount, symbol, formatted }]` |
| `PUT /api/v1/trading/paper-balances` | `{ chain, token, amount: "<base units>" }` | seeds a paper balance; token must be in the registry |

`CycleReport`:

```json
{
  "cycleId": "…", "chain": "base", "mode": "PAPER", "startedAt": "…", "finishedAt": "…",
  "outcome": "blocked | skipped | no_action | rejected | filled | failed",
  "reason": "…",
  "research": { "id": "…", "status": "OK" } | null,
  "decision": { "action": "NO_ACTION", "chain": "base", "market": "…", "reason": "…", "confidence": 0.9, "requestedNotionalUsd": "0", "evidence": [], "token": null } | null,
  "modelStatus": "UNTRAINED | UNAVAILABLE" | null,
  "trade": { "tradeId": "…", "actionId": "…" } | null,
  "risk": { "allowed": false, "code": "SIZE_EXCEEDS_MAX_TRADE", "reason": "…" } | null,
  "execution": { "actionId": "…", "mode": "PAPER", "status": "filled | failed", "amountOut": "…", "feeUsd": "…", "txHash": null, "error": null, "filledAt": 0 } | null,
  "notes": ["tokenIn price 1 USD via dexscreener+geckoterminal", "…"]
}
```

Positions in PAPER mode are `SIMULATED` and carry `source: "paper-sim"`. A
LIVE position carries `source: "chain"`. Show the difference.

Every cycle writes audit rows correlated by `cycleId`: `trade.decision`
(`hold` for NO ACTION), `risk.allowed` / `risk.rejected` with the failing
rule, `trade.signed`, `trade.filled` / `trade.failed`, and a closing
`trade.cycle`. `GET /api/v1/activity` shows them.

---

## Liquidity

The dashboard **observes** liquidity management, exactly as it observes
trading. There is no route that takes a pool and an amount and adds
liquidity: actions are proposed by the Liquidity Manager and gated by the
risk engine, and the only operator action is "run a cycle now", which walks
the same read → decide → build → gate → execute path as the scheduler.
Every route needs a session; the writes need the `x-atra-client` header.

| Route | Body | Returns |
|---|---|---|
| `GET /api/v1/liquidity` | — | `LiquidityView` (below): summary, positions for the current mode, the last 50 actions, protocols, adapters, example pools, automation |
| `GET /api/v1/liquidity/positions` | — | `LpPositionView[]` for the current mode |
| `GET /api/v1/liquidity/actions?limit=` | — | `LpActionView[]` newest first across **both** modes (each row carries `mode`; the view's `actions` are the current mode only), `limit` clamped to 1..500 (default 50) |
| `GET /api/v1/liquidity/adapters` | — | `{ adapters: [{ chain, available, protocol, reason }], protocols: [{ id, name, chains[] }] }` — Solana and Robinhood Chain are `available: false` with the reason |
| `POST /api/v1/liquidity/run` | `{ chain, poolId }` | `LpCycleReport`, 202; 409 while paused, under emergency stop, or while a cycle or scheduled pass is running |
| `GET /api/v1/liquidity/automation` | — | `LpAutomationView` |
| `PUT /api/v1/liquidity/automation` | `{ enabled, intervalSeconds: 60..86400 }` | `LpAutomationView`; 409 when enabling under an emergency stop |

`LiquidityView`:

```json
{
  "summary": {
    "totalValueUsd": "0.000000" | null,
    "activePositions": 0,
    "unclaimedFeesUsd": "0.000000" | null,
    "requiresAttention": 0,
    "reason": "1 position(s) not yet observed by a cycle"
  },
  "positions": [
    {
      "id": "…", "pool": "WETH/USDC", "poolId": "0xcdac…5c43", "chain": "Base", "chainId": "base",
      "protocol": "aerodrome-v2", "mode": "PAPER",
      "valueUsd": "19.980000" | null, "capitalUsd": "20.000000", "unrealizedUsd": "-0.020000" | null,
      "range": null,
      "feesUsd": "0.000000" | null, "feesNote": "fee accrual is not simulated in PAPER",
      "lpTokens": "190881115445",
      "amounts": {
        "token0": { "address": "0x4200…0006", "symbol": "WETH", "amount": "3805175039258298", "decimals": 18 },
        "token1": { "address": "0x8335…2913", "symbol": "USDC", "amount": "10000000", "decimals": 6 }
      },
      "lastAction": "ADD", "lastActionAt": "…", "lastRebalanceAt": null,
      "rebalance": { "today": 0, "max": 4, "nextEligibleAt": null },
      "status": "SIMULATED" | "ACTIVE", "source": "paper-sim" | "chain",
      "openedAt": "…", "markedAt": "…" | null
    }
  ],
  "actions": [
    {
      "id": "…", "at": "…", "pool": "WETH/USDC", "poolId": "0xcdac…5c43", "chain": "Base", "chainId": "base",
      "protocol": "aerodrome-v2", "mode": "PAPER",
      "action": "HOLD" | "ADD" | "REMOVE" | "REBALANCE" | "COLLECT FEES" | "EXIT",
      "status": "hold" | "rejected" | "filled" | "failed",
      "note": "…", "txHash": null, "lpTokens": "…" | null, "feeUsd": "…" | null, "capitalUsd": "…" | null,
      "activityId": "<cycle id; every audit row of the cycle has it as correlationId>"
    }
  ],
  "supportedProtocols": [
    { "id": "aerodrome-v2", "name": "Aerodrome v2", "chains": ["base"] },
    { "id": "pancakeswap-v2", "name": "PancakeSwap v2", "chains": ["bsc"] }
  ],
  "adapters": [
    { "chain": "base", "available": true, "protocol": "aerodrome-v2", "reason": "aerodrome-v2 adapter" },
    { "chain": "solana", "available": false, "protocol": null, "reason": "Solana has no LP adapter in this build: …" }
  ],
  "verifiedExamplePools": [
    { "chain": "base", "protocol": "aerodrome-v2", "poolId": "0xcdac0d6c6c59727a65f871236188350531885c43", "label": "Aerodrome vAMM-WETH/USDC (volatile)" },
    { "chain": "bsc", "protocol": "pancakeswap-v2", "poolId": "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae", "label": "PancakeSwap v2 USDT/WBNB" }
  ],
  "automation": {
    "enabled": false, "intervalSeconds": 1800, "running": false, "paused": false,
    "nextRunAt": null, "lastCycleAt": null, "lastCycleStatus": null
  },
  "modelStatus": "UNTRAINED"
}
```

Rules for rendering it:

- `summary.totalValueUsd` and `unclaimedFeesUsd` are `null` when any
  position could not be valued, and `summary.reason` says which. Never
  add up what is there and show it as a total.
- A position's `valueUsd`, `feesUsd` and `unrealizedUsd` are `null` until a
  cycle has observed it (`markedAt` says when). `feesNote` explains a `null`
  or a zero: PancakeSwap fees compound into the reserves, PAPER does not
  simulate accrual.
- `range` is `null` on every position in this build (v2 pools have no
  range). `requiresAttention` counts positions whose value or fees are
  unknown, and out-of-range ones.
- `status: "SIMULATED"` / `source: "paper-sim"` is a paper position;
  `ACTIVE` / `chain` is real. Show the difference.
- `adapters[].reason` is the text to show on a chain that cannot manage
  liquidity. `verifiedExamplePools` are addresses that were verified on
  chain; they are **not** in the policy until the operator lists them.
- The default policy lists no pools and caps LP capital at zero, so every
  cycle ends `rejected` or `hold` until the operator edits `risk.lp`.

`LpCycleReport` (from `POST /run`):

```json
{
  "cycleId": "…", "chain": "base", "poolId": "0xcdac…5c43", "mode": "PAPER", "startedAt": "…", "finishedAt": "…",
  "outcome": "blocked | skipped | hold | rejected | filled | failed",
  "reason": "…",
  "decision": { "action": "ADD_LIQUIDITY", "chain": "base", "poolId": "…", "capitalUsd": "20", "reason": "…", "confidence": 0.8, "evidence": ["…"] } | null,
  "modelStatus": "UNTRAINED | UNAVAILABLE" | null,
  "trade": { "tradeId": "…", "actionId": "…" } | null,
  "risk": { "allowed": false, "code": "POOL_NOT_ALLOWLISTED", "reason": "…" } | null,
  "execution": { "actionId": "…", "mode": "PAPER", "status": "filled | failed", "lpTokens": "…" | null, "amount0": "…" | null, "amount1": "…" | null, "feeUsd": "…", "txHash": null, "error": null, "filledAt": 0 } | null,
  "position": <LpPositionRecord> | null,
  "notes": ["pool 0xcdac… WETH/USDC reserves …", "token0 price 2500 USD via …", "…"]
}
```

`outcome` meanings: `blocked` — a switch or a missing policy stopped the
cycle before anything was read; `skipped` — the chain is not enabled, has no
adapter, the pool could not be read, or the proposal could not be built (the
`reason` says which); `hold` — the agent chose `HOLD`; `rejected` — the risk
engine refused (`risk.code`); `filled` / `failed` — the executor's result.

Every cycle writes audit rows correlated by `cycleId`: `liquidity.decision`
(`hold` for HOLD), `liquidity.proposal` (`hold`, when a build fails),
`risk.allowed` / `risk.rejected` with the failing rule, and in LIVE
`liquidity.signed` and `liquidity.broadcast`, then `liquidity.filled` /
`liquidity.failed`, and a closing `liquidity.cycle`. `GET /api/v1/activity`
shows them. The LP trade rows (`kind: lp_add | lp_remove | lp_claim`, and
the `approve` rows that precede them in LIVE) appear in
`GET /api/v1/trading/trades` like any other.

## Telegram

The dashboard side of pairing and notification settings. Nothing here sends
a message or runs a command: Telegram reaches the runtime through the
transport (the official gateway over WebSocket, or the operator's own bot by
long polling), never through this HTTP surface. Every route needs a session;
the writes need the `x-atra-client` header.

| Route | Body | Returns |
|---|---|---|
| `GET /api/v1/telegram` | — | `TelegramView` |
| `POST /api/v1/telegram/pair` | `{}` | `PairCode`, 201; `409 TELEGRAM_NOT_CONFIGURED` when no transport is configured |
| `GET /api/v1/telegram/pair/:code` | — | `{ status: "pending" \| "confirmed" \| "expired" }`; `422 SCHEMA_INVALID` when `code` cannot be a code |
| `POST /api/v1/telegram/unpair` | `{}` | `TelegramView` |
| `PUT /api/v1/telegram/notifications` | `Partial<{ riskRejections, tradeDecisions, liquidityUpdates, runtimeAlerts }>` (booleans, no other keys) | `TelegramView` |
| `PATCH /api/v1/telegram/notifications` | same | same — `PATCH` per the dashboard contract, `PUT` kept for symmetry |

`TelegramView`:

```json
{
  "configured": false,
  "paired": false,
  "botUrl": "https://t.me/<bot-username>" | null,
  "botUsername": "<bot-username>" | null,
  "account": { "displayName": "Rizky", "userIdMasked": "******789", "pairedAt": "…" } | null,
  "installation": "<installation name>",
  "notifications": { "riskRejections": true, "tradeDecisions": true, "liquidityUpdates": true, "runtimeAlerts": true },
  "transport": "gateway" | "direct" | null,
  "connected": false,
  "alertsEnabled": true
}
```

`transport`, `connected` and `alertsEnabled` are additive to the contract's
`TelegramView`: which transport is in use, whether it is up right now, and
the master switch the operator toggles with `/alerts on|off`. `account`
carries public Telegram identifiers only — a display name and a masked user
id (last three digits). No phone number, no token, ever.

`PairCode`:

```json
{ "code": "K7ZQ-4MWD", "command": "/pair K7ZQ-4MWD", "expiresAt": "…", "botUrl": "https://t.me/<bot-username>" | null }
```

The pairing flow:

1. `POST /api/v1/telegram/pair`. Without a transport (`ATRA_GATEWAY_URL` +
   `ATRA_GATEWAY_TOKEN`, or `ATRA_TELEGRAM_BOT_TOKEN`) this is
   `409 TELEGRAM_NOT_CONFIGURED`: the runtime does not hand out a code that
   could never be redeemed. Otherwise a code like `K7ZQ-4MWD` (alphabet
   without `0/1/O/I`) is shown **once**; the runtime keeps only its
   `sha256`. It expires at `expiresAt`, five minutes after issue, is single
   use, and issuing a new one retires every older unused code.
2. The operator opens `botUrl` and sends `command` to the bot.
3. Poll `GET /api/v1/telegram/pair/:code` (the contract says every 3 s).
   `pending` until the bot confirms, then `confirmed`. Unknown codes read as
   `expired`, deliberately: there is nothing to learn from probing them.
   The code may be sent lower-case or without the dash.
4. `GET /api/v1/telegram` now has `paired: true` and `account` set.

`POST /unpair` deletes the link, retires unused codes and tells the gateway
to drop its side. The notification toggles are per category; `alertsEnabled`
is the master switch and is only changed from Telegram. Delivery is never
reported by this API: a notification's outcome is recorded in the audit log,
but whether Telegram showed it to a human is not something the runtime can
know.

What Telegram can and cannot do is enforced in the runtime, not by the bot:
`/status /portfolio /positions /trades /lp /risk /pause /resume /alerts
/emergency /help` work; export, withdrawal, key and seed words get one fixed
refusal; clearing an emergency stop needs the dashboard and re-authentication.
`skills/telegram/SKILL.md` has the whole surface.

## Not yet implemented

Settings, SSE events. Calling either returns `404 NOT_FOUND`. Do not mock
them as working. The dashboard contract's `PATCH /api/v1/telegram/notifications`
and `GET /api/v1/liquidity` exist as documented above; the contract's SSE
`telegram` event for pairing confirmation does not, so poll.
