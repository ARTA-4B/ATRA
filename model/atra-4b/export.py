"""Merge a trained ATRA-4B LoRA adapter into its base model and export it.

Two outputs, both optional:

1. ``<out>/merged`` — the base model with the adapter folded in, saved as
   safetensors in fp16 (or bf16 on hardware that supports it). This is what a
   GGUF converter consumes.
2. ``<out>/atra-4b-<type>.gguf`` — a llama.cpp GGUF file, produced by the
   ``convert_hf_to_gguf.py`` script of a llama.cpp checkout that the caller
   points at with ``--llama-cpp``. ``f16`` and ``q8_0`` need only that Python
   script; ``q4_k_m`` additionally needs a built ``llama-quantize`` binary,
   which is looked for next to the checkout's ``build/bin``.

Nothing here trains, evaluates or uploads. It writes ``export-manifest.json``
next to the outputs so a GGUF can always be traced back to the adapter, the
base revision and the training manifest that produced it — a file that lacks
that chain is not an ATRA-4B release, whatever it is called.

Usage::

    python export.py --adapter runs/atra-4b --out export
    python export.py --adapter runs/atra-4b --out export \
        --llama-cpp /kaggle/working/llama.cpp --gguf q8_0

The adapter directory must contain ``manifest.json`` from ``train.py`` with
``status: completed``. A smoke manifest is refused: a 30-step checkpoint is not
a model, and exporting it would only make it look like one.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# The full-precision base the adapter is merged into. The adapter was trained
# against the bnb-4bit variant of this exact checkpoint; merging into the
# fp16 weights is the standard QLoRA export path and the manifest records both.
DEFAULT_FULL_BASE = "Qwen/Qwen3-4B-Instruct-2507"

MODELFILE = """# Ollama Modelfile for ATRA-4B.
#
# The chat template travels inside the GGUF (the converter embeds the base
# model's tokenizer chat template), so none is repeated here. The ATRA runtime
# supplies its own system prompt per agent; do not add one.
FROM ./{gguf}
PARAMETER temperature 0.1
PARAMETER num_ctx {ctx}
"""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_training_manifest(adapter: Path) -> dict[str, Any]:
    manifest_path = adapter / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"{manifest_path} is missing; export only what train.py produced")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    status = manifest.get("status")
    if status != "completed":
        raise SystemExit(
            f"adapter manifest status is {status!r}, not 'completed'; "
            "a smoke or failed run must not be exported as a model"
        )
    return manifest


def merge(adapter: Path, base: str, out: Path) -> Path:
    try:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError as error:  # pragma: no cover - depends on the environment
        raise SystemExit(f"merge dependencies are not installed ({error})") from error

    merged_dir = out / "merged"
    if merged_dir.exists():
        shutil.rmtree(merged_dir)
    merged_dir.mkdir(parents=True)

    use_cuda = torch.cuda.is_available()
    # Native bf16 only (Ampere and newer); see supports_bf16 in train.py for
    # why torch.cuda.is_bf16_supported() is the wrong question on a T4.
    capability = torch.cuda.get_device_capability() if use_cuda else (0, 0)
    dtype = torch.bfloat16 if capability[0] >= 8 else torch.float16
    print(f"base model : {base}")
    print(f"adapter    : {adapter}")
    print(f"dtype      : {dtype}")

    model = AutoModelForCausalLM.from_pretrained(
        base, torch_dtype=dtype, device_map="auto" if use_cuda else None, low_cpu_mem_usage=True
    )
    model = PeftModel.from_pretrained(model, str(adapter))
    model = model.merge_and_unload()
    model.save_pretrained(str(merged_dir), safe_serialization=True)

    tokenizer = AutoTokenizer.from_pretrained(str(adapter))
    tokenizer.save_pretrained(str(merged_dir))
    print(f"merged     : {merged_dir}")
    return merged_dir


def convert_gguf(merged: Path, out: Path, llama_cpp: Path, gguf_type: str) -> Path:
    converter = llama_cpp / "convert_hf_to_gguf.py"
    if not converter.exists():
        raise SystemExit(f"{converter} not found; pass --llama-cpp pointing at a llama.cpp checkout")

    direct = {"f16": "f16", "bf16": "bf16", "q8_0": "q8_0"}
    if gguf_type in direct:
        target = out / f"atra-4b-{gguf_type}.gguf"
        run([sys.executable, str(converter), str(merged), "--outfile", str(target), "--outtype", direct[gguf_type]])
        return target

    # Anything else goes through llama-quantize from an f16 intermediate.
    intermediate = out / "atra-4b-f16.gguf"
    run([sys.executable, str(converter), str(merged), "--outfile", str(intermediate), "--outtype", "f16"])
    quantize = find_quantize(llama_cpp)
    if quantize is None:
        raise SystemExit(
            "llama-quantize binary not found; build llama.cpp (cmake -B build && cmake --build build "
            "--target llama-quantize) or use --gguf q8_0, which needs no binary"
        )
    target = out / f"atra-4b-{gguf_type}.gguf"
    run([str(quantize), str(intermediate), str(target), gguf_type.upper()])
    intermediate.unlink(missing_ok=True)
    return target


def find_quantize(llama_cpp: Path) -> Path | None:
    candidates = [
        llama_cpp / "build" / "bin" / "llama-quantize",
        llama_cpp / "build" / "bin" / "llama-quantize.exe",
        llama_cpp / "llama-quantize",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    found = shutil.which("llama-quantize")
    return Path(found) if found else None


def run(command: list[str]) -> None:
    print("$", " ".join(command))
    subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge and export ATRA-4B")
    parser.add_argument("--adapter", type=Path, required=True, help="train.py output directory")
    parser.add_argument("--out", type=Path, default=Path("export"))
    parser.add_argument("--base", default=os.environ.get("ATRA_FULL_BASE", DEFAULT_FULL_BASE))
    parser.add_argument("--llama-cpp", type=Path, default=None, help="llama.cpp checkout for GGUF")
    parser.add_argument("--gguf", default=None, help="f16 | bf16 | q8_0 | q4_k_m | q5_k_m ...")
    parser.add_argument("--skip-merge", action="store_true", help="reuse <out>/merged from a previous run")
    parser.add_argument("--ctx", type=int, default=4096, help="num_ctx written into the Modelfile")
    args = parser.parse_args()

    training = load_training_manifest(args.adapter)
    args.out.mkdir(parents=True, exist_ok=True)

    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    merged = args.out / "merged"
    if args.skip_merge:
        if not merged.exists():
            raise SystemExit(f"--skip-merge given but {merged} does not exist")
    else:
        merged = merge(args.adapter, args.base, args.out)

    gguf_path: Path | None = None
    if args.gguf:
        if args.llama_cpp is None:
            raise SystemExit("--gguf needs --llama-cpp <path to llama.cpp checkout>")
        gguf_path = convert_gguf(merged, args.out, args.llama_cpp, args.gguf.lower())
        (args.out / "Modelfile").write_text(
            MODELFILE.format(gguf=gguf_path.name, ctx=args.ctx), encoding="utf-8"
        )

    manifest = {
        "exported_at": started,
        "adapter": str(args.adapter),
        "training_manifest": training,
        "full_base": args.base,
        "merged_dir": str(merged),
        "gguf": None
        if gguf_path is None
        else {"file": gguf_path.name, "type": args.gguf.lower(), "sha256": sha256_file(gguf_path), "bytes": gguf_path.stat().st_size},
        "note": (
            "Weights are the base model plus the adapter named above. Whether this export "
            "may be called ATRA-4B is decided by evaluate.py against the thresholds in "
            "config/default.yaml, not by the fact that it exists."
        ),
    }
    (args.out / "export-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nexport manifest: {args.out / 'export-manifest.json'}")
    if gguf_path is not None:
        print(f"gguf           : {gguf_path} ({manifest['gguf']['bytes'] / (1024**3):.2f} GiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
