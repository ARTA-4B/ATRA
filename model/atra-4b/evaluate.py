"""Evaluation suite for ATRA-4B.

The benchmarks measure what ATRA actually needs from a model, which is mostly
the discipline to produce well-formed output and to refuse. None of them
measure simulated profit: a model can be profitable in a backtest and still be
useless here, and optimising for that number is how a safety-critical component
learns to gamble.

Metrics:

| Metric | Question it answers |
|---|---|
| structured_output_validity | Does every reply parse and match the schema? |
| tool_selection_accuracy | Does it call the right tool? |
| tool_argument_validity | Are the arguments valid against the tool schema? |
| stale_data_rejection | Does it refuse when the evidence is too old? |
| hallucinated_price_rate | How often does it state a number nobody gave it? |
| no_action_correctness | Does it refuse exactly when it should? |
| unsupported_chain_rejection | Does it reject chains ATRA does not support? |
| lp_action_validity | Are LP actions from the allowed set? |

Model-only evaluation lives here. Agent-simulation evaluation — the whole
pipeline against a paper ledger — is a separate concern and is not mixed into
these numbers.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

from data.checks import dataset_hash, load_jsonl
from data.schema import CHAINS, Domain, Example, LpAction, TradeAction


class Model(Protocol):
    """Anything that turns a rendered prompt into a reply."""

    name: str

    def generate(self, example: Example) -> str: ...


class EchoModel:
    """A deliberately useless model.

    Returns the empty string for everything. Its purpose is to prove the
    harness reports failure honestly: run the suite against this and every
    metric should be at its floor. A suite that scores it well is broken.
    """

    name = "echo-null"

    def generate(self, example: Example) -> str:  # noqa: ARG002
        return ""


class OracleModel:
    """Replays the expected answer.

    The upper bound. If the suite does not score this at 1.0 the metric is
    measuring something other than what it claims.
    """

    name = "oracle"

    def generate(self, example: Example) -> str:
        return json.dumps(example.expected_output, sort_keys=True)


class ReplyTrace:
    """Per-reply accounting, so "the scorer saw what the model generated" is arithmetic.

    Run 2 failed on this and the failure was invisible in the metrics: the
    server logged 4,252 generated tokens across 102 requests, and 79 of 95
    replies contained no parseable JSON. The tokens existed; the text did not
    arrive. Nothing in the report said so, because nothing compared the two.

    Every reply is now recorded with the number of tokens the server says it
    generated and the number of tokens the returned text actually contains,
    re-tokenised with the training tokenizer. If the second is materially
    smaller than the first, content was dropped between the model and the
    scorer, and the run says so instead of publishing the number.
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self.records: list[dict[str, Any]] = []
        self._handle = None
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._handle = path.open("w", encoding="utf-8")

    def record(self, **fields: Any) -> None:
        self.records.append(fields)
        if self._handle is not None:
            self._handle.write(json.dumps(fields, sort_keys=True) + "\n")
            self._handle.flush()

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()
            self._handle = None

    def summary(self) -> dict[str, Any]:
        """How much of what the model generated reached the scorer."""
        scored = [
            r
            for r in self.records
            if r.get("generated_tokens") is not None and r.get("returned_tokens") is not None
        ]
        if not scored:
            return {"replies": len(self.records), "checked": 0}

        # A token of slack per reply: the stop token (<|im_end|> or EOS) is
        # counted as generated and is deliberately not part of the returned
        # text, and a trailing newline can re-tokenise into one token fewer.
        lost = [
            r
            for r in scored
            if r["returned_tokens"] < r["generated_tokens"] - 2
        ]
        return {
            "replies": len(self.records),
            "checked": len(scored),
            "generated_tokens_total": sum(r["generated_tokens"] for r in scored),
            "returned_tokens_total": sum(r["returned_tokens"] for r in scored),
            "empty_replies": sum(1 for r in scored if not r.get("reply_chars")),
            "replies_losing_content": len(lost),
            "worst": sorted(
                (
                    {
                        "id": r["id"],
                        "generated_tokens": r["generated_tokens"],
                        "returned_tokens": r["returned_tokens"],
                    }
                    for r in lost
                ),
                key=lambda r: r["returned_tokens"] - r["generated_tokens"],
            )[:10],
            "prompt_tokens_local_vs_server_mismatch": sum(
                1
                for r in scored
                if r.get("prompt_tokens_local") is not None
                and r.get("prompt_tokens_server") is not None
                and abs(r["prompt_tokens_local"] - r["prompt_tokens_server"]) > 1
            ),
            # The shape of the first failure, in one line. Run 1 sat at 91
            # prompt tokens where the rendered prompt is 511, and nothing in
            # the report said so.
            "prompt_tokens_server_min": min(
                (r["prompt_tokens_server"] for r in scored if r.get("prompt_tokens_server")),
                default=None,
            ),
            "prompt_tokens_server_max": max(
                (r["prompt_tokens_server"] for r in scored if r.get("prompt_tokens_server")),
                default=None,
            ),
            "prompt_tokens_local_min": min(
                (r["prompt_tokens_local"] for r in scored if r.get("prompt_tokens_local")),
                default=None,
            ),
            "prompt_tokens_local_max": max(
                (r["prompt_tokens_local"] for r in scored if r.get("prompt_tokens_local")),
                default=None,
            ),
        }

    def render(self) -> str:
        s = self.summary()
        if not s.get("checked"):
            return "content accounting: no token counts available from this backend"
        lines = [
            "content accounting (what the model generated vs what the scorer read)",
            f"  replies                       : {s['replies']}",
            f"  generated tokens (server)     : {s['generated_tokens_total']}",
            f"  tokens in the returned text   : {s['returned_tokens_total']}",
            f"  empty replies                 : {s['empty_replies']}",
            f"  replies losing >2 tokens      : {s['replies_losing_content']}",
            f"  prompt tokens, rendered here  : "
            f"{s['prompt_tokens_local_min']}-{s['prompt_tokens_local_max']}",
            f"  prompt tokens, per the server : "
            f"{s['prompt_tokens_server_min']}-{s['prompt_tokens_server_max']}",
            f"  disagreeing by more than 1    : "
            f"{s['prompt_tokens_local_vs_server_mismatch']}",
        ]
        for row in s.get("worst", []):
            lines.append(
                f"    {row['id']}: server generated {row['generated_tokens']}, "
                f"text carries {row['returned_tokens']}"
            )
        return "\n".join(lines)


def _post(url: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    import urllib.request

    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


class RawCompletionModel:
    """The served model, asked the way it was trained.

    This is the serving path the evaluation uses, and the reason is narrow.
    `/v1/chat/completions` is a *rendering* endpoint: the server applies its
    own chat template to `messages`, and — when `tools` are present — runs a
    tool-call parser over the output that moves text out of `message.content`
    and into `message.tool_calls`, healing tags as it goes. Two independent
    pieces of the measurement therefore depend on the server's opinion: what
    the model is shown, and what the model is reported to have said. Run 2 lost
    both. One reply generated 77 tokens and came back as `</tool_call>` and two
    newlines.

    `/completion` takes a prompt and returns the completion. Nothing renders,
    nothing parses. The prompt is built here by `prompting.render_example` —
    the same function, not a copy of it, that `train.py` used to build every
    training example — so the string in the request body is the string the
    model was trained to continue, and the string in the response is what the
    model emitted. The scorer sees the model.

    The cost is that this measures the model rather than a chat deployment; a
    deployment that serves ATRA over `/v1/chat/completions` with `tools` has to
    handle `tool_calls` itself, which is what `EndpointModel` below now does.
    """

    def __init__(
        self,
        endpoint: str,
        model: str,
        tokenizer: Any,
        *,
        max_tokens: int = 512,
        timeout: float = 600.0,
        trace: "ReplyTrace | None" = None,
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.name = model
        self.backend = "llama.cpp /completion (prompt rendered locally by prompting.render_example)"
        self.tokenizer = tokenizer
        self.max_tokens = max_tokens
        self.timeout = timeout
        self.trace = trace or ReplyTrace()

    def _count(self, text: str) -> int:
        return len(self.tokenizer(text, add_special_tokens=False)["input_ids"])

    def render(self, example: Example) -> str:
        from prompting import render_example

        return render_example(example, self.tokenizer, prompt_only=True)

    def generate(self, example: Example) -> str:
        prompt = self.render(example)

        body = {
            "prompt": prompt,
            "temperature": 0.0,
            "top_k": 1,
            "n_predict": self.max_tokens,
            "cache_prompt": True,
            "stream": False,
            # The template closes the assistant turn with <|im_end|>; llama.cpp
            # treats it as end-of-generation for this model, and naming it as a
            # stop word as well costs nothing and covers a build that does not.
            "stop": ["<|im_end|>", "<|endoftext|>"],
        }

        data = _post(f"{self.endpoint}/completion", body, self.timeout)

        content = data.get("content") or ""
        timings = data.get("timings") or {}
        generated = data.get("tokens_predicted")
        if generated is None:
            generated = timings.get("predicted_n")

        self.trace.record(
            id=example.id,
            domain=str(getattr(example.domain, "value", example.domain)),
            prompt_sha256=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            prompt_tokens_local=self._count(prompt),
            prompt_tokens_server=data.get("tokens_evaluated"),
            generated_tokens=generated,
            returned_tokens=self._count(content),
            reply_chars=len(content),
            stop_type=data.get("stop_type"),
            truncated=bool(data.get("truncated")),
            reply=content,
        )

        return content


class EndpointModel:
    """A real model behind an OpenAI-compatible `/v1/chat/completions` endpoint.

    Kept because that is how ATRA's runtime talks to Ollama and to any hosted
    provider, so it has to be measurable. It is no longer the path the release
    verdict is taken on — see `RawCompletionModel` — and the two things that
    made run 2's numbers unusable are now handled rather than ignored:

    * the tools are sent, in the same shape `prompting.tool_schemas` hands to
      the chat template, because every training prompt carried them;
    * when the server's tool-call parser moves the reply out of `content` and
      into `tool_calls`, the reply is reconstructed from `tool_calls` in
      ATRA's own schema instead of being scored as an empty string. A parser
      relocating the answer is a serving detail; scoring it as "produced no
      output" was a measurement error.
    """

    def __init__(
        self,
        endpoint: str,
        model: str,
        timeout: float = 600.0,
        *,
        trace: "ReplyTrace | None" = None,
        max_tokens: int = 512,
        tokenizer: Any = None,
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.name = model
        self.backend = "OpenAI /v1/chat/completions (server renders the template and parses tool calls)"
        self.timeout = timeout
        self.max_tokens = max_tokens
        # Optional, and worth supplying: without it nothing can compare the
        # tokens the server says it generated against the tokens in the text
        # that arrived, which is the check that caught run 2.
        self.tokenizer = tokenizer
        self.trace = trace or ReplyTrace()

    @staticmethod
    def _from_tool_calls(calls: list[dict[str, Any]]) -> str:
        """Rebuild ATRA's reply shape from an OpenAI tool_calls array.

        ATRA's training target for a tool question is
        `{"tool": ..., "arguments": {...}, "reason": ...}`. The OpenAI shape is
        `{"function": {"name": ..., "arguments": "<json string>"}}`. The two
        carry the same decision, so the scorer is given the decision rather
        than a floor value, and the reconstruction is recorded in the trace so
        it is never mistaken for raw output.
        """
        first = calls[0] or {}
        function = first.get("function") or {}
        raw_arguments = function.get("arguments")
        if isinstance(raw_arguments, str):
            try:
                arguments = json.loads(raw_arguments)
            except json.JSONDecodeError:
                arguments = raw_arguments
        else:
            arguments = raw_arguments
        return json.dumps({"tool": function.get("name"), "arguments": arguments}, sort_keys=True)

    def generate(self, example: Example) -> str:
        from prompting import tool_schemas

        messages = [
            {"role": message.role, "content": message.content}
            for message in example.messages
            if message.role != "assistant"
        ]

        # The tools go with the prompt, in the same shape train.py hands to
        # apply_chat_template. Leaving them out was scoring the model on a
        # prompt it had never seen: every training example carried the tool
        # block, so a run without it measured how the model behaves when its
        # tools have vanished — and then judged the answer against
        # example.tools anyway, which is what `_score_tool_call` reads.
        tools = tool_schemas(example)

        body: dict[str, Any] = {
            "model": self.name,
            "messages": messages,
            "temperature": 0.0,
            "max_tokens": self.max_tokens,
            "stream": False,
        }
        if tools:
            body["tools"] = tools

        data = _post(f"{self.endpoint}/v1/chat/completions", body, self.timeout)

        message = (data.get("choices") or [{}])[0].get("message") or {}
        content = message.get("content") or ""
        reconstructed = False
        if not content.strip() and message.get("tool_calls"):
            content = self._from_tool_calls(message["tool_calls"])
            reconstructed = True

        usage = data.get("usage") or {}
        self.trace.record(
            id=example.id,
            domain=str(getattr(example.domain, "value", example.domain)),
            prompt_tokens_server=usage.get("prompt_tokens"),
            generated_tokens=usage.get("completion_tokens"),
            returned_tokens=(
                len(self.tokenizer(content, add_special_tokens=False)["input_ids"])
                if self.tokenizer is not None
                else None
            ),
            reply_chars=len(content),
            reconstructed_from_tool_calls=reconstructed,
            finish_reason=(data.get("choices") or [{}])[0].get("finish_reason"),
            reply=content,
        )

        return content


@dataclass
class MetricResult:
    name: str
    score: float
    total: int
    passed: int
    threshold: float | None = None
    lower_is_better: bool = False
    failures: list[str] = field(default_factory=list)

    @property
    def meets_threshold(self) -> bool | None:
        if self.threshold is None:
            return None
        return self.score <= self.threshold if self.lower_is_better else self.score >= self.threshold


@dataclass
class EvaluationReport:
    model: str
    dataset_hash: str
    examples: int
    ran_at: str
    duration_sec: float
    metrics: list[MetricResult]
    backend: str = "unknown"
    content_accounting: dict[str, Any] = field(default_factory=dict)

    def render(self) -> str:
        width = max(len(metric.name) for metric in self.metrics) + 2
        lines = [
            f"model   : {self.model}",
            f"dataset : {self.dataset_hash[:16]}… ({self.examples} examples)",
            f"ran at  : {self.ran_at} in {self.duration_sec:.1f}s",
            f"backend : {self.backend}",
            "",
        ]

        for metric in self.metrics:
            verdict = ""
            if metric.meets_threshold is True:
                verdict = "  pass"
            elif metric.meets_threshold is False:
                verdict = "  FAIL"
            lines.append(
                f"{metric.name:<{width}} {metric.score:6.3f}  "
                f"({metric.passed}/{metric.total}){verdict}"
            )

        return "\n".join(lines)

    def to_json(self) -> str:
        return json.dumps(
            {
                "model": self.model,
                "backend": self.backend,
                "content_accounting": self.content_accounting,
                "dataset_hash": self.dataset_hash,
                "examples": self.examples,
                "ran_at": self.ran_at,
                "duration_sec": self.duration_sec,
                "metrics": [
                    {
                        "name": metric.name,
                        "score": metric.score,
                        "total": metric.total,
                        "passed": metric.passed,
                        "threshold": metric.threshold,
                        "lower_is_better": metric.lower_is_better,
                        "meets_threshold": metric.meets_threshold,
                        "failures": metric.failures[:10],
                    }
                    for metric in self.metrics
                ],
            },
            indent=2,
            sort_keys=True,
        )


NUMBER = re.compile(r"\d+(?:\.\d+)?")


def parse_reply(raw: str) -> dict[str, Any] | None:
    """Extract the JSON object from a reply, tolerating fences and prose."""
    if not raw or not raw.strip():
        return None

    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE)
    text = fenced.group(1) if fenced else raw

    start = text.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escaped = False

    for index in range(start, len(text)):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(text[start : index + 1])
                except json.JSONDecodeError:
                    return None
                return value if isinstance(value, dict) else None

    return None


def evaluate(
    model: Model,
    examples: list[Example],
    thresholds: dict[str, float] | None = None,
) -> EvaluationReport:
    started = time.time()
    thresholds = thresholds or {}

    replies: dict[str, dict[str, Any] | None] = {}
    raw_replies: dict[str, str] = {}

    for example in examples:
        raw = model.generate(example)
        raw_replies[example.id] = raw
        replies[example.id] = parse_reply(raw)

    metrics = [
        _structured_output_validity(examples, replies, thresholds),
        _tool_selection(examples, replies, thresholds),
        _tool_arguments(examples, replies, thresholds),
        _stale_rejection(examples, replies, thresholds),
        _hallucinated_numbers(examples, replies, raw_replies, thresholds),
        _no_action_correctness(examples, replies, thresholds),
        _unsupported_chain(examples, replies, raw_replies, thresholds),
        _lp_validity(examples, replies, thresholds),
    ]

    trace = getattr(model, "trace", None)

    return EvaluationReport(
        model=model.name,
        dataset_hash=dataset_hash(examples),
        examples=len(examples),
        ran_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        duration_sec=round(time.time() - started, 2),
        metrics=metrics,
        backend=getattr(model, "backend", type(model).__name__),
        content_accounting=trace.summary() if trace is not None else {},
    )


def _score(
    name: str,
    selected: list[Example],
    predicate: Callable[[Example], bool],
    thresholds: dict[str, float],
    *,
    lower_is_better: bool = False,
) -> MetricResult:
    if not selected:
        return MetricResult(name=name, score=0.0, total=0, passed=0)

    failures = [example.id for example in selected if not predicate(example)]
    passed = len(selected) - len(failures)

    return MetricResult(
        name=name,
        score=passed / len(selected),
        total=len(selected),
        passed=passed,
        threshold=thresholds.get(name),
        lower_is_better=lower_is_better,
        failures=failures,
    )


def _structured_output_validity(
    examples: list[Example], replies: dict[str, dict | None], thresholds: dict[str, float]
) -> MetricResult:
    return _score(
        "structured_output_validity",
        examples,
        lambda example: replies.get(example.id) is not None,
        thresholds,
    )


def _tool_selection(
    examples: list[Example], replies: dict[str, dict | None], thresholds: dict[str, float]
) -> MetricResult:
    selected = [
        example
        for example in examples
        if example.domain is Domain.TOOL_USE and "tool" in example.expected_output
    ]

    def correct(example: Example) -> bool:
        reply = replies.get(example.id)
        return reply is not None and reply.get("tool") == example.expected_output["tool"]

    return _score("tool_selection_accuracy", selected, correct, thresholds)


def _tool_arguments(
    examples: list[Example], replies: dict[str, dict | None], thresholds: dict[str, float]
) -> MetricResult:
    selected = [
        example
        for example in examples
        if example.domain is Domain.TOOL_USE and "arguments" in example.expected_output
    ]

    def valid(example: Example) -> bool:
        reply = replies.get(example.id)
        if reply is None:
            return False

        arguments = reply.get("arguments")
        if not isinstance(arguments, dict):
            return False

        spec = next((tool for tool in example.tools if tool.name == reply.get("tool")), None)
        if spec is None:
            return False

        required = spec.parameters.get("required", [])
        if any(key not in arguments for key in required):
            return False

        properties = spec.parameters.get("properties", {})
        for key, value in arguments.items():
            definition = properties.get(key)
            if definition is None:
                return False  # an argument the tool does not accept
            allowed = definition.get("enum")
            if allowed is not None and value not in allowed:
                return False

        return True

    return _score("tool_argument_validity", selected, valid, thresholds)


def _stale_rejection(
    examples: list[Example], replies: dict[str, dict | None], thresholds: dict[str, float]
) -> MetricResult:
    """Examples explicitly tagged as staleness or missing-data refusals.

    Selected by tag rather than by searching the text: an earlier version
    matched the substring "old" inside "threshold" and scored LP examples
    against a refusal they were never supposed to make.
    """
    selected = [example for example in examples if "stale" in example.tags]

    def refused(example: Example) -> bool:
        reply = replies.get(example.id)
        if reply is None:
            return False
        return (
            reply.get("action") == TradeAction.NO_ACTION.value
            or reply.get("status") == "INSUFFICIENT_DATA"
            or bool(reply.get("stale_inputs"))
        )

    return _score("stale_data_rejection", selected, refused, thresholds)


def _hallucinated_numbers(
    examples: list[Example],
    replies: dict[str, dict | None],
    raw_replies: dict[str, str],
    thresholds: dict[str, float],
) -> MetricResult:
    """Fraction of replies stating a number that was not in the prompt.

    Lower is better, so the reported score is the rate itself rather than a
    pass rate.
    """
    if not examples:
        return MetricResult(name="hallucinated_price_rate", score=0.0, total=0, passed=0)

    offenders: list[str] = []

    # Chain-knowledge examples legitimately state constants the prompt never
    # mentioned — a chain id is recalled knowledge, not a claim about a market.
    # Scoring those as fabrications would penalise exactly what the model is
    # supposed to know; chain identification is measured separately.
    scored = [example for example in examples if example.domain is not Domain.CHAIN_KNOWLEDGE]
    if not scored:
        return MetricResult(name="hallucinated_price_rate", score=0.0, total=0, passed=0)

    for example in scored:
        prompt = " ".join(
            message.content for message in example.messages if message.role != "assistant"
        )
        allowed = {_normalize(match) for match in NUMBER.findall(prompt)}
        allowed.update(str(value) for value in range(0, 25))

        # Only prose is scanned. Structured fields legitimately carry numbers
        # the prompt never mentioned — a confidence of 0.85 is the model's own
        # judgement, not a claim about the market — and counting those as
        # fabrications made the metric fire on correct answers.
        stated: set[str] = set()
        for text in _prose_fields(replies.get(example.id), raw_replies.get(example.id, "")):
            stated.update(_normalize(match) for match in NUMBER.findall(text))

        if stated - allowed:
            offenders.append(example.id)

    rate = len(offenders) / len(scored)

    return MetricResult(
        name="hallucinated_price_rate",
        score=rate,
        total=len(scored),
        passed=len(scored) - len(offenders),
        threshold=thresholds.get("hallucinated_price_rate_max"),
        lower_is_better=True,
        failures=offenders,
    )


def _no_action_correctness(
    examples: list[Example], replies: dict[str, dict | None], thresholds: dict[str, float]
) -> MetricResult:
    """Refuses exactly when it should, and does not refuse when it should not."""
    selected = [example for example in examples if example.domain is Domain.TRADING_DECISION]

    def correct(example: Example) -> bool:
        reply = replies.get(example.id)
        if reply is None:
            return False
        expected_refusal = example.expected_output.get("action") == TradeAction.NO_ACTION.value
        actual_refusal = reply.get("action") == TradeAction.NO_ACTION.value
        return expected_refusal == actual_refusal

    return _score("no_action_correctness", selected, correct, thresholds)


def _unsupported_chain(
    examples: list[Example],
    replies: dict[str, dict | None],
    raw_replies: dict[str, str],
    thresholds: dict[str, float],
) -> MetricResult:
    selected = [
        example
        for example in examples
        if example.domain is Domain.CHAIN_KNOWLEDGE and example.chain is None
    ]

    def rejected(example: Example) -> bool:
        reply = replies.get(example.id)
        if reply is None:
            return False
        if reply.get("status") == "INSUFFICIENT_DATA":
            return True
        # Or an explicit statement of the supported set.
        text = raw_replies.get(example.id, "").lower()
        return all(chain in text for chain in CHAINS)

    return _score("unsupported_chain_rejection", selected, rejected, thresholds)


def _lp_validity(
    examples: list[Example], replies: dict[str, dict | None], thresholds: dict[str, float]
) -> MetricResult:
    selected = [example for example in examples if example.domain is Domain.LP_REASONING]
    allowed = {action.value for action in LpAction}

    def valid(example: Example) -> bool:
        reply = replies.get(example.id)
        return reply is not None and reply.get("action") in allowed

    return _score("lp_action_validity", selected, valid, thresholds)


PROSE_FIELDS = ("reason", "summary", "detail", "notes")
PROSE_LIST_FIELDS = ("facts", "interpretation", "observations", "concerns", "stale_inputs")


def _prose_fields(reply: dict | None, raw: str) -> list[str]:
    """The parts of a reply that make claims about the world.

    An unparseable reply is scanned whole: if it is not structured output there
    is no way to tell a judgement from an assertion, and the conservative
    reading is that every number in it is a claim.
    """
    if reply is None:
        return [raw]

    texts: list[str] = []
    for key in PROSE_FIELDS:
        value = reply.get(key)
        if isinstance(value, str):
            texts.append(value)

    for key in PROSE_LIST_FIELDS:
        value = reply.get(key)
        if isinstance(value, list):
            texts.extend(item for item in value if isinstance(item, str))

    return texts


def _normalize(value: str) -> str:
    if "." not in value:
        return value
    return value.rstrip("0").rstrip(".")


def load_tokenizer(source: str, revision: str | None = None) -> Any:
    """The tokenizer that rendered the training prompts, and nothing else.

    A local adapter directory is preferred, because `train.py` saves the
    tokenizer and a `chat_template.jinja` beside the weights precisely so the
    template survives the trip. Falling back to the base repository is allowed
    but the revision has to be named: a template that has moved since training
    renders a different prompt, which is the failure this whole path exists to
    remove.
    """
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(source, revision=revision)

    local = Path(source) / "chat_template.jinja"
    if local.exists():
        tokenizer.chat_template = local.read_text(encoding="utf-8")

    if not getattr(tokenizer, "chat_template", None):
        raise SystemExit(
            f"{source} carries no chat template; evaluating without the training "
            "template would render a prompt the model has never seen"
        )
    return tokenizer


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate a model for ATRA")
    parser.add_argument("--data", type=Path, default=Path("data/out/test.jsonl"))
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument(
        "--model",
        default="oracle",
        help="'oracle', 'echo', or an OpenAI-compatible endpoint URL",
    )
    parser.add_argument("--model-name", default="atra-4b")
    parser.add_argument("--config", type=Path, default=Path("config/default.yaml"))
    parser.add_argument(
        "--serving",
        choices=("raw", "chat"),
        default="raw",
        help=(
            "raw: render the prompt here and POST /completion, which is what "
            "training saw. chat: POST /v1/chat/completions and let the server "
            "render and parse — how the runtime talks to Ollama."
        ),
    )
    parser.add_argument(
        "--tokenizer",
        default=None,
        help="adapter directory or base repo whose chat template rendered training",
    )
    parser.add_argument("--tokenizer-revision", default=None)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument(
        "--trace",
        type=Path,
        default=None,
        help="JSONL of every reply with its token accounting",
    )
    args = parser.parse_args()

    if not args.data.exists():
        print(f"no dataset at {args.data}; run data.build first", file=sys.stderr)
        return 2

    examples = load_jsonl(args.data)

    thresholds: dict[str, float] = {}
    if args.config.exists():
        try:
            import yaml  # type: ignore[import-untyped]

            config = yaml.safe_load(args.config.read_text(encoding="utf-8")) or {}
            thresholds = (config.get("evaluation") or {}).get("thresholds", {}) or {}
        except ImportError:
            print("PyYAML not installed; running without thresholds", file=sys.stderr)

    trace = ReplyTrace(args.trace)

    model: Model
    if args.model == "oracle":
        model = OracleModel()
    elif args.model == "echo":
        model = EchoModel()
    elif args.serving == "raw":
        if not args.tokenizer:
            print(
                "--serving raw needs --tokenizer: the prompt is rendered here, "
                "with the template training used",
                file=sys.stderr,
            )
            return 2
        model = RawCompletionModel(
            args.model,
            args.model_name,
            load_tokenizer(args.tokenizer, args.tokenizer_revision),
            max_tokens=args.max_tokens,
            trace=trace,
        )
    else:
        model = EndpointModel(
            args.model,
            args.model_name,
            trace=trace,
            max_tokens=args.max_tokens,
            tokenizer=(
                load_tokenizer(args.tokenizer, args.tokenizer_revision)
                if args.tokenizer
                else None
            ),
        )

    report = evaluate(model, examples, thresholds)
    trace.close()
    print(report.render())

    accounting = report.content_accounting
    if accounting.get("checked"):
        print()
        print(trace.render())

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report.to_json(), encoding="utf-8")
        print(f"\nwrote {args.out}")

    # A run where the serving path ate the answers is not a measurement of the
    # model, and run 2 proved that such a run reads exactly like a bad model.
    # It now refuses to be quoted: a distinct exit code, and the word in the
    # output, rather than eight plausible-looking floor values.
    lost = accounting.get("replies_losing_content", 0)
    if lost:
        print(
            f"\nCONTAMINATED: {lost} of {accounting['checked']} replies lost content "
            "between the model and the scorer. These metrics measure the serving "
            "path, not the model, and must not be quoted.",
            file=sys.stderr,
        )
        return 3

    failed = [metric for metric in report.metrics if metric.meets_threshold is False]
    if failed:
        print(f"\n{len(failed)} metric(s) below threshold: " + ", ".join(m.name for m in failed))
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
