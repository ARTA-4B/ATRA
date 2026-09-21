"""The one place a prompt is rendered.

Two evaluations have now been thrown away because training and evaluation did
not render the same prompt:

* run 1 scored the model on `messages` alone while every training prompt had
  been rendered with `apply_chat_template(messages, tools=...)`, so the tool
  block — several hundred tokens of system text — was missing at eval time;
* run 2 sent the tools, and the numbers were still unusable, because sending
  `tools` to `/v1/chat/completions` switches on llama.cpp's tool-call parser,
  which rewrote the reply before the scorer ever saw it.

Both are the same class of bug: two code paths that were *supposed* to agree.
So there is now exactly one function that turns an `Example` into text, it
lives here, and `train.py` and `evaluate.py` both call it. `completion_pair`
splits that single rendering at the generation boundary, which is what makes
"the prompt the model is scored on" and "the prompt the loss was masked to"
the same string by construction rather than by review.
"""

from __future__ import annotations

from typing import Any

from data.schema import Example


def tool_schemas(example: Example) -> list[dict[str, Any]]:
    """The example's tools in the OpenAI function shape.

    The same shape goes to `apply_chat_template(tools=...)` and into an
    OpenAI-compatible request body, so a server that renders the template
    itself and this module cannot disagree about what the tools are.
    """
    return [
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


def render_example(example: Example, tokenizer: Any, *, prompt_only: bool = False) -> str:
    """Render one example through the model's own chat template.

    Using the tokenizer's template rather than a hand-rolled format matters: the
    special tokens a model was pretrained with are part of its interface, and
    getting them wrong produces a model that works in evaluation and fails in
    the runtime.

    `prompt_only` drops the assistant turn and appends the generation prompt —
    the exact prefix the model is asked to continue at inference time.
    """
    messages = [
        {"role": message.role, "content": message.content} for message in example.messages
    ]
    if prompt_only:
        if not messages or messages[-1]["role"] != "assistant":
            raise ValueError("training example must end in an assistant answer")
        messages = messages[:-1]

    tools = tool_schemas(example)

    try:
        return tokenizer.apply_chat_template(
            messages, tools=tools or None, tokenize=False, add_generation_prompt=prompt_only
        )
    except TypeError:
        # Older templates do not accept `tools`.
        return tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=prompt_only
        )


def completion_pair(example: Example, tokenizer: Any) -> dict[str, str]:
    """Keep the inference prefix identical while masking it out of the loss."""
    prompt = render_example(example, tokenizer, prompt_only=True)
    full = render_example(example, tokenizer)
    if not full.startswith(prompt):
        raise ValueError(f"{example.id}: training and generation prefixes differ")
    completion = full[len(prompt) :]
    if not completion.strip():
        raise ValueError(f"{example.id}: empty completion")
    return {"prompt": prompt, "completion": completion}
