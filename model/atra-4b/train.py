"""QLoRA supervised fine-tuning for ATRA-4B.

The script is deliberately boring. Everything that varies between runs lives in
the config file or an environment variable, and every run writes a manifest
recording exactly what produced the checkpoint: base model revision, dataset
hash, seed, config, hardware, duration and peak memory.

A checkpoint without a manifest is not a result. That is the whole reason this
file exists in the repository before any training has happened.

Usage:

    # Prove the pipeline on CPU with a tiny model (about a minute)
    ATRA_BASE=HuggingFaceTB/SmolLM2-135M-Instruct ATRA_DEVICE=cpu \\
        python train.py --max-steps 5 --output runs/smoke

    # A real run on a GPU
    python train.py --config config/default.yaml --output runs/atra-4b-v0
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Set before torch is imported: it changes the allocator, and an allocator
# swapped after the first allocation does nothing.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# QLoRA here is single-GPU, and must say so before CUDA is initialised.
#
# bitsandbytes pins a 4-bit model's weights to one device, while Hugging Face's
# Trainer silently switches to `nn.DataParallel` as soon as it sees a second
# GPU. That combination dies in the backward pass — observed on Kaggle's 2x
# Tesla T4 on 2026-09-20: "Caught AcceleratorError in replica 0 on device 0"
# from `torch/nn/parallel/parallel_apply.py`, after the model had loaded and
# tokenised fine.
#
# A real multi-GPU run is launched with torchrun, which sets LOCAL_RANK; that
# case is left alone, as is an operator who chose the device themselves.
if "LOCAL_RANK" not in os.environ:
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "0")

from data.checks import check, dataset_hash, load_jsonl  # noqa: E402
from data.schema import Example  # noqa: E402

# One renderer, shared with evaluate.py. Two evaluations were lost to train/eval
# prompt skew; the fix is structural, not a review note.
from prompting import completion_pair, render_example  # noqa: E402,F401


@dataclass
class Manifest:
    """Everything needed to reproduce, or to distrust, a checkpoint."""

    run_name: str
    started_at: str
    finished_at: str
    duration_sec: float

    base_model: str
    base_revision: str | None
    dataset_hash: str
    dataset_counts: dict[str, int]
    seed: int
    config: dict[str, Any]

    device: str
    gpu_name: str | None
    torch_version: str | None
    python_version: str
    platform: str

    steps: int
    final_loss: float | None
    peak_memory_gib: float | None

    status: str  # completed | smoke | failed
    notes: str = ""
    parent_adapter: str | None = None
    parent_steps: int = 0
    best_checkpoint: str | None = None
    planned_steps: int | None = None
    stopped_by_time_budget: bool = False
    amp: str = ""
    effective_batch: int = 0

    def write(self, path: Path) -> None:
        path.write_text(json.dumps(self.__dict__, indent=2, sort_keys=True), encoding="utf-8")


def load_config(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError:  # pragma: no cover - only when PyYAML is absent
        raise SystemExit("PyYAML is required to read a config file; pip install pyyaml")
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def resolve(config: dict[str, Any], *keys: str, default: Any = None) -> Any:
    """Read a nested config key, falling back to a default."""
    node: Any = config
    for key in keys:
        if not isinstance(node, dict) or key not in node:
            return default
        node = node[key]
    return node


def load_dataset(directory: Path) -> tuple[list[Example], list[Example], dict[str, int]]:
    """Load and validate the dataset. A failing check aborts the run.

    All three splits are loaded even though only the training split is used for
    gradients: the quality gates are properties of the dataset as a whole — the
    refusal ratio, chain coverage, chronological ordering between splits — and
    checking a subset would silently skip them.
    """
    splits: dict[str, list[Example]] = {}
    for name in ("train", "validation", "test"):
        path = directory / f"{name}.jsonl"
        splits[name] = load_jsonl(path) if path.exists() else []

    every = [example for group in splits.values() for example in group]
    if not every:
        raise SystemExit(f"no dataset found in {directory}; run data.build first")

    report = check(every)
    if not report.ok:
        print(report.render(), file=sys.stderr)
        raise SystemExit("dataset validation failed; refusing to train on it")

    counts = {name: len(group) for name, group in splits.items()}
    return splits["train"], splits["validation"], counts


def four_bit_load_kwargs(base_model: str, revision: str | None, compute_dtype: Any) -> dict[str, Any]:
    """Load 4-bit with *our* compute dtype, not the checkpoint's.

    This is the bug that ended runs 3, 4 and 5, and the reason every one of
    the fixes attempted in between was aimed at the wrong layer.

    `unsloth/Qwen3-4B-Instruct-2507-bnb-4bit` carries its own
    `quantization_config` in `config.json`, and it says
    `"bnb_4bit_compute_dtype": "bfloat16"`. transformers **prefers the
    checkpoint's quantization config over the one you pass** — it warns, in a
    line that reads like boilerplate:

        You passed `quantization_config` ... but the model you're loading
        already has a `quantization_config` attribute. The `quantization_config`
        from the model will be used.

    So every dequantised matmul ran in bfloat16 on a Tesla T4, which has no
    bfloat16 hardware. Two consequences, and both were misdiagnosed:

    * bfloat16 flowed out of the quantised layers into the LoRA branch, so
      fp16 AMP's gradient scaler met bfloat16 gradients — the
      "_amp_foreach_non_finite_check_and_unscale_cuda" not implemented for
      'BFloat16' error that survived loading the model in float16 (run 4) and
      casting every trainable parameter to float32 (run 5), because neither
      touched the quantiser;
    * emulated bfloat16 is slow, which is most of why a step cost 72 seconds
      and why raising the batch size from 1 to 8 did not help at all
      (71.8 -> 75.8 s/step at 4.8 -> 14.0 GiB, measured).

    Mutating the config the model brings with it is the only place the
    decision can be made, because a `quantization_config` argument is
    discarded. The quantisation itself is untouched: same nf4, same double
    quantisation, same weights — only the dtype the dequantised values are
    computed in.
    """
    from transformers import AutoConfig, BitsAndBytesConfig

    wanted = {
        "load_in_4bit": True,
        "bnb_4bit_quant_type": "nf4",
        "bnb_4bit_use_double_quant": True,
    }

    model_config = AutoConfig.from_pretrained(base_model, revision=revision)
    existing = getattr(model_config, "quantization_config", None)
    if hasattr(existing, "to_dict"):
        existing = existing.to_dict()

    if isinstance(existing, dict):
        name = str(compute_dtype).replace("torch.", "")
        merged = dict(existing)
        merged.update(wanted)
        merged["bnb_4bit_compute_dtype"] = name
        model_config.quantization_config = merged
        print(
            f"quantisation   : compute dtype {name} "
            f"(the checkpoint asked for {existing.get('bnb_4bit_compute_dtype')})"
        )
        return {"config": model_config}

    return {
        "quantization_config": BitsAndBytesConfig(
            bnb_4bit_compute_dtype=compute_dtype, **wanted
        )
    }


def supports_bf16(torch_module: Any) -> bool:
    """Whether this GPU has *native* bfloat16.

    `torch.cuda.is_bf16_supported()` is not that test: on recent PyTorch it
    answers True for a Tesla T4 (compute capability 7.5), which has no bf16
    hardware and would run it emulated — slowly, or not at all. Ampere (8.0)
    is the first generation with real bf16, so the capability major version is
    the honest check. Observed on Kaggle 2026-09-20: T4, torch 2.10.0+cu128,
    `is_bf16_supported()` returned True.
    """
    if not torch_module.cuda.is_available():
        return False
    major, _minor = torch_module.cuda.get_device_capability()
    return bool(major >= 8)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fine-tune ATRA-4B")
    parser.add_argument("--config", type=Path, default=Path("config/default.yaml"))
    parser.add_argument("--output", type=Path, default=Path("runs/atra-4b"))
    parser.add_argument("--max-steps", type=int, default=None, help="override for smoke runs")
    parser.add_argument("--dry-run", action="store_true", help="validate and exit")
    parser.add_argument("--adapter", type=Path, help="continue adapter weights with a new optimizer")
    parser.add_argument(
        "--max-seconds",
        type=float,
        default=float(os.environ.get("ATRA_MAX_SECONDS", "0")) or None,
        help=(
            "stop cleanly after this many seconds of training. A hosted session "
            "has a hard limit; a run that walks into it loses the adapter, the "
            "manifest and the evaluation with it."
        ),
    )
    args = parser.parse_args()

    config = load_config(args.config if args.config.exists() else None)
    parent = {}
    if args.adapter:
        parent = json.loads((args.adapter / "manifest.json").read_text(encoding="utf-8"))
        if parent.get("status") != "completed":
            raise SystemExit("parent adapter must have a completed training manifest")

    base_model = os.environ.get("ATRA_BASE") or resolve(
        config, "model", "base", default="unsloth/Qwen3-4B-Instruct-2507-bnb-4bit"
    )
    if parent and parent["base_model"] != base_model:
        raise SystemExit("parent adapter base model does not match this run")
    revision = parent.get("base_revision") or resolve(config, "model", "revision")
    seq_length = int(os.environ.get("ATRA_SEQ") or resolve(config, "model", "max_seq_length", default=2048))
    seed = int(resolve(config, "run", "seed", default=42))
    device_preference = os.environ.get("ATRA_DEVICE", "auto")
    data_dir = Path(resolve(config, "data", "directory", default="data/out"))

    train_examples, validation_examples, counts = load_dataset(data_dir)
    digest = dataset_hash(train_examples + validation_examples)

    print(f"base model     : {base_model}")
    print(f"dataset        : {counts} (hash {digest[:16]}…)")
    print(f"sequence length: {seq_length}")
    print(f"seed           : {seed}")

    if args.dry_run:
        print("dry run: dataset validated, exiting before any model is loaded")
        return 0

    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))

    try:
        import torch
        from datasets import Dataset
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from trl import SFTConfig, SFTTrainer
    except ImportError as error:
        raise SystemExit(
            f"training dependencies are not installed ({error}). "
            "Install requirements-train.txt on a GPU machine, or "
            "requirements-cpu.txt for the smoke path."
        ) from error

    torch.manual_seed(seed)

    use_cuda = device_preference != "cpu" and torch.cuda.is_available()
    device = "cuda" if use_cuda else "cpu"
    gpu_name = torch.cuda.get_device_name(0) if use_cuda else None

    if use_cuda:
        # Without this, an allocation that exceeds VRAM silently spills into
        # system memory on some drivers, so a configuration that does not
        # actually fit appears to work and runs at a fraction of the speed.
        torch.cuda.set_per_process_memory_fraction(1.0, 0)

    print(f"device         : {device}{f' ({gpu_name})' if gpu_name else ''}")

    tokenizer = AutoTokenizer.from_pretrained(base_model, revision=revision)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    load_in_4bit = bool(resolve(config, "model", "load_in_4bit", default=True)) and use_cuda
    model_kwargs: dict[str, Any] = {"revision": revision}
    if use_cuda:
        model_kwargs["device_map"] = {"": 0}

    # One dtype decision, used everywhere. The checkpoint is stored in
    # bfloat16, and without an explicit dtype `from_pretrained` keeps it — so
    # on a T4, where the trainer runs fp16 AMP, the gradient scaler met
    # bfloat16 gradients and raised
    #   "_amp_foreach_non_finite_check_and_unscale_cuda" not implemented for 'BFloat16'
    # (observed on Kaggle 2026-09-20, after the DataParallel fix). Loading in
    # float16 keeps the model, the 4-bit compute dtype and the scaler in
    # agreement.
    compute_dtype = torch.bfloat16 if supports_bf16(torch) else torch.float16
    if use_cuda:
        # transformers renamed this keyword from `torch_dtype` to `dtype` in
        # 4.56; an unknown keyword is swallowed silently, so ask the signature
        # rather than guess.
        import inspect

        parameters = inspect.signature(AutoModelForCausalLM.from_pretrained).parameters
        model_kwargs["dtype" if "dtype" in parameters else "torch_dtype"] = compute_dtype

    if load_in_4bit:
        model_kwargs.update(four_bit_load_kwargs(base_model, revision, compute_dtype))

    model = AutoModelForCausalLM.from_pretrained(base_model, **model_kwargs)
    print(f"dtype          : {compute_dtype if use_cuda else 'float32 (cpu)'}")

    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    if load_in_4bit:
        model = prepare_model_for_kbit_training(model)

    peft_config = LoraConfig(
        r=int(resolve(config, "lora", "r", default=16)),
        lora_alpha=int(resolve(config, "lora", "alpha", default=16)),
        lora_dropout=float(resolve(config, "lora", "dropout", default=0.0)),
        target_modules=resolve(
            config,
            "lora",
            "target_modules",
            default=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        ),
        bias="none",
        task_type="CAUSAL_LM",
    )
    if args.adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(args.adapter), is_trainable=True)
    else:
        model = get_peft_model(model, peft_config)

    # Every trainable parameter in float32, whatever the base load produced.
    #
    # This is the standard QLoRA recipe rather than a bug fix: the memory cost
    # is a rounding error against the frozen 4-bit base and the optimiser is
    # better conditioned for it. It was *also* tried, twice, as a fix for the
    # bfloat16 gradient-unscale error, and it did not work either time, because
    # the bfloat16 was coming out of the quantiser — see four_bit_load_kwargs.
    for parameter in model.parameters():
        if parameter.requires_grad and parameter.dtype in (torch.float16, torch.bfloat16):
            parameter.data = parameter.data.to(torch.float32)

    observed = sorted({str(p.dtype) for p in model.parameters() if p.requires_grad})
    frozen = sorted({str(p.dtype) for p in model.parameters() if not p.requires_grad})
    print(f"trainable dtype: {', '.join(observed)}")
    print(f"frozen dtype   : {', '.join(frozen)}")

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f"trainable      : {trainable:,} of {total:,} ({trainable / total:.2%})")

    completion_only = bool(resolve(config, "training", "train_on_completions_only", default=True))
    def make_dataset(examples: list[Example]) -> Any:
        rows = [completion_pair(e, tokenizer) for e in examples]
        for e, row in zip(examples, rows):
            length = len(tokenizer(row["prompt"] + row["completion"], add_special_tokens=False)["input_ids"])
            if length > seq_length:
                raise ValueError(f"{e.id}: {length} tokens exceeds {seq_length}; refusing to truncate answers")
        return Dataset.from_list(rows)
    train_dataset = make_dataset(train_examples)
    validation_dataset = make_dataset(validation_examples) if validation_examples else None

    output_dir = args.output
    output_dir.mkdir(parents=True, exist_ok=True)

    # Accelerate, not the Trainer, owns mixed precision.
    #
    # `SFTConfig(fp16=...)` only asks; if an accelerate default config or an
    # environment variable says otherwise, autocast runs in one dtype while the
    # Trainer builds a scaler for another. Exporting the decision removes the
    # disagreement, and ATRA_AMP makes it visible in the run log and the
    # manifest.
    #
    # This is *not* what caused the bfloat16 unscale error, though it was the
    # third explanation tried for it. That came from the checkpoint's own
    # quantisation config; `off` was adopted afterwards as a way to keep
    # training at all, and cost roughly a factor of the T4's fp16 throughput.
    amp_mode = os.environ.get("ATRA_AMP", "auto").lower()
    if amp_mode == "auto":
        amp_mode = ("bf16" if supports_bf16(torch) else "fp16") if use_cuda else "off"
    if amp_mode not in {"fp16", "bf16", "off"}:
        raise SystemExit(f"ATRA_AMP must be fp16, bf16 or off (got {amp_mode!r})")
    os.environ["ACCELERATE_MIXED_PRECISION"] = "no" if amp_mode == "off" else amp_mode
    print(f"amp            : {amp_mode}")

    try:
        from accelerate.state import AcceleratorState

        AcceleratorState._reset_state()
    except Exception as error:  # noqa: BLE001 - diagnostics only
        print(f"accelerate state not reset ({error})")

    sft_config = SFTConfig(
        output_dir=str(output_dir),
        per_device_train_batch_size=int(
            resolve(config, "training", "per_device_batch_size", default=1)
        ),
        gradient_accumulation_steps=int(
            resolve(config, "training", "gradient_accumulation_steps", default=8)
        ),
        num_train_epochs=float(resolve(config, "training", "epochs", default=2)),
        learning_rate=float(resolve(config, "training", "learning_rate", default=2e-4)),
        lr_scheduler_type=str(resolve(config, "training", "lr_scheduler", default="cosine")),
        warmup_ratio=float(resolve(config, "training", "warmup_ratio", default=0.03)),
        weight_decay=float(resolve(config, "training", "weight_decay", default=0.01)),
        max_grad_norm=float(resolve(config, "training", "max_grad_norm", default=1.0)),
        logging_steps=int(resolve(config, "training", "logging_steps", default=5)),
        save_steps=int(resolve(config, "training", "save_steps", default=50)),
        save_total_limit=int(resolve(config, "training", "save_total_limit", default=2)),
        max_length=seq_length,
        seed=seed,
        report_to=[],
        completion_only_loss=completion_only,
        # Checkpoint and measure on step boundaries, not epoch boundaries. Two
        # epochs over a larger dataset is two data points, which is not a curve
        # and cannot distinguish "still learning" from "started memorising";
        # save_steps gives one every save_steps steps and costs a 66 MB adapter
        # and a few seconds of validation loss each time.
        eval_strategy="steps" if validation_dataset is not None else "no",
        save_strategy="steps",
        eval_steps=int(resolve(config, "training", "save_steps", default=50)),
        load_best_model_at_end=validation_dataset is not None,
        metric_for_best_model="eval_loss" if validation_dataset is not None else None,
        greater_is_better=False,
        per_device_eval_batch_size=int(
            resolve(config, "training", "per_device_eval_batch_size", default=8)
        ),
        prediction_loss_only=True,
        bf16=amp_mode == "bf16",
        fp16=amp_mode == "fp16",
        optim=str(resolve(config, "training", "optimizer", default="paged_adamw_8bit"))
        if use_cuda
        else "adamw_torch",
        **({"max_steps": args.max_steps} if args.max_steps else {}),
    )

    callbacks = []
    budget = None
    if args.max_seconds:
        from transformers.trainer_callback import TrainerCallback

        class TimeBudget(TrainerCallback):
            """Stop cleanly before a hosted session's hard limit does it for us.

            Kaggle kills a kernel at twelve hours and everything in it goes with
            the process: the adapter, the manifest, and the evaluation that was
            supposed to run after the training. A run that has to guess its own
            speed in advance either trains too little on purpose or gambles the
            whole session. This makes the trade-off explicit — train until the
            budget, then stop at a step boundary with a checkpoint saved and the
            manifest written, and record in the manifest that the budget, not the
            schedule, ended it.
            """

            def __init__(self, seconds: float) -> None:
                self.seconds = seconds
                self.started = time.time()
                self.hit = False

            def on_step_end(self, args, state, control, **kwargs):  # noqa: ANN001, ARG002
                if time.time() - self.started >= self.seconds:
                    self.hit = True
                    control.should_training_stop = True
                    control.should_save = True
                    print(
                        f"\ntime budget: {self.seconds:.0f}s reached at step "
                        f"{state.global_step}; stopping cleanly",
                        flush=True,
                    )
                return control

        budget = TimeBudget(args.max_seconds)
        callbacks.append(budget)
        print(f"time budget    : {args.max_seconds:.0f}s")

    trainer = SFTTrainer(model=model, args=sft_config, train_dataset=train_dataset,
                         eval_dataset=validation_dataset, processing_class=tokenizer,
                         callbacks=callbacks)
    # Verify the real TRL collator masks the prompt, not just a config flag.
    if completion_only:
        sample = trainer.train_dataset[0]
        batch = trainer.data_collator([sample])
        labels = batch["labels"][0].tolist()[:len(sample["input_ids"])]
        mask = sample["completion_mask"]
        if not any(mask) or not any(v == 0 for v in mask):
            raise ValueError("completion mask must contain prompt and answer tokens")
        if any(label != -100 for label, keep in zip(labels, mask) if not keep):
            raise ValueError("prompt tokens are not masked from the training loss")

        # And the masked prefix has to *be* the inference prompt, token for
        # token. TRL tokenises `prompt` and `completion` separately and
        # concatenates; if that seam moved a token, training would be masked
        # to one string while evaluation renders another, which is the skew
        # that cost runs 1 and 2 — invisible in the loss, fatal in the score.
        prefix_ids = [
            token for token, keep in zip(sample["input_ids"], mask) if not keep
        ]
        decoded = tokenizer.decode(prefix_ids, skip_special_tokens=False)
        expected = render_example(train_examples[0], tokenizer, prompt_only=True)
        if decoded != expected:
            raise ValueError(
                "the masked prefix is not the inference prompt:\n"
                f"  trained on : {decoded[-120:]!r}\n"
                f"  rendered   : {expected[-120:]!r}"
            )
        print(
            f"completion-only loss mask verified; the masked prefix is the "
            f"inference prompt ({len(prefix_ids)} tokens, "
            f"{len(sample['input_ids']) - len(prefix_ids)} scored)",
            flush=True,
        )

    status = "completed"
    final_loss: float | None = None

    try:
        result = trainer.train()
        final_loss = float(result.training_loss)
    except Exception as error:  # noqa: BLE001 - the manifest must record any failure
        status = "failed"
        print(f"training failed: {error}", file=sys.stderr)

    finished = time.time()
    peak_memory = (
        torch.cuda.max_memory_reserved() / (1024**3) if use_cuda else None
    )

    if status == "completed":
        trainer.save_model(str(output_dir))
        tokenizer.save_pretrained(str(output_dir))

        # save_pretrained writes the chat template to a separate
        # chat_template.jinja in transformers 4.57, and that file is easy to
        # lose when an adapter directory is copied or uploaded by pattern.
        # Losing it is not a cosmetic problem: the template is how every one
        # of these training prompts was rendered, so a serving stack without
        # it feeds the model a shape it has never seen, and the failure is
        # silent. Write it next to the adapter under its own name as well,
        # and say so, so the omission is visible in the run log.
        template = getattr(tokenizer, "chat_template", None)
        if template:
            (output_dir / "chat_template.jinja").write_text(template, encoding="utf-8")
            print(f"template   : {len(template)} chars saved beside the adapter")
        else:
            print("template   : WARNING none on the tokenizer; the export must recover it")

    manifest = Manifest(
        run_name=str(resolve(config, "run", "name", default="atra-4b")),
        started_at=started_at,
        finished_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(finished)),
        duration_sec=round(finished - started, 2),
        base_model=base_model,
        base_revision=getattr(getattr(model, "config", None), "_commit_hash", None),
        dataset_hash=digest,
        dataset_counts=counts,
        seed=seed,
        config=config,
        device=device,
        gpu_name=gpu_name,
        torch_version=torch.__version__,
        python_version=platform.python_version(),
        platform=platform.platform(),
        steps=trainer.state.global_step,
        final_loss=final_loss,
        peak_memory_gib=round(peak_memory, 3) if peak_memory else None,
        status="smoke" if args.max_steps and status == "completed" else status,
        notes=str(resolve(config, "run", "notes", default="")),
        parent_adapter=str(args.adapter) if args.adapter else None,
        parent_steps=int(parent.get("steps", 0)),
        best_checkpoint=trainer.state.best_model_checkpoint,
        planned_steps=int(trainer.state.max_steps) if trainer.state.max_steps else None,
        stopped_by_time_budget=bool(budget and budget.hit),
        amp=amp_mode,
        effective_batch=sft_config.per_device_train_batch_size
        * sft_config.gradient_accumulation_steps,
    )
    manifest.write(output_dir / "manifest.json")

    # The loss curve is the only thing that can tell "not enough steps" from
    # "the wrong learning rate" after the fact, and it does not survive the
    # kernel. It costs a few kilobytes to keep.
    (output_dir / "log-history.json").write_text(
        json.dumps(trainer.state.log_history, indent=2), encoding="utf-8"
    )

    print(f"\nmanifest: {output_dir / 'manifest.json'}")
    print(f"status  : {manifest.status}")
    if peak_memory:
        print(f"peak GPU: {peak_memory:.2f} GiB")

    return 0 if status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
