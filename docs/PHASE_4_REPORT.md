# Phase 4 report

**Date:** 2026-09-20
**Scope:** Liquidity Manager agent, LP adapters (Aerodrome v2, PancakeSwap v2), LP proposal builder, paper and live LP executors, LP ledger and scheduler, the LP checks in the risk engine, Telegram pairing, commands and notifications over two transports, and the gateway Worker.

Written for: an engineer picking this repository up, and anyone asking whether ATRA can manage liquidity or be controlled from Telegram, and whether it has.

The code described here is the Phase 4 tree as committed in `b081ddb` and
`c733aee`. The gateway is being extended for Phase 5 in the same checkout
while this report is written; nothing below describes that work.

---

## The short version

ATRA can now run a complete liquidity-management cycle — read a pool and the
wallet's position in it, let the Liquidity Manager propose one of six
actions, build a deterministic proposal, evaluate it with the LP checks in
the risk engine, execute it — in paper mode against live pool reserves, and
has every piece needed to do the same in live mode on Aerodrome v2 (Base)
and PancakeSwap v2 (BNB Smart Chain): router quotes, exact-amount approvals,
synchronous signing inside the vault, hash-before-broadcast recording,
chain-reported bookings and restart reconciliation.

A Telegram remote control exists end to end in code: a pairing handshake
that stores only a code hash, a command router that verifies identity,
replay and age on every message, a two-step emergency stop that needs no
model, notifications with deduplication and caps, and two transports — the
official gateway over WebSocket, or the operator's own bot token by long
polling. The gateway is a Cloudflare Worker with a hibernating-WebSocket
Durable Object and a D1 schema that holds hashes and ids only.

**None of it has touched real money or a real Telegram account.** No live LP
position has been opened with real funds. The gateway has not been deployed:
no Worker, no D1 database, no installation token exists. No Telegram bot
exists, so no message has ever been sent to or received from Telegram. Every
live-path component was verified against mainnet up to, but not including,
signing: pool reads, router quotes, allowance reads, transaction builds,
nonce and fee reads. Signing, broadcast, pairing and command handling are
verified by tests with fake chains, a fake pool, a fake transport and, for
the gateway, real WebSockets inside workerd with `api.telegram.org` stubbed.

Robinhood Chain and Solana have no LP adapter. The registry says so, the
dashboard shows the reason, and a cycle on either chain records a `HOLD`
without consulting a model.

The model that decides is still **UNTRAINED**. A training run is in
progress and has not completed; no `evaluate.py` result exists for it. The
Liquidity Manager returns `HOLD` when the model is unconfigured, when its
output does not parse, and when it contradicts its own inputs.

This report's own review found one defect in the boot order and one in the
schedulers' interval handling. Both are reproduced below and neither is fixed
in this phase.

---

## What exists

| Requirement | State | Evidence |
|---|---|---|
| Liquidity Manager with schema-validated `HOLD / ADD_LIQUIDITY / REMOVE_LIQUIDITY / REBALANCE / COLLECT_FEES / EXIT` | Done | `runtime/src/agents/liquidity-manager/agent.ts` |
| Malformed or unavailable model output → `HOLD`, recorded as a model failure | Done | test |
| Model contradicting its inputs (wrong chain or pool, capital over cap, exit of nothing, claim below threshold, rebalance on v2) → overridden to `HOLD` | Done | test: `deterministicSanity` |
| LP adapter interface: closed set of read / quote / build operations, no `call(contract, data)` | Done | `runtime/src/liquidity/types.ts` |
| Aerodrome v2 adapter (Base): pool and position reads, router quotes, `addLiquidity`, `removeLiquidity`, `claimFees` on the pool, exact approvals | Done | `runtime/src/liquidity/evm/v2-pool.ts`; live probes |
| PancakeSwap v2 adapter (BSC): same, minus fee claims (fees compound) | Done | same file, `uniswap-v2` dialect; live probes |
| Pool accepted only if the protocol's factory reports it | Done | live: a Biswap pair refused by the factory check |
| LP router must already be a registered swap contract | Done | `assertRegisteredRouter` at construction |
| Registry reports why Solana and Robinhood Chain cannot manage liquidity | Done | `runtime/src/liquidity/registry.ts`, `GET /api/v1/liquidity/adapters` |
| Deterministic LP proposal builder: integer sizing of both legs, router quote, floors, fee, dated snapshot with pool TVL and the LP ledger slice | Done | `runtime/src/liquidity/proposal.ts` |
| Refusal to add into a volatile pool whose own price disagrees with the cross-checked market price | Done | test |
| LP checks in the risk engine: pool and protocol allowlists, capital cap, pool liquidity, rebalance count and slippage, LP gas, claim threshold, second-leg freshness and balance | Done | `runtime/src/risk/engine.ts` §LP; test |
| Default policy keeps LP disabled (no pools, zero capital); every `lp_*` kind rejected by an LP check, never evaluated as a swap | Done | `runtime/test/review-regressions.test.ts` |
| LP ledger: positions with cost basis, append-only action log with triggers, daily rebalance counts, stored automation switch | Done | `runtime/src/db/migrations/003_liquidity.sql`, `runtime/src/liquidity/store.ts` |
| Paper LP executor: pair mint formula from live reserves, burn returns share of reserves, gas as realized loss, no fee accrual | Done | `runtime/src/liquidity/paper.ts` |
| LIVE LP executor: refuse → build → sign → **record hash** → broadcast → confirm → book from ERC-20 transfers | Done | `runtime/src/liquidity/live.ts`; test |
| Exact-amount approvals of each pool asset (add) or the LP token (remove) routed through the risk engine | Done | test: two approvals, then the add |
| Restart reconciliation of LP rows by hash, no re-signing | Done in isolation; **defective in the production boot order** | test; see "Things the verification caught" |
| LP pipeline with every ending recorded in `lp_actions` and the audit log | Done | `runtime/src/liquidity/pipeline.ts` |
| LP scheduler: off by default, stored, walks the policy's allowed pools, disarmed by the emergency stop | Done | `runtime/src/liquidity/scheduler.ts` |
| Liquidity API for the dashboard | Done | `/api/v1/liquidity/*`; `docs/api.md` |
| Telegram pairing: CSPRNG code, `sha256` stored, 5-minute TTL, single use, older codes retired | Done | `runtime/src/telegram/pairing.ts`; test |
| Command router: replay cursor per chat, age window, identity against the stored link, rate limits | Done | `runtime/src/telegram/commands.ts`; test |
| Commands `/start /pair /status /portfolio /positions /trades /lp /risk /pause /resume /alerts /emergency /help` | Done | test: every command replies, every reply bounded |
| `/emergency` → `/emergency CONFIRM` within 60 s engages the stop with no model and no network; clearing refused | Done | test |
| Export, withdrawal, key and seed words refused with one fixed reply | Done | test |
| Notifications: category toggles, master switch, 1-hour dedupe, per-code cooldown, 30/hour cap, never thrown into the trading path | Done | `runtime/src/telegram/notifications.ts`; test |
| Gas watcher (10 min) and daily-loss watcher (80 %, once per UTC day) | Done | test |
| Gateway transport: outbound WebSocket, `atra.v1`, hello/welcome, heartbeat, backoff, token only in the upgrade header | Done | `runtime/src/telegram/transport.ts`; test |
| Direct bot transport: `getUpdates` long poll with a persisted offset, private chats only, no parse mode | Done | same file; test against a stubbed API |
| Secrets read from the environment at the composition root and held nowhere else | Done | `readTelegramSecrets`; secrecy test |
| Telegram API for the dashboard, `409 TELEGRAM_NOT_CONFIGURED` without a transport | Done | `/api/v1/telegram/*`; `docs/api.md` |
| Gateway Worker: webhook, `/v1/ws`, admin mint, Hub Durable Object, D1 migrations, cron purge | Done, **not deployed** | `gateway/`; 49 tests in workerd |
| Wire protocol written down for both sides | Done | `docs/specs/telegram-protocol.md`, `gateway/README.md` |
| Skills: auto-lp, telegram | Done | `skills/auto-lp/SKILL.md`, `skills/telegram/SKILL.md` |

Not built in this phase: a concentrated-liquidity adapter of any kind, so
`REBALANCE` is never executable and `range` is always `null`; an LP adapter
for Solana (Orca, Raydium, Meteora) or Robinhood Chain (Uniswap v4); a
Telegram notification for LP outcomes (the kinds exist in the notifier's
vocabulary, nothing raises them); gateway deployment.

---

## Commands and their results

Run on 2026-09-20 in this checkout.

`runtime/`:

| Command | Result |
|---|---|
| `pnpm run lint` | clean |
| `pnpm run typecheck` | clean |
| `pnpm run format:check` | clean |
| `pnpm run test` | **497 passing** in 19 files (103 new this phase: 100 in the eight new liquidity and telegram files, one mounting test in `api.test.ts`, two in `review-regressions.test.ts`) |
| `pnpm run build` | clean |

`gateway/` (its own pnpm project):

| Command | Result |
|---|---|
| `pnpm run lint` | clean |
| `pnpm run typecheck` | clean (all three tsconfigs) |
| `pnpm run format:check` | clean on every tracked file; **fails** on `src/problem.ts`, an untracked Phase 5 fragment another engineer left in the tree, which is not part of Phase 4 |
| `pnpm run test` | 49 tests in 4 files on the committed Phase 4 tree, all passing in CI (workflow `gateway` on `b081ddb`: success). A local run in this shared checkout reflects whatever the Phase 5 gateway owner has in progress — during this report's first run one `/health` version assertion failed against their edited `env.ts` — so no local number is quoted here. |
| `wrangler deploy --dry-run` (staging and production) | run by CI on `b081ddb`: success. Not re-run locally because the gateway tree is mid-edit by its Phase 5 owner. |

CI on the Phase 4 commits: `b081ddb` — `gateway` success, `docker-smoke`
success, `ci` **failure** (see below); `c733aee` — `ci` success,
`docker-smoke` success.

---

## Verification that was actually performed

### Live probes against mainnet (2026-09-20, read-only, nothing signed)

Every call below is `eth_call`, `eth_blockNumber`, `eth_getTransactionCount`,
`eth_gasPrice` or `eth_feeHistory`. The `from` address for quotes, allowance
and nonce reads was `0x…dEaD`, which ATRA does not control. No transaction
was built for a wallet ATRA holds, and nothing was signed or sent.

**Base, Aerodrome v2, block 51538721, `mainnet.base.org`, all reads pinned to that block:**

| What | Result |
|---|---|
| Pool `0xcdac…5c43` reserves and supply | reserve0 (WETH) `1710910978539833668719`, reserve1 (USDC) `4496274050177`, totalSupply `85825380604538978` |
| `router.quoteAddLiquidity(WETH, USDC, false, factory, 4e15, 10e6)` | `(3805175039258298, 10000000, 190881115445)` |
| `v2AddQuote` from the reserves alone (the adapter's PancakeSwap path and the paper executor's mint formula) | `(3805175039258298, 10000000, 190881115445)` — **identical** |
| `router.quoteRemoveLiquidity(…, 1e12)` | `(19934790460449762, 52388629)` |
| `shareOfReserves` from the reserves alone | `(19934790460449762, 52388629)` — **identical** |
| The real adapter's `readPool` against this endpoint | **refused by the node**: `over rate limit` (JSON-RPC `-32016`) on four attempts. The adapter issues up to eleven `eth_call`s per Aerodrome pool read, seven of them in one parallel burst, and the public Base endpoint rejects that. |

**Base, Aerodrome v2, blocks 51538755–51538757, `base-rpc.publicnode.com`, the real `V2PoolLpAdapter`:**

| What | Result |
|---|---|
| `readPool` | `WETH/USDC`, `stable = false`, `feeBps = 30`, reserves `1710997915950256171172 / 4496045666677`, supply `85825380604538978`, source `aerodrome-v2-rpc` |
| `readPosition(0x…dEaD)` | 0 LP, `claimable0/1 = 0/0`, note "claimable0/claimable1 as the pool reports them for this holder" |
| `claimPlan` | contract is the pool itself; 150,000 gas at `maxFeePerGas` 7,500,000 wei |
| `quoteAdd` (0.004 WETH, 10 USDC, 50 bps) | source `aerodrome-v2-quoteAddLiquidity`: `3805561693092953 / 10000000` → `190890811542` LP, min `189936357484`; contract is the router; 260,000 gas |
| `quoteRemove(1e12)` | `19935803417337458 / 52385968`, floors `19836124400250770 / 52124038` |
| `buildAdd` → `prepareSigning` | chain id 8453, `to` equals the router, nonce 0, gas 260,000, `maxFeePerGas` 8,750,000 wei (25 % headroom), priority 1,000,000 wei |
| `buildClaim` | `claimFees` on the pool |
| `allowance(USDC, 0x…dEaD → router)` | 0; approval estimate 60,000 gas |
| `quoteAdd` with the zero address as `from` | refused before any RPC: "A quote needs the sending wallet address" |
| Uniswap v2 WETH/USDC pair on Base (`0x88A4…bB9C`, from the Uniswap v2 factory) | refused: the pair has no `stable()`, so the read fails before the factory check |

**BNB Smart Chain, PancakeSwap v2, block 122899000, `bsc-dataseed.bnbchain.org`, the real adapter:**

| What | Result |
|---|---|
| `readPool` `0x16b9…0dae` | `USDT/WBNB`, `feeBps = null` (not exposed by the pair), reserves `39463665342694393753815680 / 51685271132160774250641`, supply `526589833721618247699467` |
| `router.factory()` | `0xca14…c73`, equals the registry entry |
| `readPool(router address)` | refused: not a pair |
| `quoteAdd` (0.004 USDT, 10 WBNB desired, 50 bps) | source `pancakeswap-v2-reserves`: `4000000000000000 / 5238830599492` → `53374956181736` LP, min `53108081400827`; 260,000 gas at `maxFeePerGas` 62,500,000 wei |
| `quoteRemove(1e12)` | `74941513513936 / 98151473542` |
| `readPosition(0x…dEaD)` | `1574616372733965` LP (that address holds Cake-LP; the read path returns it), `claimable = null`, note "fees compound into the reserves" |
| `claimPlan` | refused: "pancakeswap-v2 fees compound into the reserves; there is nothing to claim" |
| `buildAdd` → `prepareSigning` | chain id 56, `to` equals the router, nonce 0, 260-byte calldata, priority 50,000,000 wei |
| Biswap USDT/WBNB pair `0x8840…C1BA` (block 122899454) | refused: "is not a pancakeswap-v2 pool according to the factory" |

Two adapter reads a block apart return different reserves on BSC; the
adapter reads the pool once for `readPool` and again inside `quoteAdd`, so a
probe that compares the two sees a small drift. The pinned-block comparison
on Base is the one that proves the formula.

Not probed live, because nothing exists to probe: Telegram (no bot), the
gateway (not deployed), a real LP position (none has been opened).

### Test scenarios: liquidity (fake chain, fake pool, scripted model, real pipeline)

| Scenario | Result |
|---|---|
| `ADD_LIQUIDITY` on paper | filled; both paper balances debited at the ratio-adjusted amounts; LP minted by the pair's own formula; gas booked as realized loss; every audit row `PAPER` |
| Next cycle on an open paper position | marked from live reserves; impermanent loss visible as mark minus cost basis |
| Model unavailable / output does not parse | `HOLD` with the reason, `modelStatus: UNAVAILABLE` |
| Chain without an LP adapter | cycle `skipped`, `HOLD` recorded with the registry's reason, no model call |
| Default policy (LP disabled) | every `lp_*` kind rejected `POOL_NOT_ALLOWLISTED`; the agent holds on an unlisted pool |
| Capital above `maxCapitalPerLpUsd` | agent overridden to `HOLD`; a hand-built proposal rejected `LP_CAPITAL_EXCEEDS_MAX` |
| Thin pool | `POOL_LIQUIDITY_BELOW_MIN` |
| `REBALANCE` on a v2 pool | overridden to `HOLD`; the engine's `REBALANCE_LIMIT_REACHED` enforced on a hand-built `lp_rebalance` |
| `COLLECT_FEES` below the threshold | overridden; engine `FEE_BELOW_CLAIM_THRESHOLD` |
| Gas above `maxLpGasUsd` | `FEE_EXCEEDS_MAX` from the `lp.gas` rule |
| Emergency stop / pause | cycle `blocked`; the stop disarms LP automation |
| `REMOVE_LIQUIDITY` / `EXIT` with no position | overridden to `HOLD` |
| `EXIT` on paper | both assets returned, position row deleted, fee realized |
| `REMOVE_LIQUIDITY` on paper | exactly half burned, rest kept |
| Pool price 400 bps off the market (pool says 2,600, market says 2,500) | cycle `skipped` before the engine: "deviates from the cross-checked market price"; no trade row |
| Same intent twice | `DUPLICATE_ACTION` |
| LIVE action while the runtime is PAPER | engine refuses; executor refuses again; zero signing contexts, zero broadcasts |
| LIVE `ADD_LIQUIDITY` | hash on the trade row before broadcast; signed transaction recovers to the agent wallet; LP tokens booked from the receipt and equal to the fake pool's balance; `liquidity.signed` precedes `liquidity.filled` |
| LIVE add with zero allowance | two exact approvals (WETH and USDC amounts), each allowed by the engine, then the add: three broadcasts |
| LIVE `EXIT` | exact approval of the LP token (engine detail says "LP token"), burn, position closed, chain balance zero |
| LIVE `COLLECT_FEES` | `claimFees` sent to the pool, amounts booked from the receipt |
| Restart with a `signed` LP row | filled from the chain, position booked with a zero cost basis, nothing re-signed — **when the LP reconcile runs first**; see below |
| `v2AddQuote` / `shareOfReserves` against router quotes recorded at Base block 51534237 on 2026-09-19 | identical |
| Routes: session required; view shape with honest zeros; `PUT /automation` validation and the 409 under an emergency stop; `POST /run` 409 while paused or stopped, 202 otherwise | as specified |

### Test scenarios: Telegram (fake transport, real router, real database)

| Scenario | Result |
|---|---|
| Unpaired user | one generic reply, audited, nothing changes; a paired-but-different user treated the same |
| Stranger repeats | three replies per ten minutes, then silence |
| Replayed update id; message older than 120 s | dropped, recorded as `replayed` / `stale` |
| Operator floods | 20 commands a minute, 5 control commands a minute, then a single "too many" reply |
| `/pause`, `/resume` | flip the global pause with actor `telegram`; `/resume` refused while the emergency stop is engaged |
| `/emergency` | challenge issued; `CONFIRM` within 60 s engages the stop through `StateStore` alone; `clear/off/reset/resume` refused |
| `/export`, `/withdraw`, `/key`, `/seed`, … | one fixed refusal, audited |
| `/status /portfolio /positions /trades /lp /risk /help` | non-empty, bounded replies; an unpriced position is "unknown" and so are the totals that depend on it |
| `/pair` | deferred to the bot on the gateway transport; verified locally on the direct transport |
| Every message | one `telegram_commands` row and one audit row, without the message text |
| Pair codes | contract shape, unbiased alphabet, hash of the dashless upper-case form; only the hash stored; expiry at 5 minutes; single use; a new code retires older ones; malformed and unknown codes never touch the link; re-pairing replaces the singleton |
| Notifier | unpaired → nothing; master switch and category toggles honoured; duplicates suppressed for an hour; rejection cooldown per code with the swallowed count; 30 an hour; a failed delivery recorded, never thrown |
| Watchers | daily-loss warning once per UTC day at 80 %; `gas.low` once an hour per chain, not before pairing |
| Gateway transport | bearer header and subprotocol on connect, `hello` first; replies carry the request id; `paired`/`unpaired` relayed, unknown frames ignored; sends refused while disconnected; ping every 30 s, reconnect after three missed pongs; exponential backoff with jitter up to 60 s; a socket that never opens is given up; a stopped transport does not reconnect; the token appears nowhere but the upgrade header |
| Direct transport | long-polls `getUpdates`, private chats only, replies, advances the offset; a Telegram error is reported without the token |
| Service | selects gateway, then direct, then none; a gateway URL without its token is refused; tokens are not on the config object; reconciles the gateway's `welcome` against its own link and fails closed on disagreement; announces online and offline once; cycle reports become trade notifications and run the daily-loss check |
| Secrecy | with both tokens set and a real logger capturing every line, every command run: neither token appears in any reply, audit row, notification or log line |
| Routes | session required; `TelegramView` shape when unconfigured; `POST /pair` is `409 TELEGRAM_NOT_CONFIGURED` without a transport; issue → poll `pending` → `confirmed` → unpair; expired and unknown codes read as `expired`, malformed ones `422`; `PUT`/`PATCH /notifications` validated; writes refused without the dashboard header |

### Test scenarios: gateway (workerd, local D1, real WebSockets, `api.telegram.org` stubbed)

| Scenario | Result |
|---|---|
| Webhook secret missing or wrong | 401, nothing sent; malformed body acknowledged with 200 so Telegram does not retry |
| `/start`, `/help` | answered by the gateway with pairing instructions |
| Duplicate `(chat_id, update_id)` | acknowledged silently; group chats, bots and non-text updates ignored |
| `/pair CODE` | code consumed atomically, user linked, runtime told; accepted lower-case and dashless; a replayed code fails; an expired code fails; malformed or unknown codes leave the database untouched; a new `pair.offer` replaces the unused code; a user pairing a second installation is moved and the first is told |
| Unlinked user | one generic hint; nothing reaches any runtime; rate limited by `RL_UNPAIRED` and `RL_WEBHOOK` when the bindings exist |
| Linked user, runtime offline | "ATRA runtime is offline or not responding" |
| Export and withdrawal words | refused at the gateway, never forwarded |
| `/v1/ws` | missing, malformed, unknown, revoked and expired tokens 401; subprotocol and upgrade required; a good token gets 101, the subprotocol echoed, `welcome` after `hello`; `RL_WS` honoured |
| Hub | literal `ping` answered `pong` by auto-response; frames before `hello` and invalid frames rejected; routing by token, not by `hello.installationId`; a `pair.offer` in the past refused; `welcome` reports the existing link on reconnect; `pair.revoke` clears link and codes and answers `unpaired`; a second connection supersedes the first; a linked user's `/status` forwarded and the reply relayed to `sendMessage`; "offline" after the 8 s timeout; `notify` reaches the linked chat and is ignored when unpaired; the sweep alarm re-arms only while sockets remain |
| Admin | `/health` reports the version; unknown paths 404; minting requires the admin token; a minted token opens the WebSocket; explicit `installId` and `ttlDays` accepted, junk rejected |
| Housekeeping | `tg_updates` older than 24 h and dead pair codes purged |

---

## Things the verification caught

Caught while building and committing Phase 4:

- The `ci` workflow **failed on the Phase 4 commit** (`b081ddb`): the ESLint
  autofix had reformatted `test/liquidity-routes.test.ts` in a way Prettier
  rejects, and `prettier --check` is a CI step. Fixed in `c733aee` by
  re-running Prettier. The rule that follows: after `eslint --fix`, always
  run Prettier on the same files before committing.
- The Phase 1–2 review had pinned the invariant "any `lp_*` kind is refused
  with `SCHEMA_INVALID`". Phase 4 could not keep that test and had to replace
  it with the invariant it was protecting: under the default policy every
  `lp_*` kind is still rejected, and it is rejected by an LP check
  (`POOL_NOT_ALLOWLISTED`), never approved by the swap checks
  (`size.amountInUsd` is `not-applicable`). The regression file also pins
  that an `lp_*` kind without an `lp` leg is still `SCHEMA_INVALID`, and that
  listing the pool with a zero capital cap yields `LP_CAPITAL_EXCEEDS_MAX`.
- Check order matters for the code the dashboard shows. `lp.pool` and
  `lp.capital` were placed right after `chain.enabled`, before the freshness
  checks, so that "the operator never allowed this pool" is reported as
  such rather than as `DATA_STALE` when the snapshot is also old.
- A LIVE `COLLECT_FEES` right after an `ADD_LIQUIDITY` on the same pool was
  rejected `COOLDOWN_ACTIVE` in the test until the test policy set the
  cooldowns to zero: LP actions are keyed on the same `chain:token0:token1`
  market as swaps, so the production default spaces consecutive LP actions
  on one pool fifteen minutes apart. Recorded as a limitation below rather
  than changed.

Carried forward from Phase 3, where they were found: the LP adapter refuses
a zero recipient at quote time (confirmed live above) because the first V2
swap `build` once used the zero address as recipient; LP approvals start no
cooldown because an approval once locked the swap it enabled; the LP
reconcile passes a `signed` row through `broadcast` before `filled` because
the state machine refused the direct transition; and the `HOLD` decisions of
this phase use the `hold` audit status that migration 002 rebuilt
`audit_events` to allow.

Found during the review that produced this report, **not fixed in this
phase**:

- **The boot order defeats the LP reconcile.** `startBackgroundServices`
  runs the swap executor's `reconcile()` before `liquidity.start()`, and the
  swap reconcile settles every in-flight trade row without skipping `lp_*`
  kinds. `LiveLpExecutor.reconcile` says in its own comment that it "must run
  before the swap executor's reconcile, which would otherwise mark these rows
  without booking the LP position" — and that is what happens. Reproduced
  with a fake execution adapter whose receipt says `confirmed`, the same
  fixture as the LP row test: in the production order the swap reconcile
  reports `checked: 1, filled: 1`, writes a `trade.filled` audit row, the LP
  reconcile then reports `checked: 0`, and `lp_positions` stays empty. In the
  reverse order the position is booked. The suite did not catch it because
  the LP test builds its services with an empty execution registry, in which
  case the swap reconcile leaves the row as `stillPending`. The consequence
  after a crash between signing and confirmation of a LIVE LP add is that
  the chain holds LP tokens the ledger does not know about: the LIVE pipeline
  still reads the position from the chain and the engine still sees it, but
  the dashboard's positions list, the cost basis and any later `bookRemove`
  ("ledger held fewer LP tokens than were burned") are wrong. Fix: run the
  LP reconcile first, or make the swap reconcile skip rows whose `kind`
  starts with `lp_` or whose `route.lp` is true. The reproduction lives in
  the reviewer's scratchpad, not in the suite.
- **Both schedulers mishandle most intervals.** The cron pattern builder in
  `liquidity/scheduler.ts` (copied from `trading/scheduler.ts`) maps an
  interval that is a multiple of 60 s up to 3,600 s to a minute step, and
  everything else to `*/min(interval, 59) * * * * *`. Evaluated with croner:
  60, 1,800 and 3,600 s fire every 60, 1,800 and 3,600 s; **5,400, 7,200,
  86,400 and 90 s all become `*/59 * * * * *`, which fires at seconds 0 and
  59 of every minute** (gaps of 1 s and 59 s). The route accepts 60–86,400.
  An operator who asks for a daily pass gets one every minute. Neither
  scheduler is exercised at those intervals by a test.
- **The LIVE LP executor has no simulation step.** The swap executor
  simulates on the chain before signing; the LP executor goes refuse → build
  → sign → record → broadcast. A `addLiquidity` that would revert (a pool
  moved past the floors, an allowance consumed by something else) is found
  out on chain and costs the gas. The spec's "simulate" step exists in PAPER
  only.
- **LP outcomes never reach Telegram.** `lp.filled`, `lp.rebalanced` and
  `lp.exited` are in the notifier's vocabulary with titles and a category,
  but no code raises them: the LP pipeline has no notification hook, unlike
  the trading pipeline's `onCycle`. The spec's "LP rebalanced" and "LP
  exited" alerts do not exist.
- **The default Base endpoint rate-limits a pool read.** `mainnet.base.org`
  answered the adapter's parallel `eth_call`s with `over rate limit` on four
  attempts in a row, while the same calls succeeded against another public
  endpoint. The adapter has no backoff on that error, so an LP cycle on Base
  with the default RPC ends `skipped: pool read failed`. An operator needs
  `ATRA_RPC_BASE` pointed at a keyed endpoint.
- The Telegram `/lp` summary in `core/services.ts` interpolates
  `totalValueUsd` and each position's `valueUsd` directly, so an unpriced
  position reads "null USD" instead of "unknown", which is what the rest of
  the Telegram surface says.
- `README.md` still lists liquidity management and the Telegram bot as
  "Not built (Phase 4)". It is another owner's file and is flagged, not
  edited, here.

---

## Honest limitations

| Limitation | Label |
|---|---|
| No live LP position has ever been opened | true today; the code path is complete and tested with fakes; live reads verified up to `prepareSigning` |
| The gateway is not deployed and no Telegram bot exists | no Worker, D1 database, installation token or bot token exists; verified in workerd and by CI's `wrangler deploy --dry-run` only |
| No Telegram message has ever been sent or received | both transports tested against fakes or a stubbed `api.telegram.org` |
| Solana and Robinhood Chain have no LP adapter | Orca/Raydium/Meteora position programs and Uniswap v4's position manager are not implemented; the registry says so |
| v2 pools only: no price range, so `REBALANCE` is never executable | overridden to `HOLD`; the action and the `REBALANCE_LIMIT_REACHED` check exist for a future concentrated-liquidity adapter |
| PAPER does not simulate fee accrual | a paper position reports zero fees with a note; `COLLECT_FEES` is refused on paper before it reaches the engine |
| `REMOVE_LIQUIDITY` removes exactly half; `EXIT` removes all | the agent chooses the action, not the fraction |
| Native-coin legs are not supported | pools are WETH/USDC and USDT/WBNB; wrapping would be a second transaction |
| The LIVE LP executor does not simulate before signing | a revert costs gas; the router's floors and deadline are the only protection |
| LP actions share the swap cooldown key for the pair | consecutive LP actions on one pool are spaced `cooldownSeconds` apart |
| A reconciled LP fill after a restart is booked with a zero cost basis | the audit row says so; and see the boot-order defect above, which currently prevents that booking altogether |
| Scheduler intervals other than 60–3,600 s in whole minutes fire every 59 s | both schedulers; found by this report |
| LP outcomes produce no Telegram notification | kinds defined, never raised |
| `mainnet.base.org` rate-limits the adapter's pool read | use a keyed Base RPC via `ATRA_RPC_BASE` |
| Telegram rate limiters and the emergency challenge are in memory | reset on restart; the replay cursor and the pairing link are persisted |
| Gateway on the Cloudflare Free plan shares 100,000 requests a day with every other Worker on the account | Workers Paid before inviting anyone; see `gateway/README.md` |
| Installation tokens are minted by an admin endpoint and revoked by hand | Phase 5 registration and rotation are not built |
| The Liquidity Manager model is UNTRAINED | a training run is in progress and has not completed; unchanged since Phase 2 |

---

## Acceptance criteria

| Criterion | Status |
|---|---|
| LP paper/simulation path works | Yes — add, remove, exit and marking on paper against live reserves, with the pair's own mint formula (matched to Aerodrome's router at a pinned block) |
| Unsupported protocol cannot execute | Yes — no adapter for Solana or Robinhood Chain, a `HOLD` with the reason and no model call; a pool the factory disowns is refused at the adapter (live: Biswap pair); a router not in the swap registry cannot construct an adapter; `PROTOCOL_NOT_ALLOWLISTED` / `POOL_NOT_ALLOWLISTED` in the engine |
| Telegram pairing expires / replay fails | Yes — 5-minute TTL, single atomic use, older codes retired, a replayed code refused on both the runtime and the gateway; a replayed update id dropped |
| Unauthorized Telegram user cannot control the installation | Yes — identity checked against the stored link on every message after the gateway has already filtered; one generic reply, rate limited, nothing changes |
| Pause/resume works | Yes — from the dashboard and from Telegram with actor `telegram`; `/resume` cannot clear an emergency stop |
| Emergency works without the LLM | Yes — `/emergency CONFIRM` writes one row through `StateStore`; no model, no network; LIVE drops to PAPER and both schedulers are disarmed by the existing hook |
| Private keys never leave the local vault | Yes — the only signing path is `WalletService.useSigningKey` inside `LiveLpExecutor`; the gateway has no frame that could carry a key; Telegram refuses every export word; the secrecy test shows neither token in any output |
| Tests, lint, typecheck pass | Yes — runtime 497/497, lint, typecheck, format and build clean; gateway lint and typecheck clean and 49/49 in CI on the committed tree |

Phase 4 is complete as specified, with the defects above recorded for the
next commit rather than hidden.
