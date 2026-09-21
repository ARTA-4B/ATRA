"""The serving path must hand the scorer what the model generated.

Run 2 of the evaluation was thrown away because it did not. `llama-server`
reported 4,252 generated tokens and 79 of 95 replies reached `evaluate.py`
with no parseable JSON in them: sending `tools` to `/v1/chat/completions`
switches on a tool-call parser that moves the assistant turn out of
`message.content`, and the harness read `content` only. Every metric came out
near its floor and every one of them was a statement about the server.

These tests pin the two halves of the repair against a stub server:

* `RawCompletionModel` renders the prompt with the training template and reads
  raw text back from `/completion`, so nothing can rewrite the reply;
* the token accounting notices when a reply arrives shorter than the server
  says it generated, which is the exact signature run 2 showed and nothing
  reported.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from data.build import build_all
from evaluate import EndpointModel, RawCompletionModel, ReplyTrace, evaluate, parse_reply


class Tokenizer:
    """Whitespace tokeniser with a chat template, enough to count and render."""

    def apply_chat_template(self, messages, tools=None, tokenize=False, add_generation_prompt=False):
        head = f"<tools:{len(tools or [])}>"
        body = "".join(f"<{m['role']}>{m['content']}</end>" for m in messages)
        return head + body + ("<assistant>" if add_generation_prompt else "")

    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": text.split()}


class Stub(BaseHTTPRequestHandler):
    """Answers /completion and /v1/chat/completions from a scripted reply."""

    reply = ""
    tokens_predicted = 0
    chat_message: dict | None = None
    seen: list = []

    def log_message(self, *args):  # noqa: A003 - silence the test server
        pass

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler's interface
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        Stub.seen.append((self.path, body))

        if self.path.endswith("/completion"):
            payload = {
                "content": Stub.reply,
                "tokens_predicted": Stub.tokens_predicted,
                "tokens_evaluated": len(str(body.get("prompt", "")).split()),
                "stop_type": "eos",
                "truncated": False,
            }
        else:
            payload = {
                "choices": [{"message": Stub.chat_message or {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 511, "completion_tokens": Stub.tokens_predicted},
            }

        raw = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


@pytest.fixture()
def server():
    Stub.seen = []
    httpd = HTTPServer(("127.0.0.1", 0), Stub)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()
    httpd.server_close()


def an_example(domain="tool_use"):
    return next(e for e in build_all(seed=42, per_domain=5) if e.domain.value == domain)


def test_raw_path_sends_the_training_prompt_and_returns_text_unaltered(server):
    example = an_example()
    Stub.reply = json.dumps(example.expected_output, sort_keys=True)
    Stub.tokens_predicted = len(Stub.reply.split())

    model = RawCompletionModel(server, "atra-4b", Tokenizer())
    out = model.generate(example)

    assert out == Stub.reply
    path, body = Stub.seen[-1]
    assert path.endswith("/completion")
    assert "tools" not in body  # nothing for a tool-call parser to switch on
    # The prompt is the training rendering, tool block included, ending at the
    # generation boundary — not a `messages` array the server renders itself.
    assert body["prompt"] == model.render(example)
    assert body["prompt"].startswith(f"<tools:{len(example.tools)}>")
    assert body["prompt"].endswith("<assistant>")
    assert example.messages[-1].content not in body["prompt"]


def test_accounting_is_clean_when_the_whole_reply_arrives(server):
    example = an_example()
    Stub.reply = json.dumps(example.expected_output, sort_keys=True)
    Stub.tokens_predicted = len(Stub.reply.split()) + 1  # + the stop token

    trace = ReplyTrace()
    RawCompletionModel(server, "atra-4b", Tokenizer(), trace=trace).generate(example)

    summary = trace.summary()
    assert summary["replies_losing_content"] == 0
    assert summary["prompt_tokens_local_vs_server_mismatch"] == 0


def test_accounting_catches_run_2s_failure_shape(server):
    """77 tokens generated, a closing tag returned. This is the bug."""
    example = an_example("lp_reasoning")
    Stub.reply = "</tool_call>"
    Stub.tokens_predicted = 77

    trace = ReplyTrace()
    RawCompletionModel(server, "atra-4b", Tokenizer(), trace=trace).generate(example)

    summary = trace.summary()
    assert summary["replies_losing_content"] == 1
    assert summary["worst"][0]["generated_tokens"] == 77
    assert summary["worst"][0]["returned_tokens"] == 1
    assert "content accounting" in trace.render()


def test_a_contaminated_run_is_visible_in_the_report(server):
    examples = build_all(seed=42, per_domain=2)
    Stub.reply = "</tool_call>"
    Stub.tokens_predicted = 60

    trace = ReplyTrace()
    model = RawCompletionModel(server, "atra-4b", Tokenizer(), trace=trace)
    report = evaluate(model, examples, {"structured_output_validity": 0.98})

    # Without the accounting this looks exactly like a model that produces
    # nothing: every metric at its floor and no hint that the text was eaten.
    assert report.metrics[0].score == 0.0
    assert report.content_accounting["replies_losing_content"] == len(examples)
    assert "completion" in report.backend


def test_chat_path_reconstructs_a_reply_the_parser_moved(server):
    example = an_example()
    Stub.chat_message = {
        "content": None,
        "tool_calls": [
            {
                "type": "function",
                "function": {
                    "name": example.expected_output["tool"],
                    "arguments": json.dumps(example.expected_output["arguments"]),
                },
            }
        ],
    }
    Stub.tokens_predicted = 42

    trace = ReplyTrace()
    out = EndpointModel(server, "atra-4b", trace=trace).generate(example)

    parsed = parse_reply(out)
    assert parsed is not None
    assert parsed["tool"] == example.expected_output["tool"]
    assert parsed["arguments"] == example.expected_output["arguments"]
    assert trace.records[-1]["reconstructed_from_tool_calls"] is True

    # And the chat path still sends the tools, because training did.
    _path, body = Stub.seen[-1]
    assert [t["function"]["name"] for t in body["tools"]] == [t.name for t in example.tools]


def test_chat_path_scored_it_as_nothing_before_the_fix(server):
    """The old behaviour, kept as a statement of what changed."""
    example = an_example()
    Stub.chat_message = {"content": None, "tool_calls": []}
    Stub.tokens_predicted = 42

    assert EndpointModel(server, "atra-4b").generate(example) == ""
