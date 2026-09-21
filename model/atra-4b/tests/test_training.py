"""Regression tests for the prompt/completion boundary and training failures."""
import pytest

from data.build import build_all
from train import completion_pair, render_example


class Tokenizer:
    def apply_chat_template(self, messages, tools=None, tokenize=False, add_generation_prompt=False):
        prefix = f"tools={tools!r}\n"
        rendered = prefix + "".join(f"<{m['role']}>{m['content']}</end>" for m in messages)
        return rendered + ("<assistant>" if add_generation_prompt else "")


def test_completion_excludes_prompt_but_keeps_answer_and_stop():
    for example in build_all(seed=42, per_domain=10):
        pair = completion_pair(example, Tokenizer())
        assert pair["prompt"] + pair["completion"] == render_example(example, Tokenizer())
        assert pair["completion"] == example.messages[-1].content + "</end>"
        assert example.messages[-2].content in pair["prompt"]
        assert pair["prompt"].endswith("<assistant>")


def test_generation_prefix_mismatch_aborts_instead_of_training_on_wrong_labels():
    class Broken(Tokenizer):
        def apply_chat_template(self, *args, **kwargs):
            text = super().apply_chat_template(*args, **kwargs)
            return "wrong prefix" + text if kwargs.get("add_generation_prompt") else text

    with pytest.raises(ValueError, match="prefixes differ"):
        completion_pair(build_all(seed=42, per_domain=1)[0], Broken())
