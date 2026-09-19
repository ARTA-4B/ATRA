# Phase 2 report

**Date:** 2026-09-20
**Scope:** four-chain data, market layer, Research Agent, LLM abstraction, ATRA-4B training pipeline.

Written for: an engineer picking this repository up, and anyone asking whether the model is real.

---

## The short version

ATRA can now retrieve dated, attributed market and chain data for all four
chains, cross-check prices between two independent providers, and produce a
research report that separates what it observed from what a model thinks. It
refuses to state what it does not know.

The ATRA-4B model is **UNTRAINED**. A complete, tested, reproducible pipeline
exists; no training run has been performed. That label appears in the API, the
dashboard, the model card and this report, and CI fails if it is removed
without a manifest to justify it.

---

## What exists

| Requirement | State | Evidence |
|---|---|---|
| Normalized chain adapter interface | Done | `runtime/src/chains/types.ts` |
| EVM adapter for Base, BSC, Robinhood Chain | Done | live-verified against all three |
| Solana adapter | Done | live-verified; dependency-free JSON-RPC |
| Chain identity verification | Done | chain id / genesis hash checked before trust |
| Custom RPC overrides | Done | `ATRA_RPC_*` |
| Normalized market schema | Done | `runtime/src/market/types.ts` |
| Two keyless providers, all four chains | Done | DexScreener, GeckoTerminal |
| Cross-source price comparison | Done | median + deviation + `disputed` flag |
| Staleness detection | Done | every snapshot carries its age |
| Research Agent | Done | `runtime/src/agents/research/agent.ts` |
| Facts separated from interpretation | Done | invented numbers stripped and reported |
| `INSUFFICIENT_DATA` on thin evidence | Done | test |
| LLM abstraction, structured output only | Done | `runtime/src/llm/provider.ts` |
| Market API for the dashboard | Done | `/api/v1/market/*`, `/watchlist` |
| ATRA-4B dataset schema, builder, checks | Done | `model/atra-4b/data/` |
| Leakage checks | Done | timestamp, phrase and outcome-note checks |
| Chronological split for historical data | Done | overlap fails the build |
| Training script (QLoRA SFT) | Done | `train.py`, manifest on every run |
| Evaluation suite | Done | 8 metrics, calibrated |
| Model card | Done | `MODEL_CARD.md`, status UNTRAINED |
| Skills: market-research, onchain-analysis | Done | `skills/` |

Not built in this phase: the installation-token client for a hosted gateway
(the gateway itself is Phase 5; the runtime defaults to public RPC and BYOK,
which is what the spec asks for as the fallback anyway).

---

## Commands and their results

`runtime/`:

| Command | Result |
|---|---|
| `pnpm run lint` | clean |
| `pnpm run typecheck` | clean |
| `pnpm run format:check` | clean |
| `pnpm run test` | **308 passing** (58 new this phase) |
| `pnpm run build` | clean |

`model/atra-4b/`:

| Command | Result |
|---|---|
| `python -m pytest tests -q` | **35 passing** |
| `python -m data.build --seed 42 --per-domain 100` | 500 examples (420 / 35 / 45) |
| `python -m data.checks data/out` | no errors; 70% `NO_ACTION`; all four chains |
| `python train.py --dry-run` | dataset validated, no model loaded |
| `python evaluate.py --model oracle` | 8/8 metrics at their best value |
| `python evaluate.py --model echo` | 7/8 metrics at their floor (exit 1, as intended) |

All of the above run in CI on every push. Both workflows are green.

---

## Verification that was actually performed

### Live provider probes (2026-09-20)

| Chain | Token | Median price | Providers | Spread |
|---|---|---|---|---|
| Base | USDC | 0.9946 | 2 | 54 bps |
| Base | WETH | 2643.71 | 2 | 24 bps |
| BSC | USDT | 0.9984 | 2 | 10 bps |
| Robinhood | WETH | 2643.99 | 2 | 19 bps |
| Solana | USDC | 1.00013 | 1 | — (reported as not cross-checkable) |

**Both providers index Robinhood Chain** under the slug `robinhood`. The
research specification had marked this unverified. Uniswap v4 pools on
Robinhood Chain with $24M liquidity were returned.

A full end-to-end run through the HTTP API — setup, wallets, market query,
research — against real providers returned facts with sources and ages,
`modelStatus: UNAVAILABLE` (no model configured), an empty interpretation and
zero hallucinations. Which is exactly right for a runtime with no model.

### Model pipeline calibration

The evaluation suite is checked against two reference models on every CI run:

- an **oracle** replaying the expected answer must score 1.0 on every metric;
- a **null model** returning empty strings must fail every metric.

Both hold. A suite that passed the null model would be treated as a failing
build.

---

## Things the verification caught

These are worth recording because a pipeline that never found a defect is a
pipeline that was never really run.

**A pool price is not a token price.** The first cross-check implementation
read `priceUsd` from any pool containing the token. A pool quotes its own base
token, so USDC paired against WETH reported USDC at $0.66. Providers now expose
`getTokenPriceUsd`, and the cross-check uses only that.

**The stale-rejection metric matched "old" inside "threshold."** LP examples
were scored against a refusal they were never supposed to make. Examples now
carry explicit tags, and metrics select on those.

**The hallucination metric counted a confidence score.** `confidence: 0.85` is
the model's judgement, not a claim about the market; scanning it made the
metric fire on correct answers. Only prose fields are scanned now.

**Splits correlated with template variants.** `index % 10` for the split and
`index % 5` for the variant meant every test example came from the same
variant, so whole behaviours were never evaluated. Splits now come from a hash
of the index, and a test asserts each variant class reaches every split.

**A dataset answer contradicted its prompt.** After the generators were widened
to vary prompt values, one answer still said "45 minutes" while its prompt said
2,450 seconds. The hallucination metric flagged the oracle's own answer, which
is how the contradiction was found.

---

## Honest status of ATRA-4B

| Claim | Status |
|---|---|
| Pipeline runs end to end on CPU | Verified in CI |
| Dataset validates | Verified in CI |
| Evaluation suite is calibrated | Verified in CI |
| A training run has happened | **No** |
| Weights exist | **No** |
| Any performance number | **None exist** |
| 4B QLoRA fits in 6 GB VRAM | Unmeasured, expected marginal |

To run real training the operator needs a GPU. The documented path is Kaggle
(T4 x2, free, fp16), then Colab, then a paid rental at about $1 per run. The
operator has confirmed they hold neither a Kaggle nor a Hugging Face account
yet, so this stays `UNTRAINED` until that changes.

The base model is `Qwen/Qwen3-4B-Instruct-2507` (Apache-2.0), configured
through `ATRA_BASE` rather than hard-coded.

---

## Honest limitations

| Limitation | Label |
|---|---|
| No trained model | `UNTRAINED / PIPELINE READY` |
| Dataset is synthetic; no real market history | by design for v0 |
| OHLCV from one provider only; the other has none | GeckoTerminal only |
| GeckoTerminal free tier is 30 req/min and was rate-limited during probing | handled: 429 → provider skipped, reported |
| Research runs on demand; no scheduler yet | Phase 3 |
| The market dashboard page is the frontend's job | API is ready; UI wiring is Codex's |
| Agent-simulation evaluation (paper ledger) | Phase 3 |

---

## Acceptance criteria

| Criterion | Status |
|---|---|
| All four chain adapters compile | Yes |
| Normalized data schema exists | Yes |
| Stale data handling works | Yes — test and live |
| Research agent produces structured outputs | Yes — test and live |
| Market UI works with real or labelled data | API verified live; every response carries `source` and `asOf` |
| No live price is invented | Yes — `null` with reason; invented numbers stripped |
| Training dataset validates | Yes — CI |
| Training script is reproducible | Yes — seed, hash and manifest |
| Eval suite runs | Yes — CI, calibrated |
| Model status is truthful | Yes — `UNTRAINED`, enforced by CI |
| Tests, lint, typecheck pass | Yes — CI |

Phase 2 is complete.
