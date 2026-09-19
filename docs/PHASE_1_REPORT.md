# Phase 1 report

**Date:** 2026-09-20
**Scope:** core runtime, wallet vault, local dashboard API, risk policy, audit trail, Docker and CI.

Written for: an engineer picking this repository up, and an operator deciding whether to trust it with money.

---

## What exists

A runtime you can start, that creates isolated agent wallets, reads balances on
four chains, enforces a deterministic risk policy, keeps an append-only audit
trail, and refuses to do anything live until an operator explicitly walks a
six-step activation checklist.

| Requirement | State | Evidence |
|---|---|---|
| Monorepo, strict TypeScript, lint, format, typecheck, tests | Done | `runtime/`, CI job `runtime` |
| Setup wizard (name, chains, password, risk) | Done | `POST /api/v1/auth/setup`, `/setup/wallets`, `/setup/complete` |
| EVM + Solana agent wallets generated locally | Done | 20 distinct keys per run asserted in tests |
| Encrypted vault at rest | Done | Argon2id → XChaCha20-Poly1305, 19 vault tests |
| Export behind re-authentication | Done | single-use purpose-bound token, loopback only |
| Wrong password cannot export | Done | `test/api.test.ts`, `test/vault.test.ts` |
| Balances, deposit addresses, gas warnings | Done | `/api/v1/wallet/*`, verified against live RPC |
| Risk policy with hard limits, persisted | Done | `runtime/src/risk/`, 87 engine tests |
| Deterministic validators, no LLM in enforcement | Done | `evaluate()` is a pure function with no model import |
| Audit trail, append-only | Done | SQLite triggers reject UPDATE and DELETE |
| PAPER is default and LIVE cannot happen by accident | Done | mode is hard-coded at creation; LIVE needs six steps plus re-auth |
| Docker, compose, restart policy, health endpoint | Done | verified green in CI |
| Graceful shutdown | Done | verified in CI: SIGTERM, exit code 0 |
| Skills: wallet, risk-management, emergency-exit | Done | `skills/` |

---

## Commands and their results

Run in `runtime/`:

| Command | Result |
|---|---|
| `pnpm run lint` | clean |
| `pnpm run typecheck` | clean |
| `pnpm run format:check` | clean |
| `pnpm run test` | **308 passing** (250 at the end of Phase 1) |
| `pnpm run build` | clean |

CI (`.github/workflows/ci.yml`, `docker-smoke.yml`) runs all of the above plus a
container build on every push. Both workflows are green.

---

## Verification that was actually performed

The distinction matters, so this section separates what was observed from what
was assumed.

### Verified on real infrastructure

All four chains were queried live on 2026-09-19:

| Chain | Identity check | Height observed |
|---|---|---|
| Base | `eth_chainId` = 8453 | 51,523,939 |
| BNB Smart Chain | `eth_chainId` = 56 | 122,833,593 |
| Robinhood Chain | `eth_chainId` = 4663 | 67,244,447 |
| Solana | genesis `5eykt4Us…dw2N9d` | slot 448,468,825 |

Also read correctly: Base USDC metadata (`USDC`, 6 decimals) and Solana's
rent-exempt minimum for a 165-byte account (1,488,440 lamports — queried, never
hard-coded, because the historical 2,039,280 figure is now wrong).

**Robinhood Chain mainnet is live and its Uniswap v4 deployment is real.** That
was an open question at the start of the phase.

### Verified in CI

- The image builds and `docker compose up --wait` reaches a healthy container.
- `/health` returns ok; `/ready` returns 503 with `setupRequired: true` on a
  fresh install, which is correct rather than broken.
- Unauthenticated wallet access returns 401.
- Container logs contain no key material (scanned by pattern).
- `docker compose restart` survives.
- The API-only image exits 0 on SIGTERM, proving graceful shutdown.

### Verified by test

Security properties, each with a test that fails if the property breaks:

- a wrong password cannot unlock the vault or export a key;
- a re-authentication token cannot be reused, and one issued for `mode.live`
  cannot be spent on `wallet.export`;
- tampered ciphertext fails to decrypt;
- a secret row copied into another row fails to decrypt (AAD binding);
- plaintext is wiped after the callback that used it returns;
- no private key appears anywhere in the database file, an audit row, an API
  response or a log line;
- the emergency stop survives a restart and reverts LIVE to PAPER;
- after a restart the runtime starts locked, and configuration and wallets are
  intact.

Published test vectors were used wherever one exists: the Web3 Secret Storage v3
scrypt vector, RFC 8032 ed25519 test 1, and the money-arithmetic vectors from
the risk specification.

---

## Decisions worth knowing about

### `node:sqlite` instead of `better-sqlite3`

better-sqlite3 13.0.3 publishes no prebuilt binaries, so every install compiles
through node-gyp. That broke the container build and would have broken
`docker compose up` on any machine without a toolchain — the one command this
project promises works.

Node 24's built-in `node:sqlite` covers everything needed (prepared statements,
blobs, `RETURNING`, pragmas, transactions). The runtime now has **no native
dependencies at all**, which for a process holding wallet keys is worth more
than the microbenchmark difference. All 250 tests passed after the swap without
modification.

### Pure-JS cryptography

Argon2id, XChaCha20-Poly1305, ed25519, secp256k1, scrypt and AES all come from
the audited `@noble` suite. No native crypto addon shares an address space with
the vault, and behaviour is identical on Windows, Linux and in a container.

Argon2id parameters are 46 MiB / t=2 / p=1, chosen by measurement: about 1.5 s
on the reference machine, comfortably above the OWASP floor, and slow enough
that a dashboard unlock still feels immediate. Parameters are stored per
install, so they can be raised later without invalidating an existing vault.

### The health check runs through node

`node:24-bookworm-slim` ships neither `wget` nor `curl`. The first container
build reported unhealthy while the runtime was serving correctly, because the
health check could not execute. It now runs `node -e "fetch(...)"`, which also
asserts the body says `status: ok` rather than accepting any 200.

---

## Honest limitations

| Limitation | Label |
|---|---|
| Docker has never run on the author's machine (Windows 11 Home, no WSL) | `LOCAL DOCKER: UNVERIFIED` — verified in CI instead |
| The runtime has never run unattended for days | `24/7 SOAK: NOT TESTED` |
| No LIVE transaction has ever been signed or broadcast | Phase 3 scope; the signer exists, the executor does not |
| Withdrawal endpoints are specified but not implemented | Phase 3 |
| Graceful shutdown is unverified on Windows | `Stop-Process` is a hard kill; verified on Linux in CI |
| Balances are read; transaction history is local records only | No chain scan yet |
| Telegram is not implemented | Phase 4 |

Nothing in this phase has moved real funds, and no claim here depends on that
having happened.

---

## Acceptance criteria

| Criterion | Status |
|---|---|
| Fresh install works | Yes — verified in CI and locally |
| Docker boot works | Yes — verified in CI |
| Restart preserves configuration | Yes — test |
| Wallet generation works | Yes — test and live run |
| Encrypted vault persists | Yes — test |
| Wrong password cannot export keys | Yes — test |
| No secret appears in logs | Yes — test and CI log scan |
| Dashboard builds | Yes — Vite build, served by the runtime |
| PAPER mode is default | Yes — hard-coded at creation |
| LIVE cannot be accidentally enabled | Yes — six steps plus re-auth, test |
| Risk policy persists | Yes — test |
| Tests, lint, typecheck pass | Yes — CI |

Phase 1 is complete.

---

## Repository

https://github.com/sighttrue/ATRA
