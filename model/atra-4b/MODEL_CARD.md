# Model card: ATRA-4B

## Status

**UNTRAINED / PIPELINE READY.**

No fine-tuning run has been performed. No ATRA-4B weights exist. This card
exists so that the honest status is version-controlled alongside the pipeline,
and so the wording cannot quietly drift once a run does happen.

The release label, used verbatim in the API, the dashboard and any published
artefact until a real run completes:

> **UNTRAINED** — no fine-tuning run has been performed. Any weights
> distributed under this name are byte-identical to the upstream base model.
> The pipeline has been validated end to end, but the model has not been
> trained.

## Intended use

ATRA-4B is the reasoning layer of the ATRA agent. Given evidence that the
runtime has already gathered and dated, it produces a schema-valid structured
decision.

It is explicitly **not**:

- a risk engine — limits are enforced by deterministic code that never consults
  a model;
- a signer — it has no access to key material and no path to a transaction;
- a price oracle — it may not state a number that was not in its evidence;
- financial advice.

## Out-of-scope use

Do not use this model, trained or otherwise, to:

- decide trades without the deterministic risk engine in front of execution;
- produce prices, balances or liquidity figures from memory;
- operate on chains other than Base, BNB Smart Chain, Robinhood Chain and
  Solana.

## Base model

| | |
|---|---|
| Repository | `Qwen/Qwen3-4B-Instruct-2507` |
| 4-bit variant | `unsloth/Qwen3-4B-Instruct-2507-bnb-4bit` |
| License | Apache-2.0 |
| Revision | *to be recorded at training time* |

## Training data

Synthetic, generated deterministically from templates in `data/build.py` with a
fixed seed. No scraped data, no user data, no proprietary data.

The dataset is validated before any run and the build fails rather than warns
on:

- a prompt containing information dated after its own decision time;
- a prompt containing outcome language;
- exact duplicate prompts;
- historical splits that overlap chronologically;
- fewer than 40% refusals among trading examples;
- any of the four chains being absent.

Current build: 500 examples, 70% `NO_ACTION` among trading decisions, all four
chains represented.

## Evaluation

`evaluate.py` measures form and refusal, not profit:

| Metric | Threshold |
|---|---|
| structured_output_validity | ≥ 0.98 |
| tool_selection_accuracy | ≥ 0.85 |
| tool_argument_validity | ≥ 0.95 |
| stale_data_rejection | ≥ 0.90 |
| hallucinated_price_rate | ≤ 0.02 |
| no_action_correctness | ≥ 0.85 |
| unsupported_chain_rejection | ≥ 0.95 |
| lp_action_validity | ≥ 0.90 |

The suite is calibrated against two reference models on every run:

- an **oracle** that replays the expected answer, which must score 1.0 on every
  metric — anything less means a metric measures something other than what it
  claims;
- a **null model** returning empty strings, which must fail everything — a
  suite that scores it well is broken.

Both calibration checks currently pass. No numbers for an actual trained model
exist, because there is no trained model.

## Limitations

- Nothing about real-world performance is known. Reported limitations are
  therefore about the pipeline, not the model.
- The dataset is synthetic. It teaches the *shape* of good reasoning about
  evidence; it does not contain real market history.
- Fit of a 4B QLoRA run in 6 GB of VRAM is unmeasured and expected to be
  marginal.
- The evaluation is model-only. Agent-simulation evaluation against a paper
  ledger is a separate suite and is not reported here.

## Bias, risks and safety

The model operates on money. The mitigations are structural rather than
behavioural, because behaviour cannot be guaranteed:

- every output is schema-validated before use, and malformed output is
  discarded rather than repaired;
- every number the model states is checked against the evidence it was given,
  and invented figures are stripped and reported;
- a deterministic risk engine evaluates every proposal and cannot be overridden
  by the model, however confident it claims to be;
- the emergency stop does not involve the model at all.

## Reproducibility

Every run writes `manifest.json` recording the base model and revision, dataset
hash, seed, full config, hardware, duration, step count, final loss and peak
memory. A checkpoint without a manifest is not a result and will not be
published.

## Citation and license

Pipeline code: MIT, as the rest of ATRA. Any released weights inherit the base
model's Apache-2.0 license and must state the base model and revision.
