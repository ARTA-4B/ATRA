"""Evaluate adapter weights directly, with no server in between.

`evaluate.py --serving raw` already removes the tool-call parser from the
scoring path, but it still measures a q4_k_m GGUF served by llama.cpp: the
weights the runtime would deploy, quantised. This script measures the adapter
as trained — NF4 base, LoRA on top, transformers' own `generate` — so the two
numbers together separate "the model did not learn it" from "the export lost
it". It is not a deployment measurement and does not stand in for one.

The prompt is rendered by `prompting.render_example`, the same function that
rendered every training example, so this path cannot drift from training
either.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from data.checks import load_jsonl
from evaluate import ReplyTrace, evaluate
from prompting import render_example
from train import four_bit_load_kwargs, load_config, supports_bf16


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=Path("config/default.yaml"))
    parser.add_argument("--max-new-tokens", type=int, default=512)
    args = parser.parse_args()

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    manifest = json.loads((args.adapter / "manifest.json").read_text(encoding="utf-8"))
    base = manifest["base_model"]
    revision = manifest["base_revision"]

    tokenizer = AutoTokenizer.from_pretrained(base, revision=revision)
    saved_template = args.adapter / "chat_template.jinja"
    if saved_template.exists():
        tokenizer.chat_template = saved_template.read_text(encoding="utf-8")
    if not tokenizer.chat_template:
        raise SystemExit("evaluation requires the chat template training rendered with")

    dtype = torch.bfloat16 if supports_bf16(torch) else torch.float16
    # Same load path as training, including the compute-dtype override the
    # checkpoint's own quantization_config would otherwise win: a model
    # evaluated with different quantiser arithmetic than it was trained with
    # is not the model that was trained.
    model = AutoModelForCausalLM.from_pretrained(
        base,
        revision=revision,
        torch_dtype=dtype,
        device_map={"": 0},
        **four_bit_load_kwargs(base, revision, dtype),
    )
    model = PeftModel.from_pretrained(model, str(args.adapter)).eval()
    model.config.use_cache = True

    args.out.parent.mkdir(parents=True, exist_ok=True)
    trace = ReplyTrace(args.out.with_suffix(".replies.jsonl"))
    examples = load_jsonl(args.data)

    class DirectModel:
        name = f"adapter:{args.adapter.name}"
        backend = "transformers generate on the NF4 adapter (not a deployment path)"

        def __init__(self) -> None:
            self.trace = trace

        def generate(self, example):
            prompt = render_example(example, tokenizer, prompt_only=True)
            inputs = tokenizer(prompt, return_tensors="pt", add_special_tokens=False).to(
                model.device
            )
            count = inputs["input_ids"].shape[1]
            with torch.inference_mode():
                output = model.generate(
                    **inputs,
                    do_sample=False,
                    max_new_tokens=args.max_new_tokens,
                    pad_token_id=tokenizer.eos_token_id,
                    use_cache=True,
                )
            produced = output[0, count:]
            text = tokenizer.decode(produced, skip_special_tokens=True)
            self.trace.record(
                id=example.id,
                domain=example.domain.value,
                prompt_sha256=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
                prompt_tokens_local=count,
                prompt_tokens_server=count,
                generated_tokens=len(produced),
                returned_tokens=len(
                    tokenizer(text, add_special_tokens=False)["input_ids"]
                ),
                reply_chars=len(text),
                reached_token_limit=len(produced) == args.max_new_tokens,
                reply=text,
            )
            print(f"{example.id}: {len(produced)} tokens", flush=True)
            return text

    config = load_config(args.config)
    report = evaluate(DirectModel(), examples, config["evaluation"]["thresholds"])
    trace.close()

    payload = json.loads(report.to_json())
    payload["base_revision"] = revision
    payload["adapter_sha256"] = hashlib.sha256(
        (args.adapter / "adapter_model.safetensors").read_bytes()
    ).hexdigest()
    payload["template_sha256"] = hashlib.sha256(
        tokenizer.chat_template.encode("utf-8")
    ).hexdigest()
    args.out.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    print(report.render(), flush=True)
    print(flush=True)
    print(trace.render(), flush=True)
    return int(any(metric.meets_threshold is False for metric in report.metrics))


if __name__ == "__main__":
    raise SystemExit(main())
