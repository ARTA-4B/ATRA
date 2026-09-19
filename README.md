# ATRA

**An open-source autonomous crypto agent that runs on your machine.**

ATRA creates an isolated agent wallet, lets you fund it with your own capital,
researches markets on four chains, and — only after you explicitly turn it on —
trades within limits you set. It is controlled from a local dashboard and, in a
later phase, an official Telegram bot.

Your private keys never leave your computer. Paper mode is the default. The
reasoning model proposes; deterministic code decides.

> **Status:** Phases 1 and 2 of 5 are complete and verified. Auto-trade,
> liquidity management and Telegram are not yet built. The ATRA-4B model is
> **untrained**. See [what is real](#what-is-real-today) before relying on
> anything here.

---

## The four chains

| Chain | Family | Chain id |
|---|---|---|
| Base | EVM | 8453 |
| BNB Smart Chain | EVM | 56 |
| Robinhood Chain | EVM | 4663 |
| Solana | Solana | mainnet-beta |

Exactly these. ATRA never substitutes one chain for another.

## How it works

```
your intent
  → reasoning model (proposes)
    → structured, schema-validated proposal
      → deterministic simulation
        → deterministic risk engine (33 checks, no model involved)
          → allowlist checks
            → transaction builder
              → isolated wallet vault (signs)
                → chain
```

The model cannot sign, cannot broadcast, cannot see a key and cannot override a
rejection. The emergency stop works with the model offline.

## Install

```bash
git clone https://github.com/sighttrue/ATRA.git
cd ATRA
docker compose up -d
```

Open http://127.0.0.1:3000 and complete first-run setup: choose a password,
create the agent wallets, pick your chains, review the default risk limits.
You start in **PAPER** mode.

The container publishes to `127.0.0.1` only. ATRA holds wallet keys; exposing it
beyond your machine is a deliberate decision, not a default.

Without Docker:

```bash
cd runtime
pnpm install
pnpm run build
pnpm start
```

Requires Node 24. There are no native dependencies to compile.

## The four things this repository contains

| Component | What it is | Where |
|---|---|---|
| **ATRA Runtime** | The self-hosted agent: vault, risk engine, adapters, local API | `runtime/` |
| **Dashboard** | The local web UI, served by the runtime | repo root (`src/`) |
| **ATRA-4B** | Training and evaluation pipeline for the reasoning model | `model/atra-4b/` |
| **Hosted gateway** | Optional project infrastructure for Telegram routing and RPC proxying | Phase 5 — not yet built |

There is also an optional community token, `$ATRA`. Holding it is not required
to download, run, modify or use anything here. See [Token disclosure](#token-disclosure).

## What is real today

| Claim | Status |
|---|---|
| Wallets are generated locally and encrypted at rest | Verified by 308 tests |
| A wrong password cannot export a key | Verified by test |
| No private key appears in logs, the database, API responses or audit rows | Verified by test and CI log scan |
| All four chains are reachable and identity-checked | Verified live |
| Market prices are cross-checked between two providers | Verified live |
| The risk engine rejects oversized, stale, unlisted and unfunded actions | Verified by 87 tests |
| `docker compose up` reaches a healthy container | Verified in CI |
| Graceful shutdown on SIGTERM | Verified in CI |
| **Auto-trading** | Not built (Phase 3) |
| **Liquidity management** | Not built (Phase 4) |
| **Telegram bot** | Not built (Phase 4) |
| **ATRA-4B model** | **Untrained.** Pipeline exists; no run has happened |
| **Any real money has moved** | No |
| **Any performance or profit figure** | None exist, and none will be invented |

Phase reports with commands, results and honest limitations:
[Phase 1](docs/PHASE_1_REPORT.md) · [Phase 2](docs/PHASE_2_REPORT.md)

## Risk limits

A fresh install starts with deliberately small limits so you discover them in
paper mode rather than in live mode:

| Limit | Default |
|---|---|
| Max per trade | $25 |
| Max daily loss | $50 |
| Max total deployed | $250 |
| Max fee | $2 |
| Min pool liquidity | $250,000 |
| Max slippage | 0.50% |

Paper and live use the same numbers. Everything is editable from the dashboard.
See [`skills/risk-management/SKILL.md`](skills/risk-management/SKILL.md) for how
enforcement works.

## Going live

There is no switch. Live mode requires six explicit steps — acknowledgement,
re-authentication, risk review, funded wallet, gas present, adapter available —
and the emergency stop revokes it. Auto-trading itself is not yet implemented,
so today live mode changes nothing except what the runtime is willing to do
once Phase 3 lands.

## Stopping

The emergency stop is on every page. It writes one row and takes effect on the
next read; it does not depend on the model, the network or a scheduler. It
survives a restart. It does **not** sell anything — exiting positions is a
separate, deliberate action. See [`skills/emergency-exit/SKILL.md`](skills/emergency-exit/SKILL.md).

## Your keys

ATRA creates fresh agent wallets and never asks for a seed phrase. You can
export the keys at any time from the machine running ATRA, after re-entering
your password:

- EVM: raw hex or a Web3 Secret Storage v3 keystore (works with geth, ethers, MetaMask)
- Solana: `id.json` (Solana CLI) or base58 (Phantom, Solflare)

Anyone holding an exported key controls the wallet. See
[`skills/wallet/SKILL.md`](skills/wallet/SKILL.md).

## Configuration

Copy `.env.example` to `.env`. Everything is optional; ATRA boots with an empty
file. Notable settings:

| Variable | Purpose |
|---|---|
| `ATRA_RPC_BASE` etc. | Your own RPC endpoints (the defaults are keyless and rate-limited) |
| `ATRA_LLM_KIND` / `ATRA_LLM_URL` | A local Ollama or any OpenAI-compatible endpoint |
| `ATRA_AUTOLOCK_MINUTES` | Idle time before the vault locks |

No configuration file ever contains a private key or a wallet password.

## Development

```bash
cd runtime
pnpm install
pnpm run dev          # tsx watch
pnpm run test         # vitest
pnpm run lint
pnpm run typecheck
```

The frontend at the repo root is a Vite project (`npm install && npm run dev`).
In development, point its proxy at the runtime on port 3000.

Model pipeline:

```bash
cd model/atra-4b
pip install -r requirements-cpu.txt
python -m pytest tests -q
python -m data.build && python -m data.checks data/out
```

## Token disclosure

$ATRA is an optional community support token. Holding $ATRA is not required to
download, run, modify or use ATRA. Project infrastructure may be voluntarily
funded by the creator, including with creator-fee revenue received from
third-party launch platforms.

$ATRA is not equity, does not represent ownership, carries no guaranteed yield,
no revenue share, no guaranteed infrastructure funding and no expectation of
appreciation. Auto-trade and auto-LP will never require holding it.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md). No third-party
audit has been performed, and this README will not claim one until it has.

## License

MIT. See [LICENSE](LICENSE).
