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
> Training itself is still unproven. Do not edit the UNTRAINED label until a
> run completes **and** `evaluate.py` passes.

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
| Clone | `git clone lamaokamg-hub/ATRA` | a commit hash |
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

Only when it passes: commit the evaluation JSON, both manifests and the GGUF
sha256 together, update `MODEL_CARD.md`, and change the status label. Until
then the model is **UNTRAINED** everywhere the runtime reports it, and that is
correct.

## Fallback: RunPod

Same notebook logic as a shell script. Pick a *Community Cloud* RTX 3090 or
4090 pod with the PyTorch template, open a terminal, and run the commands from
the notebook cells in order (skip the Kaggle-specific paths: use `~/work`
instead of `/kaggle/working`). Stop the pod when the export finishes; billing
is per minute.
