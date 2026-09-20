# ATRA

**An open-source autonomous crypto agent that runs on your machine.**

ATRA creates isolated agent wallets, lets you fund them with your own capital,
researches markets on four chains, and, only after you explicitly turn it on,
trades and manages liquidity within limits you set. It is controlled from a
local dashboard and, optionally, from Telegram.

Your private keys never leave your computer. PAPER mode is the default. The
reasoning model proposes; deterministic code decides.

> **Status on 2026-09-20.** Phases 1 to 4 of 5 are built and verified (wallet
> vault, risk engine, market data, research, paper and live trading paths,
> auto-LP, Telegram). Phase 5 (gateway services, project treasury, this
> release) is in progress in this tree. **No live trade or LP position has ever
> been executed by this project.** The ATRA-4B model is **UNTRAINED**: a
> Kaggle training run is in progress and has not completed. No third-party
> security audit has been performed. See [What is real today](#what-is-real-today).

---

## Four things with the same name

They are separate, and it matters which one you are looking at.

| | What it is | Who runs it | Where |
|---|---|---|---|
| **ATRA Runtime** | The agent: vault, risk engine, chain adapters, trading and LP pipelines, local API and dashboard. Self-hosted. **Yours.** | You, on your machine | [`runtime/`](runtime/), dashboard at the repo root |
| **ATRA hosted gateway** | Optional project infrastructure: a Cloudflare Worker that relays Telegram to your runtime (and, in Phase 5 work, proxies RPC, market data and inference). **Not deployed today.** The runtime works without it. | The project, once deployed | [`gateway/`](gateway/), [`gateway/README.md`](gateway/README.md) |
| **ATRA-4B** | A fine-tune of Qwen3-4B for the trader and research agents. **UNTRAINED**: the pipeline exists, no completed run does. The runtime works with any local Ollama or OpenAI-compatible model, or with none. | You, if you train and serve it | [`model/atra-4b/`](model/atra-4b/), [docs/model-training.md](docs/model-training.md) |
| **$ATRA** | An optional community support token. **Not required for anything here** and carries no rights. | Nobody in this repository | [docs/token-disclosure.md](docs/token-disclosure.md) |

## The four chains

| Chain | Family | Chain id | Trade | Auto-LP |
|---|---|---|---|---|
| Base | EVM | 8453 | Aerodrome v2 | Aerodrome v2 |
| BNB Smart Chain | EVM | 56 | PancakeSwap v2 | PancakeSwap v2 |
| Robinhood Chain | EVM | 4663 | observe only | observe only |
| Solana | Solana | mainnet-beta | Jupiter v6 | observe only |

Exactly these. ATRA never substitutes one chain for another.

## Install

```bash
git clone https://github.com/lamaokamg-hub/ATRA.git
cd ATRA
docker compose up -d
```

Open http://127.0.0.1:3000 and complete first-run setup: choose a password,
create the agent wallets, pick your chains, review the default risk limits.
You start in **PAPER** mode. The port is published to `127.0.0.1` only.

`scripts/atra.sh install|start|stop|status|update|logs|backup` (and
`scripts\atra.ps1` on Windows) wrap the same commands. Without Docker: Node 24,
`cd runtime && pnpm install && pnpm run build && pnpm start`. Details, upgrade
and uninstall: [docs/deployment.md](docs/deployment.md).

## How it works

```
research (facts only) -> trader / LP agent (proposes) -> deterministic proposal
  -> risk engine (33+ checks, no model) -> allowlists -> executor
       PAPER: pessimistic simulated fill        LIVE: simulate, sign in the vault,
                                                 record hash, broadcast, book what
                                                 the chain reports
```

The model cannot sign, broadcast, see a key or override a rejection. The
emergency stop writes one row and works with the model offline. Every layer
and the file that owns it: [docs/architecture.md](docs/architecture.md).

## What is real today

Counted on 2026-09-20 in this checkout. Test counts move; the phase reports
carry the exact commands.

| Claim | Status |
|---|---|
| Wallets are generated locally and encrypted at rest (Argon2id, XChaCha20-Poly1305) | Verified by test; the runtime suite passes: 497 tests on the last commit, 543 in this checkout with the Phase 5 work |
| A wrong password cannot unlock the vault or export a key | Verified by test |
| No private key appears in logs, the database file, API responses, audit rows or Telegram replies | Verified by test and CI log scan |
| All four chains are reachable and identity-checked | Verified live (Phase 1, 2) |
| Market prices are cross-checked between two providers; stale data is refused | Verified live and by test |
| The risk engine is a pure function that rejects oversized, stale, unlisted, unfunded and duplicate actions | Verified by 138 tests |
| `docker compose up` reaches a healthy container; SIGTERM shuts down cleanly | Verified in CI |
| Auto-trading, PAPER | Built and tested end to end: research, decision, proposal, risk engine, paper fill |
| Live execution path (Solana, BSC, Base) | Built; verified against mainnet up to, not including, signing; **no live trade has ever been executed** |
| Auto-LP (Aerodrome v2, PancakeSwap v2), PAPER and LIVE paths | Built and tested; **no live LP position has ever been opened**; two known defects recorded in [Phase 4](docs/PHASE_4_REPORT.md) |
| Telegram remote control (pairing, commands, notifications) | Built and tested against fakes; **no bot exists and no message has ever been sent** |
| Hosted gateway | Built and tested in workerd (49 tests on the last commit, 95 in this checkout); **not deployed**; being extended for Phase 5 with read-only RPC and market proxies |
| Project treasury | Phase 5, in progress; watch-only by construction, never touches user wallets |
| Withdrawals | Built; operator-only, re-authentication and typed confirmation; work in PAPER mode |
| Encrypted backup and restore | [scripts/backup.sh](scripts/backup.sh) / [restore.sh](scripts/restore.sh) and PowerShell twins; verified with a round trip on a throwaway install |
| ATRA-4B | **UNTRAINED.** Five Kaggle runs failed on environment defects, each fixed in git; a sixth is in progress and has not completed |
| Any real money moved by this project | No |
| Any performance, profit or user figure | None exist, and none will be invented |
| Third-party security audit | None |

Phase reports: [1](docs/PHASE_1_REPORT.md) · [2](docs/PHASE_2_REPORT.md) ·
[3](docs/PHASE_3_REPORT.md) · [4](docs/PHASE_4_REPORT.md).

## Risk limits

A fresh install starts small so you meet the limits in PAPER mode: $25 per
trade, $50 daily loss, $250 deployed, $2 fee, $250,000 minimum pool liquidity,
0.50 % slippage, LP automation off. PAPER and LIVE use the same numbers. The
rules and the order they run in: [skills/risk-management/SKILL.md](skills/risk-management/SKILL.md).

## Going live, and stopping

There is no switch. LIVE needs six explicit steps in one sitting plus a
re-authentication, drops back to PAPER on every restart, on any policy change
and on the emergency stop, and expires after 12 hours. The exact differences
between the modes: [docs/paper-vs-live.md](docs/paper-vs-live.md).

The emergency stop is one row in the local database, needs no password to
engage, survives restarts and does not sell anything:
[skills/emergency-exit/SKILL.md](skills/emergency-exit/SKILL.md).

## Your keys, and your backups

ATRA never asks for a seed phrase. Export the agent keys from the machine
running ATRA after re-entering your password (raw hex, keystore v3, `id.json`,
base58). Back up the encrypted database with your own passphrase; restore it
on any machine with the same dashboard password:
[docs/wallet-recovery.md](docs/wallet-recovery.md).

## Documentation

| Read this for | File |
|---|---|
| Every layer, the file that owns it, what talks to what | [docs/architecture.md](docs/architecture.md) |
| Threat model, key hierarchy, what is never logged, the LIVE path | [docs/security-model.md](docs/security-model.md) |
| PAPER vs LIVE, exactly | [docs/paper-vs-live.md](docs/paper-vs-live.md) |
| Backup, restore, export, moving to a new machine | [docs/wallet-recovery.md](docs/wallet-recovery.md) |
| Docker, bare Node, upgrade, uninstall, the scripts | [docs/deployment.md](docs/deployment.md) |
| Telegram: pairing, commands, what it can never do | [docs/telegram.md](docs/telegram.md) |
| ATRA-4B: status, the run log, how to train it yourself | [docs/model-training.md](docs/model-training.md), [docs/TRAINING_KAGGLE.md](docs/TRAINING_KAGGLE.md) |
| The project treasury (Phase 5) | [docs/treasury.md](docs/treasury.md) |
| The support token, in plain words | [docs/token-disclosure.md](docs/token-disclosure.md) |
| The release gate, with what was verified and how | [docs/SECURITY_RELEASE_CHECKLIST.md](docs/SECURITY_RELEASE_CHECKLIST.md) |
| The local HTTP API | [docs/api.md](docs/api.md) |
| Reporting a vulnerability | [SECURITY.md](SECURITY.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| Agent skills (how each agent is allowed to behave) | [skills/](skills/) |

## Token disclosure

$ATRA is an optional community support token. Holding $ATRA is not required to
download, run, modify, or use ATRA. Project infrastructure may be voluntarily
funded by the creator, including with creator-fee revenue received from
third-party launch platforms.

$ATRA is not equity and does not represent ownership. It carries no guaranteed
yield, no guaranteed revenue share, no guaranteed infrastructure funding and
no expectation of appreciation. Auto-trade and auto-LP do not and will not
require holding it. Full text: [docs/token-disclosure.md](docs/token-disclosure.md).

## Security

Report vulnerabilities privately: [SECURITY.md](SECURITY.md). No third-party
audit has been performed; the release checklist records what has actually
been verified and what has not.

## License

MIT. See [LICENSE](LICENSE).
