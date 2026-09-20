# ATRA-4B: status, run log and how to train it

Written for: anyone asking whether the model is real, and the maintainer
running the next attempt. State on 2026-09-20.

## Status: UNTRAINED

**No ATRA-4B weights exist.** No fine-tuning run has completed. No
`evaluate.py` result exists for any trained checkpoint. The label
`UNTRAINED` appears in the runtime's `/api/v1/meta`, in every research and
trading response, in the dashboard, in `model/atra-4b/MODEL_CARD.md`, and CI
fails if it is removed while no training manifest is committed
(`.github/workflows/ci.yml`, "Model status must stay honest").

A Kaggle training run is **in progress** as this is written. It has not
completed. It may fail like the five before it. Nothing in this repository
will say the model is trained until a run completes **and** `evaluate.py`
passes against its thresholds, and the manifests, the evaluation JSON and
the GGUF checksum are committed together.

The runtime does not need ATRA-4B. It works with any local Ollama model, any
OpenAI-compatible endpoint, or no model at all (`ATRA_LLM_KIND=none`), in
which case the agents report facts and take no action. Whatever model is
configured, it proposes; the deterministic risk engine decides.

## What ATRA-4B is meant to be

A QLoRA fine-tune of `Qwen/Qwen3-4B-Instruct-2507` (Apache-2.0) on a
synthetic, deterministically generated dataset of structured decisions:
research summaries that separate facts from interpretation, trading
decisions that default to `NO_ACTION`, LP decisions that default to `HOLD`,
refusals on stale data and unsupported chains. The pipeline, the dataset
builder with its leakage checks, the training script and the evaluation
suite all exist in `model/atra-4b/` and run in CI on every push (35 Python
tests, passing on 2026-09-20; dataset build and validation; a training dry run; evaluation
calibration against an oracle, which must score 1.0 on all eight metrics,
and a null model, which must fail them).

What it is **not**: a risk engine, a signer, a price oracle or financial
advice. See `model/atra-4b/MODEL_CARD.md`.

## The run log, honestly

All runs on Kaggle, free tier, 2x Tesla T4. Each failure and its fix is a
commit in this repository; the notebook is `model/atra-4b/kaggle/atra-4b-kaggle.ipynb`
and the guide is [TRAINING_KAGGLE.md](TRAINING_KAGGLE.md), which carries the
same log in more detail.

| Run | Date | Got as far as | Failed on | Fix (commit) |
|---|---|---|---|---|
| 1 | 2026-09-20 | the dependency cell | `transformers==4.62.1` and `huggingface_hub==0.38.2` were never published; also found that `torch.cuda.is_bf16_supported()` returns true on a T4, which has no bf16 hardware | pins corrected against the index; `train.py` decides from the compute capability (`1c81bc7`, `fdb4501`) |
| 2 | 2026-09-20 | dependencies, clone, dataset (1,000 examples), checks, dry run, 4-bit load (33 M trainable of 2.24 B) | the first backward pass: the Trainer enabled `nn.DataParallel` for two GPUs and a bitsandbytes 4-bit model lives on one device | pin to `CUDA_VISIBLE_DEVICES=0`; `set -o pipefail` so `tee` no longer hides a failure; stop installing a CPU torch over the CUDA one (`5dd3d1f`) |
| 3 | 2026-09-20 | single GPU, 5.40 GiB peak, into training | one step in: the fp16 AMP scaler met bfloat16 gradients because the checkpoint is stored in bfloat16 | load the model in the dtype it trains in (`adbf732`) |
| 4 | 2026-09-20 | printed `dtype: torch.float16` | the same bfloat16 unscale error: the adapter weights were still bfloat16 | cast every trainable parameter to float32 after `get_peft_model`; pick the dtype keyword from the installed transformers' signature (`50f3c0a`) |
| 5 | 2026-09-20 | printed `trainable dtype: torch.float32` | the same error again: mixed precision is owned by accelerate, not `SFTConfig`, so autocast ran in a dtype the scaler was not built for | decide the AMP mode once, export `ACCELERATE_MIXED_PRECISION`, add an `ATRA_AMP` override; the notebook runs `off` (plain float32, no scaler) (`5041105`) |
| 6 | 2026-09-20 | **in progress** | | |

What the failures have in common: every one was an environment or precision
mismatch found only by running on the real hardware, and every one was fixed
by making `train.py` decide from what it observes rather than from what a
version string implies. None of them was a dataset or evaluation defect,
because those parts run in CI on every push. Training itself is unproven.

## How to train it yourself

Follow [TRAINING_KAGGLE.md](TRAINING_KAGGLE.md). In outline:

1. A phone-verified Kaggle account (free; the GPU and internet access need
   the verification). No Hugging Face account is required unless you want to
   upload the adapter to a private repository of your own; no API key of any
   kind is involved.
2. Import `model/atra-4b/kaggle/atra-4b-kaggle.ipynb`, select GPU T4 x2 and
   Internet on, `Save & Run All`. One to four hours unattended.
3. Download `atra-export/atra-4b-q4_k_m.gguf`, the `Modelfile`, and both
   manifests.
4. Serve it: `ollama create atra-4b -f Modelfile`, then in `.env`
   `ATRA_LLM_KIND=ollama`, `ATRA_LLM_URL=http://127.0.0.1:11434`,
   `ATRA_LLM_MODEL=atra-4b`.
5. Evaluate before naming it: `python evaluate.py --model http://127.0.0.1:11434 --model-name atra-4b-v0 --out eval-atra-4b-v0.json`.
   It scores structured-output validity, tool selection, argument validity,
   stale-data rejection, hallucinated-price rate, `NO_ACTION` correctness,
   unsupported-chain rejection and LP-action validity against the thresholds
   in `config/default.yaml`, and exits non-zero on any miss.

Only when it passes: commit the evaluation JSON, both manifests and the GGUF
sha256 together, update `MODEL_CARD.md`, and change the status label.
Fallbacks if the weekly Kaggle quota runs out are in the guide (RunPod, about
one to two dollars a run; a local RTX 3050 6 GB is expected to be marginal
for the 4B model and has not been measured).

## Evaluating any model against the same suite

The evaluation does not care where the model came from. Point it at any
OpenAI-compatible or Ollama endpoint and it reports the eight metrics. A
model that fails `NO_ACTION` correctness or hallucinated-price rate is not a
model to put in front of the risk engine, even though the engine would
reject its bad proposals: it would be noisy and expensive, and the engine's
job is to be the last line, not the first.

## What the model can never do, trained or not

- see a private key (`llm/provider.ts` refuses a prompt containing one);
- sign or broadcast (no import path from an agent to a signer);
- override a risk rejection (the engine does not import the model);
- state a number that was not in its evidence (invented figures are
  stripped from research and the reply recorded as a hallucination);
- be required for the emergency stop.
