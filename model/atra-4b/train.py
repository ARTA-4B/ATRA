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


def render_example(example: Example, tokenizer: Any) -> str:
    """Render one example through the model's own chat template.

    Using the tokenizer's template rather than a hand-rolled format matters: the
    special tokens a model was pretrained with are part of its interface, and
    getting them wrong produces a model that works in evaluation and fails in
    the runtime.
    """
    messages = [
        {"role": message.role, "content": message.content} for message in example.messages
    ]

    tools = [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            },
        }
        for tool in example.tools
    ]

    try:
        return tokenizer.apply_chat_template(
            messages, tools=tools or None, tokenize=False, add_generation_prompt=False
        )
    except TypeError:
        # Older templates do not accept `tools`.
        return tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=False
        )


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
    args = parser.parse_args()

    config = load_config(args.config if args.config.exists() else None)

    base_model = os.environ.get("ATRA_BASE") or resolve(
        config, "model", "base", default="unsloth/Qwen3-4B-Instruct-2507-bnb-4bit"
    )
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

    tokenizer = AutoTokenizer.from_pretrained(base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    load_in_4bit = bool(resolve(config, "model", "load_in_4bit", default=True)) and use_cuda
    model_kwargs: dict[str, Any] = {}

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
        model_kwargs["torch_dtype"] = compute_dtype

    if load_in_4bit:
        from transformers import BitsAndBytesConfig

        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=compute_dtype,
        )

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
    model = get_peft_model(model, peft_config)

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f"trainable      : {trainable:,} of {total:,} ({trainable / total:.2%})")

    train_dataset = Dataset.from_dict(
        {"text": [render_example(example, tokenizer) for example in train_examples]}
    )

    output_dir = args.output
    output_dir.mkdir(parents=True, exist_ok=True)

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
        bf16=use_cuda and supports_bf16(torch),
        fp16=use_cuda and not supports_bf16(torch),
        optim=str(resolve(config, "training", "optimizer", default="paged_adamw_8bit"))
        if use_cuda
        else "adamw_torch",
        **({"max_steps": args.max_steps} if args.max_steps else {}),
    )

    trainer = SFTTrainer(model=model, args=sft_config, train_dataset=train_dataset)

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
        steps=args.max_steps or trainer.state.global_step,
        final_loss=final_loss,
        peak_memory_gib=round(peak_memory, 3) if peak_memory else None,
        status="smoke" if args.max_steps else status,
        notes=str(resolve(config, "run", "notes", default="")),
    )
    manifest.write(output_dir / "manifest.json")

    print(f"\nmanifest: {output_dir / 'manifest.json'}")
    print(f"status  : {manifest.status}")
    if peak_memory:
        print(f"peak GPU: {peak_memory:.2f} GiB")

    return 0 if status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
