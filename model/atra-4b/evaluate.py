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


class EndpointModel:
    """A real model behind an OpenAI-compatible endpoint."""

    def __init__(self, endpoint: str, model: str, timeout: float = 120.0) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.name = model
        self.timeout = timeout

    def generate(self, example: Example) -> str:
        import urllib.request

        messages = [
            {"role": message.role, "content": message.content}
            for message in example.messages
            if message.role != "assistant"
        ]

        payload = json.dumps(
            {
                "model": self.name,
                "messages": messages,
                "temperature": 0.0,
                "max_tokens": 512,
                "stream": False,
            }
        ).encode("utf-8")

        request = urllib.request.Request(
            f"{self.endpoint}/v1/chat/completions",
            data=payload,
            headers={"content-type": "application/json"},
        )

        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            body = json.loads(response.read())

        return body["choices"][0]["message"]["content"] or ""


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

    def render(self) -> str:
        width = max(len(metric.name) for metric in self.metrics) + 2
        lines = [
            f"model   : {self.model}",
            f"dataset : {self.dataset_hash[:16]}… ({self.examples} examples)",
            f"ran at  : {self.ran_at} in {self.duration_sec:.1f}s",
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

    return EvaluationReport(
        model=model.name,
        dataset_hash=dataset_hash(examples),
        examples=len(examples),
        ran_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        duration_sec=round(time.time() - started, 2),
        metrics=metrics,
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

    model: Model
    if args.model == "oracle":
        model = OracleModel()
    elif args.model == "echo":
        model = EchoModel()
    else:
        model = EndpointModel(args.model, args.model_name)

    report = evaluate(model, examples, thresholds)
    print(report.render())

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report.to_json(), encoding="utf-8")
        print(f"\nwrote {args.out}")

    failed = [metric for metric in report.metrics if metric.meets_threshold is False]
    if failed:
        print(f"\n{len(failed)} metric(s) below threshold: " + ", ".join(m.name for m in failed))
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
