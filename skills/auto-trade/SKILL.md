---
name: auto-trade
description: How one trading cycle runs from research to execution, what each stage may and may not do, and how paper and live execution differ.
phase: 3
---

# Auto-trade

## The rule this skill exists to state

**Every trade walks the same path, and the model is only one stop on it.**

```
research ──> trader decides ──> proposal built ──> risk engine ──> executor
   │              │                   │                │              │
facts only   NO_ACTION is        deterministic     the only        PAPER sim
             the default         sizing/quoting    authority       or LIVE sign
```

No stage can skip the next. There is no route, flag, prompt or configuration
that hands a model's output to a signer. The executor acts only on a trade row
in the `allowed` state, and only the risk gate writes that state.

## The stages

### 1. Research (`agents/research`)

Reads market data through the cross-checked market layer and produces
**facts** (sourced, dated, aged) and, separately, **interpretation**. A fact
the model did not receive cannot appear in the interpretation; invented
numbers are stripped and reported. Research is allowed while paused; it is
read-only.

### 2. Decision (`agents/trader`)

The trader agent receives the research, the portfolio marked at current
prices, the policy limits and the allowlist, and returns exactly one of:

| Action | Meaning |
|---|---|
| `NO_ACTION` | The default. Data stale, thin, disputed, or no edge worth the fee. |
| `OPEN` | Buy an allowlisted token with the chain's stablecoin. |
| `SWAP` | Same path as `OPEN`; kept distinct for the audit trail. |
| `REDUCE` | Sell part of an open position back into the stablecoin. |
| `CLOSE` | Sell all of it. |

The reply is schema-validated. A reply that does not parse is `NO_ACTION`
with the parse failure as its reason — never a best-effort reading of what
the model meant. A well-formed reply that contradicts its input (a chain it
was not asked about, a token not on the allowlist, a size above the per-trade
cap, a `REDUCE` of nothing) is overridden to `NO_ACTION` and recorded as a
model failure, not as a market condition.

The model is **UNTRAINED** in this build. It is whatever the operator points
the runtime at; the dashboard says so on every decision.

### 3. Proposal (`trading/proposal`)

Deterministic code turns the decision into the action the engine evaluates:

- exact base-unit amounts, computed with integer arithmetic from the
  cross-checked USD price (a disputed or missing price ends the cycle here);
- the funding token — the allowlisted stablecoin with the largest balance in
  the current mode;
- a live quote from the chain's execution adapter, with `minAmountOut` at the
  policy's slippage, the contract (and, on Solana, every top-level program)
  the transaction will target, and the fee estimate;
- balances from the paper ledger (PAPER) or the chain (LIVE);
- the deepest pool's liquidity for the pair;
- an idempotency key derived from what the action *does*.

Native-coin legs are not supported: the routers here trade token pairs, and a
wrap would be a second transaction the engine has not seen.

### 4. Risk engine (`risk/gate`, `risk/engine`)

The pure evaluation from Phase 1, now fed by real stores: switches, LIVE
activation, cooldowns and the ledger. Thirty-three checks in a fixed order;
the first failure names the rule. A repeat of the same intent within 24 hours
is `DUPLICATE_ACTION` and never executes, even if the first was allowed.
Every decision is persisted with the exact action and snapshot it saw.

Cooldowns start when an allowed action is **dispatched**, not when it is
allowed: an allowed-but-never-executed action does not lock a market. An
ERC-20 approval starts no cooldown; it precedes the swap it enables.

### 5. Execution

**PAPER** (`execution/paper`): no chain is touched. The fill is the quote's
expected output minus half the slippage tolerance plus 5 bps — deliberately
worse than a perfect fill. The fee is charged at the current native price as
realized loss. Everything is recorded with `simulated = true` and no
transaction hash. Paper balances are seeded by the operator and never
inferred from a real wallet.

**LIVE** (`execution/live`), in this order and no other:

1. refuse unless the runtime is LIVE, unpaused, unstopped, vault unlocked;
2. simulate on the chain — a revert here costs nothing;
3. build the transaction and fetch nonce and fee caps;
4. sign inside the vault's synchronous callback (the key exists in memory for
   one ECDSA or ed25519 operation);
5. **write the hash to the trade row before anything is sent**;
6. broadcast; poll for the receipt for a bounded time;
7. book the fill from what the chain reports — ERC-20 `Transfer` logs to the
   wallet or Solana pre/post token balances — never from the quote.

On EVM chains the router must first be allowed to pull the input token. The
pipeline checks the allowance and, when short, routes an **exact-amount**
`approve` through the risk engine as its own action with its own fee and
contract checks, executes it, waits for confirmation, and only then proposes
the swap. Never unlimited.

## Recovery

A trade row that was `signed` or `broadcast` when the process died names its
transaction hash. On the next start, before the scheduler is armed, the
executor asks the chain what happened to each such row and settles it. A row
that was `dispatched` but never reached the signer is failed. Nothing is
re-signed. Prices at fill time are unknown after a restart, so a reconciled
fill is booked with the chain-reported amount and an audit row saying the
valuation is missing — not with a guessed price.

## Chains

| Chain | Execution adapter | Notes |
|---|---|---|
| Solana | Jupiter v6 (`lite-api.jup.ag`) | Aggregated routing; every top-level program reported before signing. |
| BNB Smart Chain | PancakeSwap v2 router | `getAmountsOut` / `swapExactTokensForTokens`. |
| Base | Aerodrome v2 router | Same shape, Aerodrome route dialect. |
| Robinhood Chain | **none** | Only DEX is Uniswap v4; the Universal Router path is not implemented. Observable, not tradeable. The trader returns `NO_ACTION` for it with that reason. |

Every router address comes from the registry. An adapter cannot be constructed
for an address the registry does not know.

## The scheduler

Off by default; a stored setting, not a process flag, so a container restart
cannot turn it on. When enabled it walks the watchlist every N seconds
(60–86,400) and runs one cycle per entry, sequentially. It checks the pause
and emergency switches before each run and between entries. An emergency stop
disables it outright; the operator re-enables it deliberately after clearing
the stop.

## What the dashboard sees

`GET /api/v1/trading` — positions, the last 50 risk decisions, the cycle
status and which chains can execute. `POST /api/v1/trading/run` runs one
cycle now through the same path. There is no "execute this trade" route.

## What this skill does not do

- It does not manage liquidity positions (Phase 4).
- It does not send Telegram notifications (Phase 4).
- It does not claim any performance. No cycle has run against real funds in
  the course of building this, and no figure in this repository says
  otherwise.
