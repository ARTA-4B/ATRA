---
name: market-research
description: How the Research Agent gathers market evidence, what it may conclude from it, and the line between an observed fact and an interpretation.
phase: 2
---

# Market research

## What this skill does

Gathers market evidence for a token or pool on one of the four supported
chains, and describes what that evidence shows. It produces a report; it does
not produce a trade.

## The one rule

**Facts are observed. Interpretations are opinions. They are never mixed.**

Every research result has two lists:

| List | Contains | Can contain a new number? |
|---|---|---|
| `facts` | Values ATRA read from a provider or a chain, each with its source, observation time and age | Yes — these *are* the numbers |
| `interpretation` | What a model made of the facts | **No** |

A sentence in `interpretation` that states a figure not present in `facts` is
removed and logged as a hallucination. The report still ships; that sentence
does not. This is enforced in code (`checkForInventedNumbers`), and the
evaluation suite scores a model on how often it triggers it.

## Where evidence comes from

| Source | Provides | Covers |
|---|---|---|
| DexScreener | price, liquidity, volume, 24h change, pool list | all four chains |
| GeckoTerminal | price, liquidity, OHLCV candles | all four chains |
| Chain RPC | balances, token metadata, block height | all four chains |

Both market providers index Robinhood Chain under the slug `robinhood`. This
was verified live on 2026-09-20; earlier documentation marked it unverified.

## How a price is established

A token's USD price is asked of **every** provider, and the answers are
compared:

1. Each provider is asked for the price of *that token* — not for a pool that
   contains it. A pool quotes its own base token, and reading a pool price as a
   token price once reported USDC at $0.66.
2. The reported value is the **median**, which survives one provider being
   wrong.
3. The spread between providers is measured in basis points. Past 200 bps the
   price is flagged **disputed** and the research result lists the
   disagreement as an unreliable input.
4. One answer is reported as "could not be cross-checked". Zero answers is
   `null` with a reason.

A disputed price is not an error. Thin markets genuinely disagree. It is
evidence the report must show rather than hide.

## Freshness

Every fact carries `observedAt` and `ageMs`. A fact older than the freshness
policy (default 120 s for prices) is marked `stale` and listed under
`staleInputs`. When every fact is stale or missing, the result is:

```
status: INSUFFICIENT_DATA
```

That is a correct, complete answer. The agent is designed to say it does not
know. An unknown token is the common case, and it must not produce
confident-sounding prose about a market ATRA has never seen.

## When there is no model

The runtime works without a reasoning model. The research agent then returns
the facts, an empty interpretation, and:

```
modelStatus: UNAVAILABLE
summary: "Observed N data points. No reasoning model is available, so this
          report contains observations only."
```

A model call that fails degrades to the same shape. Facts are never withheld
because an interpretation could not be produced.

## What the model is told

The system prompt states the rules directly: never state a number not in the
evidence, never guess at missing data, never recommend a trade, say when the
evidence is insufficient, reply only with JSON. The evidence is rendered as a
list with source and age on every line.

The model never sees: private keys, passwords, session tokens, provider API
keys, or any wallet secret. A prompt that would contain key material is
refused before it is sent.

## What this skill will not do

- rank tokens by anything ATRA has not verified — that would be an implicit
  recommendation;
- invent a price for a token no provider knows;
- promote an interpretation into a fact;
- propose an action. That is the Trader Agent's job (Phase 3), and it starts
  from this report rather than from raw data.

## Model status

The reasoning model is **UNTRAINED**. Every research result says so in
`modelStatus`, and so does the API's `/meta` endpoint. This label changes only
when a training run has actually completed and its manifest is committed.

## Related

- `skills/onchain-analysis/SKILL.md` — reading chain state
- `skills/risk-management/SKILL.md` — what happens to a proposal afterwards
- `model/atra-4b/MODEL_CARD.md` — the model's honest status
