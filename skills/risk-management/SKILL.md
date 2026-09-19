---
name: risk-management
description: The deterministic limits that govern every action, how they are checked, and why the reasoning model cannot override them.
phase: 1
---

# Risk management

## The rule this skill exists to state

**The model proposes. Deterministic code decides.**

A language model produces a structured proposal. That proposal is validated
against a schema, simulated, and then evaluated by a pure function that reads
only the policy, the proposal, the runtime state and a dated market snapshot. A
rejection is final. There is no confidence score, no urgency argument and no
prompt that changes the answer, because the model is not consulted at that step
at all.

## The policy

The operator's limits, stored locally and validated on every read. An invalid
policy is a hard failure: ATRA refuses to run rather than fall back to
something more permissive.

### Sizing and loss

| Field | Meaning |
|---|---|
| `maxAmountPerTradeUsd` | Largest single trade. |
| `maxDailyLossUsd` | Ceiling on the day's drawdown, checked *before* a trade. |
| `maxTotalDeployedUsd` | Largest total capital at risk at once. |
| `maxTransactionFeeUsd` | Largest acceptable fee for one transaction. |
| `minLiquidityUsd` | Smallest market ATRA will trade into. |

### Execution quality

| Field | Meaning |
|---|---|
| `maxSlippageBps` | Worst acceptable slippage, in basis points. |
| `maxPriceImpactBps` | Worst acceptable price impact from the quote. |

### Pacing

| Field | Meaning |
|---|---|
| `cooldownSeconds` | Minimum gap between actions in the same market. |
| `globalMinIntervalSeconds` | Minimum gap between any two actions. |

### Freshness

Every input carries a timestamp and a maximum age: prices, quotes, balances,
liquidity, fee estimates, and the proposal itself. A missing input is treated
as infinitely stale. A timestamp from the future beyond the allowed clock skew
is also refused — it means a broken clock or a forged snapshot.

### Allowlists

- `tokenAllowlist` — per chain. A token that is not listed cannot be traded,
  however good the opportunity looks.
- `protocolAllowlist` — per chain, protocol key to contract identifiers. An
  approval may only name a spender explicitly listed under `approveSpenders`.

There is no generic "call this contract" path anywhere in ATRA. A protocol that
is not implemented as a named adapter cannot be executed against.

### Switches

- `globalPause` — no new actions; existing positions are untouched.
- `emergencyStop` — see `skills/emergency-exit/SKILL.md`.

## Defaults for a fresh install

Deliberately small. A first-time operator should discover ATRA's limits by
hitting them in PAPER mode, not by losing money in LIVE mode.

| Limit | Default |
|---|---|
| Max per trade | $25 |
| Max daily loss | $50 |
| Max total deployed | $250 |
| Max fee | $2 |
| Min liquidity | $250,000 |
| Max slippage | 50 bps |
| Max price impact | 100 bps |
| Cooldown | 15 minutes per market |
| Global interval | 60 seconds |
| LP automation | disabled (`maxCapitalPerLpUsd: "0"`, no allowed pools) |

PAPER and LIVE use the same numbers, so paper results predict live behaviour.

## How a decision is made

Checks run in a fixed order and **every** check is reported, including the ones
that passed, so the dashboard shows the whole picture rather than the first
problem.

1. **Tier 0 — validity and stops.** Policy valid, proposal valid, token decimals
   agree with the allowlist, idempotency key correct, emergency stop clear,
   not paused, mode matches, LIVE activated. A failure here short-circuits:
   nothing below is meaningful under an active emergency stop.
2. **Chain enabled.**
3. **Freshness** of every input.
4. **Allowlists**: token in, token out, protocol, contract. On Solana every
   top-level program in the built transaction is checked, not just the entry
   point.
5. **Position check** for reduce-only actions, against the ledger.
6. **Size, daily loss, total deployed.**
7. **Slippage, price impact, fee.**
8. **Liquidity.**
9. **Cooldowns.**
10. **Balances**, including enough native token for gas.

The rejection code is the first failed check in that order.

### Rejection codes

`SCHEMA_INVALID`, `EMERGENCY_STOP`, `GLOBAL_PAUSE`, `LIVE_NOT_ACTIVATED`,
`MODE_MISMATCH`, `CHAIN_UNSUPPORTED`, `DATA_STALE`, `TOKEN_NOT_ALLOWLISTED`,
`PROTOCOL_NOT_ALLOWLISTED`, `CONTRACT_UNKNOWN`, `REDUCE_ONLY_MISMATCH`,
`SIZE_EXCEEDS_MAX_TRADE`, `DAILY_LOSS_BREACHED`, `TOTAL_DEPLOYED_BREACHED`,
`SLIPPAGE_EXCEEDS_MAX`, `FEE_EXCEEDS_MAX`, `LIQUIDITY_BELOW_MIN`,
`COOLDOWN_ACTIVE`, `BALANCE_INSUFFICIENT`, `DUPLICATE_ACTION`.

## Why exits are treated differently

A `reduceOnly` action can only lower exposure. The checks that exist to *cap*
exposure — size, total deployed, daily loss, cooldowns — would otherwise trap
an operator in a losing position after a limit was hit. So those are skipped
for exits.

Exits still enforce allowlists, slippage, fee, liquidity and balances, and the
`reduceOnly` flag is verified against the ledger. The model cannot smuggle an
entry through the exit door by labelling it a close.

## Arithmetic

All money arithmetic is integer, at fixed scale: micro-USD for values,
atto-USD for prices, base units for amounts. No floating point touches a
number that represents money.

Rounding always works **against the trade**: values that could breach a maximum
round up, values that could breach a minimum round down. A rounding error can
therefore only make ATRA more conservative.

## What the model is trained to do

Recognise the limits and stop before them — propose `NO_ACTION` when data is
stale, evidence is thin or an action would obviously breach a limit. That makes
the system quieter and cheaper, not safer: the safety comes from the
deterministic engine, which does not care what the model concluded.

## Related

- `skills/emergency-exit/SKILL.md`
- `skills/wallet/SKILL.md`
- `docs/specs/risk-engine-spec.md` — the full check list and test vectors
