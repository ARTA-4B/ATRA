# Phase 3 report

**Date:** 2026-09-20
**Scope:** Trader Agent, execution engine (paper and live), ledger, auto-trade pipeline and scheduler, withdrawals, restart recovery.

Written for: an engineer picking this repository up, and anyone asking whether ATRA can trade and whether it has.

---

## The short version

ATRA can now run a complete trading cycle — research, decision, deterministic
proposal, risk evaluation, execution — in paper mode against real market data,
and has every piece needed to do the same in live mode: transaction building
for three chains, synchronous signing inside the vault, hash-before-broadcast
recording, chain-reported fills and restart reconciliation.

**No live trade has been executed.** No real funds were used in building or
verifying this phase. Every live-path component was verified against mainnet
up to, but not including, signing: quotes, transaction builds, fee and nonce
reads, simulations. The signing and broadcast paths are verified by tests with
fake chains and by cryptographic checks (the signed EVM transaction recovers
to the wallet address; the Solana signature verifies over the message bytes).

The model that decides is still **UNTRAINED**. It returns `NO_ACTION` when
unconfigured, when its output does not parse, and when it contradicts its own
inputs.

---

## What exists

| Requirement | State | Evidence |
|---|---|---|
| Trader Agent with schema-validated `NO_ACTION / OPEN / REDUCE / CLOSE / SWAP` | Done | `runtime/src/agents/trader/agent.ts` |
| Malformed model output → `NO_ACTION`, never interpreted | Done | test |
| Model contradicting its inputs → overridden, recorded as model failure | Done | test |
| Proposal builder: integer sizing, funding token, quote, fee, snapshot | Done | `runtime/src/trading/proposal.ts` |
| Risk gate: idempotency, state assembly, persistence, dispatch-time cooldowns | Done | `runtime/src/risk/gate.ts` |
| Trade state machine with checked transitions | Done | `runtime/src/trading/trades.ts` |
| Ledger: average-cost positions, fills, paper balances, daily loss baseline | Done | `runtime/src/trading/ledger.ts` |
| Paper executor with pessimistic fill model | Done | `runtime/src/execution/paper.ts` |
| Execution adapters: Jupiter v6, PancakeSwap v2, Aerodrome v2 | Done | `runtime/src/execution/{solana,evm}/` |
| Adapter reports contracts/programs before signing | Done | Solana top-level programs from `/swap-instructions` |
| No generic contract-call path | Done | interface has no `call(to, data)`; routers must be in the registry |
| LIVE executor: refuse → simulate → build → sign → **record hash** → broadcast → confirm → book | Done | `runtime/src/execution/live.ts` |
| Synchronous signing inside the vault callback | Done | `WalletService.useSigningKey` |
| EVM signer (EIP-1559, noble secp256k1, viem serialization) | Done | test: recovered address matches |
| Solana signer (legacy and v0 messages, single signer, fee-payer check) | Done | test: ed25519 verifies; live: parses a real Jupiter v0 tx |
| Exact-amount ERC-20 approval routed through the risk engine | Done | test |
| Chain-reported fills (Transfer logs / pre-post token balances) | Done | adapters' `receipt(hash, expect)` |
| Restart reconciliation by hash, no re-signing | Done | test |
| Auto-trade pipeline | Done | `runtime/src/trading/pipeline.ts` |
| Scheduler: off by default, stored setting, disarmed by emergency stop | Done | `runtime/src/trading/scheduler.ts` |
| Withdrawals: quote (90 s), typed confirmation, EIP-55, fee-unknown refusal, idempotency | Done | `runtime/src/wallet/withdrawal.ts` |
| Hand-built Solana transfers (System transfer, ATA create, `TransferChecked`) | Done | live-simulated on mainnet |
| Trading and withdrawal API | Done | `/api/v1/trading/*`, `/api/v1/wallet/withdraw*` |
| Skill: auto-trade | Done | `skills/auto-trade/SKILL.md` |

Not built in this phase: Robinhood Chain execution (Uniswap v4 Universal
Router). The chain is observable and the runtime says exactly why it cannot
trade there.

---

## Commands and their results

`runtime/`:

| Command | Result |
|---|---|
| `pnpm run lint` | clean |
| `pnpm run typecheck` | clean |
| `pnpm run format:check` | clean |
| `pnpm run test` | **394 passing** (53 new this phase) |
| `pnpm run build` | clean |

---

## Verification that was actually performed

### Live probes against mainnet (2026-09-20, read-only, nothing signed)

| What | Result |
|---|---|
| Jupiter quote 10 USDC → SOL | 0.0907 SOL; 4 top-level programs (ATA, ComputeBudget, Jupiter, Token) |
| Jupiter `/swap` build for a fresh keypair | v0 message, 1 required signature, fee payer = the keypair, 9 static keys |
| Solana signer `prepareSigning` on that transaction | accepted; `lastValidBlockHeight` read from the message |
| Aerodrome quote 10 USDC → WETH on Base | quoted; `build` encodes the requesting wallet as recipient |
| Aerodrome `prepareSigning` | chain id 8453, nonce read, `maxFeePerGas` 8.75 gwei with 25% headroom |
| Aerodrome approval fee estimate | 60,000 gas @ 7.5 gwei |
| PancakeSwap v2 quote on BSC | quoted; price impact 1 bps; unregistered router refused at construction |
| Associated token address derivation | matches the on-chain ATA of a known USDC holder |
| Hand-built SOL transfer message | `simulateTransaction`: success, 150 CU |
| Hand-built USDC `TransferChecked` + idempotent ATA create | `simulateTransaction`: success, 6,042 CU |

### Test scenarios (fake chains, real pipeline)

| Scenario | Result |
|---|---|
| Valid paper proposal | filled; position, balance and fee booked; fee is realized loss; every audit row `PAPER` |
| Oversized trade | trader override to `NO_ACTION`; engine `SIZE_EXCEEDS_MAX_TRADE` on a hand-built proposal |
| Unsupported token | `NO_ACTION` (not allowlisted) |
| Unknown contract | `CONTRACT_UNKNOWN`, trade `rejected`, no position |
| Stale data | `DATA_STALE` |
| No reliable price | cycle `skipped` at the builder, reason recorded |
| Insufficient balance | `BALANCE_INSUFFICIENT` |
| Fee over cap | `FEE_EXCEEDS_MAX` |
| Emergency stop / pause | cycle `blocked`, no trade row |
| Malformed model JSON | `NO_ACTION`, `modelStatus: UNAVAILABLE` |
| `REDUCE` with no position | overridden to `NO_ACTION` |
| `CLOSE` | reduce-only, full position size, realized P&L, position removed |
| Duplicate intent | `DUPLICATE_ACTION` |
| LIVE action while runtime is PAPER | engine refuses; executor refuses before the signer; zero signing contexts |
| LIVE fill | hash recorded before broadcast; signed tx recovers to the agent wallet; fill booked from the receipt |
| LIVE with no allowance | exact approval proposed, allowed, filled, then the swap |
| Simulation failure | no signing, no broadcast |
| Restart with `signed` and `dispatched` rows | `signed` → filled from the chain; `dispatched` → failed; nothing re-signed |
| Withdrawal quote / typed confirmation / idempotency / consumed quote | as specified |
| Fee unknown or balance short | `submittable: false`; submit refused; nothing broadcast |
| SOL withdrawal | message signed by the agent wallet; signature verifies |
| Destination validation | zero address, malformed, bad EIP-55 checksum refused; valid checksum and all-lowercase accepted |

---

## Things the verification caught

- The first V2 router `build` used the **zero address as the swap recipient**
  with a comment saying the executor would substitute it. Nothing did. A live
  transaction would have sent the output to `0x000…000`. The quote now carries
  the requesting wallet and `build` refuses a zero recipient.
- An ERC-20 **approval was starting the cooldown**, so the swap it enabled was
  rejected with `COOLDOWN_ACTIVE` one second later. Approvals now start no
  cooldown.
- Reconciling a row that died in `signed` tried to move it straight to
  `filled`, which the state machine correctly refused. It now passes through
  `broadcast`, because a transaction the chain has seen was broadcast whatever
  the row says.
- The fee-cap test first produced `DAILY_LOSS_BREACHED`, because a $1,250 fee
  is also a projected daily loss and that check runs first. Correct engine
  behaviour; the test now uses a fee that exceeds the fee cap alone.
- `audit_events` could not store the `hold` status the trader's `NO_ACTION`
  needed. SQLite cannot widen a CHECK in place; migration 002 rebuilds the
  append-only table with the wider constraint and re-creates its triggers.

---

## Honest limitations

| Limitation | Label |
|---|---|
| No live trade has ever been executed | true today; the code path is complete and tested with fakes |
| Robinhood Chain has no execution adapter | Uniswap v4 Universal Router not implemented; chain is observable only |
| Native-coin legs (ETH/BNB/SOL as tokenIn or tokenOut) are not supported | routers trade token pairs; wrapping is a second transaction |
| Reconciled fills after a restart are booked without fill-time prices | audit row says so; the amount is chain-reported |
| A LIVE fill whose receipt exposes no transfer is booked at `minAmountOut` | labelled `min-out-lower-bound` in the audit row; never the quote |
| Paper fills use a fixed haircut model, not an order-book simulation | deliberately pessimistic |
| The scheduler runs the watchlist sequentially; one slow provider slows the pass | acceptable at Phase 3 volume |
| Jupiter lite endpoint is rate limited | fine for a few cycles an hour; keyed endpoint via config |
| The trader model is UNTRAINED | see Phase 2; unchanged |

---

## Acceptance criteria

| Criterion | Status |
|---|---|
| The model never signs or broadcasts | Yes — the only signer is `LiveExecutor`, fed only by an `allowed` trade row the gate wrote |
| Every action passes the risk engine | Yes — pipeline has no bypass; approvals included |
| PAPER default; LIVE only via activation | Yes — engine `MODE_MISMATCH` / `LIVE_NOT_ACTIVATED`, executor refuses again |
| No arbitrary contract-call path | Yes — adapters are closed sets of operations over registry contracts |
| Emergency stop works without the model | Yes — one row; scheduler disarmed via hook; executor re-checks |
| Hash recorded before broadcast; restart does not re-sign | Yes — test |
| Fills are what the chain reports | Yes — Transfer logs / token balance deltas |
| Withdrawals need re-auth, typed confirmation where required, and a known fee | Yes — tests |
| No fake P&L or performance figures | None exist |
| Tests, lint, typecheck pass | Yes |

Phase 3 is complete.
