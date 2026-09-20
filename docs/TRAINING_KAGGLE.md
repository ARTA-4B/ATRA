# Training ATRA-4B on Kaggle (free T4 x2)

Written for: the ATRA maintainer running the first real fine-tune, with no prior Kaggle experience.

The whole run costs nothing and needs no API key. Kaggle gives a phone-verified
account 30 GPU-hours per week; one ATRA-4B run uses roughly one to three of
them. The base model is Apache-2.0 and downloads anonymously from Hugging Face.

> **Run log.** The notebook has been executed on Kaggle. Run 1 (2026-09-20)
> **failed** at the dependency cell: `transformers==4.62.1` and
> `huggingface_hub==0.38.2` had never been published to PyPI. Both pins are
> fixed (4.57.6 / 0.36.2, verified against the index). The same run also
> showed that `torch.cuda.is_bf16_supported()` returns **True on a Tesla T4**,
> which has no bf16 hardware; `train.py` now decides from the compute
> capability instead. Kaggle's image on that date: 2× Tesla T4 (15 GB each),
> torch 2.10.0+cu128, Python 3.12.13.
>
> Run 2 got through dependencies, the clone, the dataset (1,000 examples,
> 800/105/95, 70 % `NO_ACTION`), the checks, the dry run and the 4-bit model
> load (33 M trainable of 2.24 B, 1.48 %), then **failed in the first backward
> pass**: Hugging Face's Trainer turns on `nn.DataParallel` when it sees two
> GPUs, and a bitsandbytes 4-bit model has its weights on one device —
> `Caught AcceleratorError in replica 0 on device 0`. `train.py` now pins
> itself to `CUDA_VISIBLE_DEVICES=0` unless a distributed launcher set
> `LOCAL_RANK`. Two smaller fixes came with it: the notebook's training cell
> lacked `set -o pipefail`, so `tee` hid train.py's non-zero exit and the run
> carried on to the export (which correctly refused a failed manifest); and
> llama.cpp's converter requirements installed a **CPU** build of torch over
> Kaggle's CUDA one, so only `gguf` is installed now, with `--no-deps`.
> Both checkouts moved to `/kaggle/temp` so the notebook's output stays small.
>
> Run 3 cleared all of that — single GPU, 5.40 GiB peak, the failure stopped
> the cell — and died one step into training with
> `"_amp_foreach_non_finite_check_and_unscale_cuda" not implemented for
> 'BFloat16'`. The checkpoint is stored in bfloat16 and `from_pretrained`
> kept it, so fp16 AMP's gradient scaler met bfloat16 gradients. `train.py`
> now loads the model in the same dtype it trains in.
>
> Run 4 printed `dtype: torch.float16` and hit the **same** bfloat16 unscale
> error, which ruled the checkpoint out as the source: the adapter weights
> were the bfloat16 ones. `train.py` now casts every trainable parameter to
> float32 after `get_peft_model` (the standard QLoRA recipe) and prints the
> dtypes it actually observes, and it picks the `dtype` / `torch_dtype`
> keyword from the installed transformers' signature instead of assuming.
>
> Run 5 printed `trainable dtype: torch.float32` and failed with the same
> bfloat16 unscale error, which rules the parameters out too: mixed precision
> is owned by **accelerate**, not by `SFTConfig`, so autocast can run in a
> dtype the Trainer's scaler was not built for. `train.py` now decides the AMP
> mode once, exports it as `ACCELERATE_MIXED_PRECISION`, prints it, and takes
> an `ATRA_AMP` override (`fp16` / `bf16` / `off`). The notebook runs `off`:
> plain float32 with no scaler and no autocast, which cannot disagree with
> itself. It is slower, and the 4-bit matmuls still run in float16 inside
> bitsandbytes.
>
> Run 6 trained. Run 7 exported it, and run 8 evaluated it — against the
> served GGUF, with the thresholds in `config/default.yaml` — and **seven of
> the eight metrics missed**. The numbers are in "The evaluation run" below.
> The label stays **UNTRAINED**: a finished training run is not an evaluated
> model, and this one has now been evaluated and did not pass.

## 1. Accounts (10 minutes)

| Account | Needed for | Cost |
|---|---|---|
| Kaggle (kaggle.com) | the GPU | free; **phone verification required** for GPU and internet access (Settings → Phone verification) |
| Hugging Face (huggingface.co) | **optional** — only to upload the trained adapter to a private repo of your own | free |
| RunPod | **optional fallback** if the weekly Kaggle quota runs out; prepaid (minimum top-up around $10), a run costs about $1–2 on a community RTX 3090/4090 | paid |

No Qwen, Alibaba or OpenAI key is involved anywhere in this process.

## 2. Create the notebook (5 minutes)

1. Kaggle → **Create** → **New Notebook**.
2. **File → Import Notebook** → upload `model/atra-4b/kaggle/atra-4b-kaggle.ipynb` from this repository.
3. Right-hand panel → **Session options**:
   - Accelerator: **GPU T4 x2**
   - Internet: **On** (needed for `git clone`, `pip` and the model download)
   - Persistence: *Files only* (optional; keeps `/kaggle/working` between sessions)
4. Optional: **Add-ons → Secrets** → add `HF_TOKEN` only if you want the run to
   push the adapter to your own private Hugging Face repository. Leave it out
   otherwise; the notebook never uploads by default.

## 3. Run it (1–4 hours, unattended)

Click **Save Version → Save & Run All (Commit)**. This runs the notebook in
the background with the 12-hour limit; you can close the tab. Progress is
under **Your Work → the notebook → Logs**.

What each section does and what "good" looks like:

| Step | Command | Expect |
|---|---|---|
| GPU check | `nvidia-smi` | two Tesla T4, 15 GiB each |
| Dependencies | `pip install …` pinned | `deps ok 4.57.6 0.27.0 0.19.1 0.50.2` |
| Clone | `git clone ARTA-4B/ATRA` | a commit hash |
| Dataset | `python -m data.build --seed 42 --per-domain 200` | about 1,000 examples, split roughly 84/7/9 |
| Checks | `python -m data.checks data/out` | `no errors`, `NO_ACTION` ratio ≥ 0.40, four chains present |
| Dry run | `python train.py --dry-run` | dataset hash printed, exits before loading a model |
| Train | `ATRA_SEQ=2048 python train.py --output /kaggle/working/runs/atra-4b` | loss decreasing over ~250 steps; `manifest.json` with `"status": "completed"` |
| Export | `python export.py --adapter … --gguf q4_k_m --llama-cpp …` | `atra-4b-q4_k_m.gguf` (~2.5 GB), `Modelfile`, `export-manifest.json` |

If training stops with **CUDA out of memory**, change `ATRA_SEQ=2048` to
`ATRA_SEQ=1024` in the training cell and run again. Nothing else needs to
change.

## 4. Download the results

Open the finished version → **Output** tab. Download:

- `atra-export/atra-4b-q4_k_m.gguf` and `atra-export/Modelfile` (to serve locally);
- `runs/atra-4b/manifest.json` and `atra-export/export-manifest.json` (provenance; commit these to the repository under `model/atra-4b/runs/<date>/`).

## 5. Serve it on your machine

```
ollama create atra-4b -f Modelfile
ollama run atra-4b "Reply with the JSON {\"ok\": true}"
```

Point the runtime at it (`.env`):

```
ATRA_LLM_KIND=ollama
ATRA_LLM_URL=http://127.0.0.1:11434
ATRA_LLM_MODEL=atra-4b
```

## 6. Evaluate before naming it

```
cd model/atra-4b
python evaluate.py --model http://127.0.0.1:11434 --model-name atra-4b-v0 --out eval-atra-4b-v0.json
```

`evaluate.py` scores structured-output validity, tool selection, argument
validity, stale-data rejection, hallucinated-price rate, `NO_ACTION`
correctness, unsupported-chain rejection and LP-action validity against the
thresholds in `config/default.yaml`, and exits non-zero on any miss.

Downloading 2.5 GB to run this locally is optional: `model/atra-4b/kaggle/atra-4b-eval.ipynb`
does the whole thing inside one Kaggle kernel — merge, GGUF, `llama-server`,
rebuild the test split, evaluate, print every metric against its threshold.
That is how the result below was produced.

Only when it passes: commit the evaluation JSON, both manifests and the GGUF
sha256 together, update `MODEL_CARD.md`, and change the status label. Until
then the model is **UNTRAINED** everywhere the runtime reports it, and that is
correct.

## Run log

Eight attempts. The first five died in under three and a half minutes each;
the sixth trained for four hours and then failed in the export; the seventh
exported; the eighth evaluated and the model missed seven of eight thresholds.
Recorded because every one of them was a real environment fact, not a mistake
in the method.

| # | Ended in | Cause | Fix |
|---|---|---|---|
| 1 | 2 min | `transformers==4.62.1` and `huggingface_hub==0.38.2` had never been published | pinned 4.57.6 / 0.36.2, verified against PyPI |
| 2 | 3 min | HF Trainer used DataParallel across both T4s; `tee` hid the exit code; llama.cpp's requirements replaced Kaggle's CUDA torch with a CPU build | `CUDA_VISIBLE_DEVICES=0`, `set -o pipefail`, `pip install --no-deps gguf` |
| 3 | 3 min | bf16 unscale error: the model loaded in one dtype, the scaler expected another | load the model in the compute dtype |
| 4 | 3 min | same, because `dtype` and `torch_dtype` disagreed across versions | pick the keyword from `inspect.signature`, cast trainable params to fp32 |
| 5 | 3 min | same again: accelerate owns AMP, not the Trainer argument | export `ACCELERATE_MIXED_PRECISION`, add `ATRA_AMP` |
| 6 | 4 h 03 m | **training succeeded**; `export.py` raised `ImportError: Found an incompatible version of torchao. Found version 0.10.0, but only versions above 0.16.0 are supported` | `pip uninstall -y torchao` before the merge |
| 7 | 22 min | **export succeeded** (`atra12/atra-4b-export`): merged and wrote `atra-4b-q4_k_m.gguf`, 2,497,276,128 bytes, sha256 `0c4ed0bb…d3348` | — |
| 8 | 27 min | **evaluation ran** (`atra12/atra-4b-eval`): `evaluate.py` exit code **1**, seven of eight metrics below threshold | not a bug to fix; see below |

### Run 6, the one that trained

200 steps, 2 epochs over 800 training examples, one Tesla T4, 4 h 03 m, peak
GPU 4.77 GiB. Loss 2.38 → 0.046 (reported `train_loss` 0.206); mean token
accuracy 0.67 → 0.985. Manifest `status: completed`, dataset hash
`3e4faf65…632eb`, base `unsloth/Qwen3-4B-Instruct-2507-bnb-4bit` at revision
`f12db89c`, `ATRA_AMP=off`.

Why torchao ended it: peft's LoRA dispatcher calls `is_torchao_available()`
for every module it injects, and that helper *raises* on a version below
0.16.0 instead of returning False. Training never reaches it, because the
bitsandbytes dispatcher matches first on a 4-bit base. The merge loads the
base in fp16, so it does reach it. Neither path uses torchao.

### Exporting without retraining

A finished kernel's adapter is worth four hours, so it does not get thrown
away when a later cell fails. The adapter is uploaded as a private dataset
(`atra12/atra-4b-adapter-v0`, 66 MB) and a second kernel
(`atra12/atra-4b-export`) merges from it. Three things that cost a run each:

- `kernel_sources` is refused when the source kernel's last run ended in
  ERROR, which is exactly the case here. Use `dataset_sources`.
- The dataset's layout inside `/kaggle/input` is not the folder that was
  uploaded. Find `adapter_config.json` and use its parent.
- `/kaggle/temp` does not exist unless the notebook creates it; the training
  notebook did, so the export notebook had to as well.

### The evaluation run

`model/atra-4b/kaggle/atra-4b-eval.ipynb`, pushed as `atra12/atra-4b-eval`,
does the whole measurement in one kernel: pinned deps minus torchao, the
adapter staged from `atra12/atra-4b-adapter-v0`, merged into
`Qwen/Qwen3-4B-Instruct-2507` and converted to `q4_k_m`, served by
`llama-server`, the test split rebuilt with
`python -m data.build --seed 42 --per-domain 200 --out data/out`, and
`evaluate.py` run against `http://127.0.0.1:8080`. It carries `evaluate.py`,
`export.py`, `config/default.yaml` and the `data` package verbatim and prints
a sha256 per file, so the result can be tied to an exact revision of the
harness it was scored by.

Run of 2026-09-20 18:55 UTC, 27 minutes, one Tesla T4. The GGUF came out
byte-identical to the export kernel's (sha256 `0c4ed0bb…d3348`), the rebuilt
split was the same 95 test examples the training run held out, and 95 of 95
replies were valid JSON.

| Metric | Score | Threshold | Verdict | Margin |
|---|---|---|---|---|
| `structured_output_validity` | 1.000 (95/95) | ≥ 0.98 | **pass** | +0.020 |
| `tool_selection_accuracy` | 0.000 (0/8) | ≥ 0.85 | **FAIL** | −0.850 |
| `tool_argument_validity` | 0.000 (0/8) | ≥ 0.95 | **FAIL** | −0.950 |
| `stale_data_rejection` | 0.429 (6/14) | ≥ 0.90 | **FAIL** | −0.471 |
| `hallucinated_price_rate` | 0.053 (4/76 offend) | ≤ 0.02 | **FAIL** | +0.033 over |
| `no_action_correctness` | 0.474 (9/19) | ≥ 0.85 | **FAIL** | −0.376 |
| `unsupported_chain_rejection` | 0.000 (0/5) | ≥ 0.95 | **FAIL** | −0.950 |
| `lp_action_validity` | 0.263 (5/19) | ≥ 0.90 | **FAIL** | −0.637 |

`evaluate.py` exit code 1. **The model is not ATRA-4B v0.1 and the UNTRAINED
label does not move.**

What the failures look like is more useful than the scores. The model has
learned the *form* — every reply is a bare JSON object, no prose, no fences,
using ATRA's own vocabulary (`NO_ACTION`, `INSUFFICIENT_DATA`,
`requestedNotionalUsd`) — and then applies the wrong domain's schema:

- an LP question answered `{"decision": "REBALANCE", …}` — right verb, wrong
  key, so `lp_action_validity` reads no `action` at all;
- a chain-knowledge question answered with a trading decision
  (`chain` / `confidence` / `market` / `requestedNotionalUsd`);
- a tool question answered with a refusal instead of a tool call, which is why
  `tool_selection_accuracy` is a clean zero rather than a low number;
- one reply invented the LP action `COLLECT_CREDENTIALS`, which is
  `COLLECT_FEES` with the wrong tail.

The leading explanation is a train/eval prompt skew, not a training failure.
`train.py:render_example` renders each example with
`tokenizer.apply_chat_template(messages, tools=tools, …)`, so every one of the
800 training prompts carried the four tool schemas inside the system block.
`evaluate.py:EndpointModel.generate` posts only `messages`; it never sends
`tools`. The served endpoint reported `prompt_tokens` of 91–119 with
`cached_tokens: 70` — the 70-token `SYSTEM_PROMPT` and nothing else, where the
rendered tool block is several hundred tokens. The model is therefore scored on
a prompt prefix it never saw once in training, and the first thing that
degrades out of distribution is picking which schema the question wants.

That is a finding about the harness, not a licence to change the number. The
honest next step is the owner's call between three options, in this order:

1. make training and evaluation agree on the prompt — either send `tools` from
   `EndpointModel`, or stop rendering them in `render_example` — and re-run
   this kernel unchanged;
2. if they already agree by intent, the 200-step run is simply not enough and
   the answer is more training, not a lower threshold;
3. nothing in `config/default.yaml` gets relaxed to make a checkpoint pass.

### The second evaluation run, with the harness fixed

`evaluate.py` was fixed on 2026-09-21 (commit `5ad3329`): `EndpointModel.generate`
now sends the tool schemas with the prompt, in the same OpenAI shape
`train.py:render_example` hands to `apply_chat_template`. The kernel was
re-pushed with that file refreshed in its embedded blob (sha256
`8a69516b…c3fc3`) and nothing else about the measurement changed — same
thresholds, same `--seed 42 --per-domain 200` build, same `temperature 0`,
same GGUF.

It took two attempts to get a run that measured anything, and the first of them
is the more useful finding.

**Attempt 2 (kernel version 2) stopped at the probe.** A check added to the
probe cell sends one tool_use prompt twice, with and without `tools`, and
compares the prompt length. Both came back **91 tokens**. `evaluate.py` was
sending the schemas correctly; `llama-server` was discarding them, because the
GGUF has no chat template at all:

- `train.py` saves the tokenizer with `save_pretrained`, and transformers 4.57
  writes the chat template to a separate `chat_template.jinja` rather than into
  `tokenizer_config.json`;
- that file is not among the adapter's uploaded files — the kernel prints the
  listing, and it is not there;
- `export.py` rebuilds the tokenizer with
  `AutoTokenizer.from_pretrained(adapter)`, so it has no template to pass on;
- `convert_hf_to_gguf.py` finds none to embed;
- `llama-server` falls back to its built-in default template, which has no
  `tools` block, so the schemas are dropped in silence.

So the **first** evaluation had two skews, not one. The notebook now recovers
the template from the base model and revision the training manifest names —
`unsloth/Qwen3-4B-Instruct-2507-bnb-4bit` at `f12db89c…`, sha256
`40c21f34…f7b541`, the same tokenizer that rendered all 800 training prompts —
and passes it with `--chat-template-file`. The weights are untouched: the GGUF
stays byte-identical at 2,497,276,128 bytes.

**Attempt 3 (kernel version 3) ran to COMPLETE**, 2026-09-20 22:36 UTC, 965s of
evaluation, CPU llama.cpp build (the CUDA configure fails on Kaggle:
`CUDA::cuda_driver` target not found; at temperature 0 this costs speed, not
output). The tools reached the model this time, and the token counts say so:

| | prompt tokens |
|---|---|
| same prompt without `tools` | 91 |
| same prompt with `tools` | **511** |
| first request of the run, all uncached | 511 |
| steady state during the run | 511–538, of which 490 cached prefix |

| Metric | Score | Threshold | Verdict | Margin |
|---|---|---|---|---|
| `structured_output_validity` | 0.168 (16/95) | ≥ 0.98 | **FAIL** | −0.812 |
| `tool_selection_accuracy` | 0.250 (2/8) | ≥ 0.85 | **FAIL** | −0.600 |
| `tool_argument_validity` | 0.125 (1/8) | ≥ 0.95 | **FAIL** | −0.825 |
| `stale_data_rejection` | 0.000 (0/14) | ≥ 0.90 | **FAIL** | −0.900 |
| `hallucinated_price_rate` | 0.053 (4/76 offend) | ≤ 0.02 | **FAIL** | +0.033 over |
| `no_action_correctness` | 0.053 (1/19) | ≥ 0.85 | **FAIL** | −0.797 |
| `unsupported_chain_rejection` | 0.000 (0/5) | ≥ 0.95 | **FAIL** | −0.950 |
| `lp_action_validity` | 0.000 (0/19) | ≥ 0.90 | **FAIL** | −0.900 |

`evaluate.py` exit code 1, eight of eight metrics below threshold. **The
UNTRAINED label does not move.**

#### Read this number with the caveat attached

`structured_output_validity` fell from 1.000 to 0.168, and that is not a
statement about the model. Sending `tools` also switches on llama.cpp's
Hermes tool-call parser, which rewrites the reply before it is returned, and
`evaluate.py` reads `message.content` only. The arithmetic in the probe output
shows content going missing:

- `chain_knowledge-00001`: **4** completion tokens generated, content came back
  as `</tool_call>\n\n</tool_call>` — about nine tokens, *more* text than was
  generated, so the parser added a healed closing tag;
- `lp_reasoning-00001`: **77** completion tokens generated, content came back as
  `</tool_call>` and two newlines — roughly seventy tokens gone;
- `market_reasoning-00001`: **34** generated, same near-empty content;
- `tool_use-00001`: **42** generated, content survived, and the model produced
  ATRA's own JSON — `{"arguments": {"chain": "base", "pool_id": "0xpool1"},
  "reason": …, "tool": "get_ohlcv"}` — with a stray `</tool_call>` in front of
  it and `timeframe` missing.

Across the whole run, `llama-server` logged 102 requests with a median of 36
and a total of 4,252 generated tokens; only 21 of those requests generated five
tokens or fewer. Yet 79 of 95 replies contained no parseable JSON. The model
was generating; most of what it generated did not reach the scorer.

Part of that is a real finding: the Qwen3 tools block instructs the model to
wrap calls in `<tool_call>…</tool_call>`, ATRA's 200 training steps taught it to
emit a bare JSON object instead, and the model now does neither cleanly — it
leaks a closing tag and then writes ATRA's JSON. That is what an
under-trained model looks like when the system block and the fine-tune disagree.
But the split between "the model degraded" and "the parser ate the answer"
cannot be read off these numbers, so no per-metric value here should be quoted
as the model's score.

What can be said without qualification: the prompt skew is fixed and proven
fixed at 91 → 511 tokens; `tool_selection_accuracy` moved off a clean zero to
2/8 and `tool_argument_validity` to 1/8, which is the model picking the right
tool when its answer survived; and the run failed, on every metric, by margins
no amount of harness repair closes.

#### The next call, and it is not this agent's

1. Serving has to stop eating the reply. `evaluate.py` posts to
   `/v1/chat/completions` with `tools` and reads `content`; llama.cpp will
   always run its tool-call parser on that path. Matching training exactly means
   rendering the prompt with the template and reading raw text back — a
   different serving path, which is a design decision about how ATRA serves a
   tool-using model, not a harness patch.
2. `chat_template.jinja` should travel with the adapter, or `export.py` should
   take the tokenizer from the base model rather than the adapter directory.
   Until then every GGUF this pipeline produces is served with the wrong
   template by default.
3. Both evaluations failed, and on the evidence 200 steps is not enough. The
   answer is more training.
4. Nothing in `config/default.yaml` gets relaxed to make a checkpoint pass.

## Fallback: RunPod

Same notebook logic as a shell script. Pick a *Community Cloud* RTX 3090 or
4090 pod with the PyTorch template, open a terminal, and run the commands from
the notebook cells in order (skip the Kaggle-specific paths: use `~/work`
instead of `/kaggle/working`). Stop the pod when the export finishes; billing
is per minute.
