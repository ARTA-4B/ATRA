"""Training-example schema and validator for ATRA-4B.

Every example is a conversation that ends in a structured decision. Two rules
shape the whole schema, and the validator enforces both:

1. **Nothing in the prompt may postdate the decision.** A historical example
   that leaks tomorrow's price teaches the model to expect information it will
   never have at inference time, and the resulting evaluation numbers are
   fiction. The outcome lives in a separate field that is never rendered.

2. **Refusal is a first-class label.** ``NO_ACTION`` and ``INSUFFICIENT_DATA``
   are correct answers, not failures, and the dataset is required to contain
   enough of them that the model learns to produce them.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Iterable


SCHEMA_VERSION = 1

CHAINS = ("base", "bsc", "robinhood", "solana")


class Domain(str, Enum):
    """The seven domains the dataset covers."""

    TOOL_USE = "tool_use"
    MARKET_REASONING = "market_reasoning"
    ONCHAIN_REASONING = "onchain_reasoning"
    TRADING_DECISION = "trading_decision"
    LP_REASONING = "lp_reasoning"
    RISK_REASONING = "risk_reasoning"
    CHAIN_KNOWLEDGE = "chain_knowledge"


class TradeAction(str, Enum):
    NO_ACTION = "NO_ACTION"
    OPEN = "OPEN"
    REDUCE = "REDUCE"
    CLOSE = "CLOSE"
    SWAP = "SWAP"


class LpAction(str, Enum):
    HOLD = "HOLD"
    ADD_LIQUIDITY = "ADD_LIQUIDITY"
    REMOVE_LIQUIDITY = "REMOVE_LIQUIDITY"
    REBALANCE = "REBALANCE"
    COLLECT_FEES = "COLLECT_FEES"
    EXIT = "EXIT"


class ResearchStatus(str, Enum):
    OK = "OK"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


@dataclass
class Message:
    role: str  # system | user | assistant | tool
    content: str
    tool_call_id: str | None = None
    name: str | None = None


@dataclass
class ToolSpec:
    """A tool the model may call, in JSON-schema form."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class Outcome:
    """What actually happened afterwards.

    Held separately from the conversation and never rendered into a prompt. It
    exists so evaluation can ask "was the refusal correct?" without the model
    having been shown the answer.
    """

    realized_return_bps: int | None = None
    was_correct: bool | None = None
    notes: str = ""


@dataclass
class Example:
    id: str
    domain: Domain
    schema_version: int = SCHEMA_VERSION

    chain: str | None = None
    # The instant the decision is made. Nothing in `messages` may be newer.
    decision_time: str = ""
    created_at: str = ""

    messages: list[Message] = field(default_factory=list)
    tools: list[ToolSpec] = field(default_factory=list)

    # The structured answer the model should produce, as a dict.
    expected_output: dict[str, Any] = field(default_factory=dict)

    outcome: Outcome | None = None

    provenance: str = "synthetic"
    license: str = "MIT"
    quality_score: float = 1.0
    split: str = "train"  # train | validation | test

    # Explicit behaviour labels, e.g. "stale", "unsupported-chain", "refusal".
    # Evaluation selects on these rather than grepping the text, which is how a
    # metric ends up scoring "threshold" as a staleness case.
    tags: list[str] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(asdict(self), default=str, sort_keys=True)


class ValidationError(Exception):
    """Raised for an example that must not enter the dataset."""


ISO = "%Y-%m-%dT%H:%M:%SZ"

# Any timestamp-looking string inside a rendered message.
TIMESTAMP_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")

# Phrases that give away a future outcome. A prompt containing one of these is
# teaching the model to read the answer off the question.
LEAKAGE_PHRASES = (
    "in hindsight",
    "it turned out",
    "the price later",
    "would have returned",
    "as we now know",
    "the correct answer is",
    "eventually rose",
    "eventually fell",
)


def parse_time(value: str) -> datetime:
    return datetime.strptime(value, ISO).replace(tzinfo=timezone.utc)


def validate(example: Example) -> None:
    """Raise :class:`ValidationError` if the example is unusable.

    Deliberately strict. A dataset is the one artefact whose defects are
    invisible in the final model, so anything ambiguous is rejected rather than
    repaired.
    """
    if example.schema_version != SCHEMA_VERSION:
        raise ValidationError(f"{example.id}: unsupported schema version")

    if not example.id:
        raise ValidationError("an example has no id")

    if example.chain is not None and example.chain not in CHAINS:
        raise ValidationError(f"{example.id}: unsupported chain {example.chain!r}")

    if not example.decision_time:
        raise ValidationError(f"{example.id}: decision_time is required")

    try:
        decision_at = parse_time(example.decision_time)
    except ValueError as error:
        raise ValidationError(f"{example.id}: malformed decision_time") from error

    if not example.messages:
        raise ValidationError(f"{example.id}: no messages")

    roles = [message.role for message in example.messages]
    if roles[0] != "system":
        raise ValidationError(f"{example.id}: the first message must be the system prompt")
    if roles[-1] != "assistant":
        raise ValidationError(f"{example.id}: the last message must be the assistant answer")
    for role in roles:
        if role not in ("system", "user", "assistant", "tool"):
            raise ValidationError(f"{example.id}: unknown role {role!r}")

    _check_no_future_leakage(example, decision_at)
    _check_expected_output(example)

    if example.split not in ("train", "validation", "test"):
        raise ValidationError(f"{example.id}: unknown split {example.split!r}")


def _check_no_future_leakage(example: Example, decision_at: datetime) -> None:
    """Refuse any prompt that contains information from after the decision."""
    prompt_messages = [m for m in example.messages if m.role != "assistant"]

    for message in prompt_messages:
        lowered = message.content.lower()
        for phrase in LEAKAGE_PHRASES:
            if phrase in lowered:
                raise ValidationError(
                    f"{example.id}: prompt contains outcome language ({phrase!r})"
                )

        for match in TIMESTAMP_PATTERN.findall(message.content):
            try:
                stamp = parse_time(match)
            except ValueError:
                continue
            if stamp > decision_at:
                raise ValidationError(
                    f"{example.id}: prompt references {match}, after decision_time"
                )

    # The outcome must never appear in the conversation at all.
    if example.outcome is not None and example.outcome.notes:
        rendered = " ".join(m.content for m in example.messages).lower()
        if example.outcome.notes.lower()[:40] in rendered:
            raise ValidationError(f"{example.id}: the outcome note appears in the conversation")


def _check_expected_output(example: Example) -> None:
    """The answer must match the domain's schema exactly."""
    output = example.expected_output
    if not isinstance(output, dict) or not output:
        raise ValidationError(f"{example.id}: expected_output must be a non-empty object")

    if example.domain is Domain.TRADING_DECISION:
        action = output.get("action")
        if action not in {a.value for a in TradeAction}:
            raise ValidationError(f"{example.id}: invalid trade action {action!r}")
        for key in ("chain", "reason", "confidence"):
            if key not in output:
                raise ValidationError(f"{example.id}: trading output is missing {key}")
        confidence = output.get("confidence")
        if not isinstance(confidence, (int, float)) or not 0.0 <= float(confidence) <= 1.0:
            raise ValidationError(f"{example.id}: confidence must be between 0 and 1")
        # A refusal that claims high confidence is incoherent and teaches the
        # model that the field means nothing.
        if action == TradeAction.NO_ACTION.value and float(confidence) > 0.9:
            raise ValidationError(f"{example.id}: NO_ACTION with near-certain confidence")

    elif example.domain is Domain.LP_REASONING:
        action = output.get("action")
        if action not in {a.value for a in LpAction}:
            raise ValidationError(f"{example.id}: invalid LP action {action!r}")

    elif example.domain is Domain.TOOL_USE:
        if "tool" not in output and "status" not in output:
            raise ValidationError(f"{example.id}: tool-use output needs a tool or a status")
        tool = output.get("tool")
        if tool is not None:
            declared = {spec.name for spec in example.tools}
            if tool not in declared:
                raise ValidationError(f"{example.id}: calls undeclared tool {tool!r}")

    elif example.domain in (Domain.MARKET_REASONING, Domain.ONCHAIN_REASONING):
        status = output.get("status")
        if status not in {s.value for s in ResearchStatus}:
            raise ValidationError(f"{example.id}: invalid research status {status!r}")


def validate_all(examples: Iterable[Example]) -> list[str]:
    """Validate a collection, returning every error rather than the first."""
    errors: list[str] = []
    seen_ids: set[str] = set()

    for example in examples:
        if example.id in seen_ids:
            errors.append(f"{example.id}: duplicate id")
            continue
        seen_ids.add(example.id)

        try:
            validate(example)
        except ValidationError as error:
            errors.append(str(error))

    return errors
