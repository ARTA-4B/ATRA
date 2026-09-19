# ATRA-4B

> **Status: UNTRAINED / PIPELINE READY**
>
> No fine-tuning run has been performed. There are no ATRA-4B weights. What
> exists is a reproducible pipeline — dataset builder, validator, training
> script, evaluation suite — and a pinned upstream base model. Any claim that
> ATRA ships a trained model would be false today.

## What this is

ATRA-4B is intended to be the reasoning layer of the ATRA agent: a small
open-weight model fine-tuned for tool use and structured output over market and
on-chain evidence.

It is **not** the risk engine. It cannot sign, cannot broadcast, cannot see a
private key and cannot override a rejection. Its entire job is to read evidence
and produce a schema-valid proposal that deterministic code then accepts or
refuses. Everything in this directory is built around that boundary.

## Base model

| | |
|---|---|
| Repository | `Qwen/Qwen3-4B-Instruct-2507` |
| License | Apache-2.0 |
| Why | Permissive license, native tool-call chat template, non-thinking variant suited to structured output, and an existing QLoRA path |
| 4-bit variant | `unsloth/Qwen3-4B-Instruct-2507-bnb-4bit` (plain NF4, ~2.47 GiB resident) |

The base model is configured through `ATRA_BASE`, never hard-coded, so the
pipeline can be re-pointed without editing code.

## Layout

```
model/atra-4b/
├── README.md              this file
├── MODEL_CARD.md          the card that ships with any release
├── config/
│   └── default.yaml       every hyper-parameter, one file, version controlled
├── data/
│   ├── schema.py          the example schema and its validator
│   ├── build.py           deterministic dataset generation
│   └── checks.py          leakage, duplication and balance checks
├── train.py               QLoRA SFT
├── evaluate.py            the benchmark suite
├── export.py              merge and convert to GGUF
└── requirements-*.txt     pinned dependencies
```

## Honest status of every claim

| Claim | Status |
|---|---|
| Pipeline runs end to end on CPU with a tiny model | **Verified in CI** |
| Dataset validator catches leakage and duplicates | **Verified by tests** |
| Evaluation suite runs and produces metrics | **Verified on the untrained base** |
| ATRA-4B is trained | **False.** No run has happened |
| ATRA-4B outperforms the base model | **Unknown.** Nothing to compare |
| 4B QLoRA fits in 6 GB VRAM | **Unmeasured.** Expected marginal |

## Running it

### Validate the dataset (no GPU)

```bash
pip install -r requirements-cpu.txt
python -m data.build --out data/out --seed 42
python -m data.checks data/out
```

### Smoke-test the training script (no GPU)

Uses a 135M model so the whole loop runs on a laptop in a minute. This proves
the pipeline, not the model.

```bash
ATRA_BASE=HuggingFaceTB/SmolLM2-135M-Instruct ATRA_DEVICE=cpu \
  python train.py --max-steps 5 --output runs/smoke
```

### Real training (GPU required)

On Kaggle (T4 x2, free tier, fp16 — the T4 has no bf16):

```bash
pip install -r requirements-train.txt
ATRA_BASE=unsloth/Qwen3-4B-Instruct-2507-bnb-4bit \
ATRA_SEQ=2048 ATRA_PRECISION=fp16 \
  python train.py --config config/default.yaml --output runs/atra-4b-v0
```

### Evaluate

```bash
python evaluate.py --model runs/atra-4b-v0 --out runs/atra-4b-v0/eval.json
```

Evaluation reports are written as JSON with the exact commit, dataset hash and
seed. A report without those fields is not a result.

## What the operator needs to supply

ATRA cannot do these for you, and the pipeline says so rather than pretending:

- A Hugging Face account and write token, if you want checkpoints pushed.
- A Kaggle account with phone verification, if you want the free T4s.
- A GPU, if you want a real run at all.

Until one of those happens, the model status stays `UNTRAINED` everywhere it is
reported: in the API, in the dashboard and in the model card.
