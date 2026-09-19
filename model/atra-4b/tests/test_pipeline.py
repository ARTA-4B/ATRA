"""Tests for the ATRA-4B data and evaluation pipeline.

These run on CPU with no model, so CI can prove the pipeline is sound before
anyone spends GPU time on it. The cases that matter are the ones that must
*fail*: a leaked outcome, a duplicate prompt, an overlapping chronological
split, a dataset with too few refusals.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from data.build import build_all, write
from data.checks import check, dataset_hash, load_jsonl
from data.schema import (
    Domain,
    Example,
    Message,
    Outcome,
    ToolSpec,
    TradeAction,
    ValidationError,
    validate,
)
from evaluate import EchoModel, OracleModel, evaluate, parse_reply


SYSTEM = "You are ATRA's reasoning layer."


def example(**overrides) -> Example:
    base = {
        "id": "test-00001",
        "domain": Domain.TRADING_DECISION,
        "chain": "base",
        "decision_time": "2026-01-01T12:00:00Z",
        "created_at": "2026-01-01T12:00:00Z",
        "messages": [
            Message(role="system", content=SYSTEM),
            Message(role="user", content="Evidence: liquidity 400000 USD, price fresh."),
            Message(role="assistant", content="{}"),
        ],
        "tools": [],
        "expected_output": {
            "action": TradeAction.NO_ACTION.value,
            "chain": "base",
            "reason": "liquidity is below the policy minimum",
            "confidence": 0.8,
        },
    }
    base.update(overrides)
    return Example(**base)  # type: ignore[arg-type]


class TestValidation:
    def test_accepts_a_well_formed_example(self):
        validate(example())

    def test_rejects_an_unsupported_chain(self):
        with pytest.raises(ValidationError, match="unsupported chain"):
            validate(example(chain="ethereum"))

    def test_rejects_a_prompt_dated_after_the_decision(self):
        leaked = example(
            messages=[
                Message(role="system", content=SYSTEM),
                Message(
                    role="user",
                    content="Evidence observed at 2026-01-02T12:00:00Z: price 1.05 USD.",
                ),
                Message(role="assistant", content="{}"),
            ]
        )
        with pytest.raises(ValidationError, match="after decision_time"):
            validate(leaked)

    def test_accepts_a_prompt_dated_before_the_decision(self):
        fine = example(
            messages=[
                Message(role="system", content=SYSTEM),
                Message(
                    role="user",
                    content="Evidence observed at 2026-01-01T11:00:00Z: price 1.05 USD.",
                ),
                Message(role="assistant", content="{}"),
            ]
        )
        validate(fine)

    @pytest.mark.parametrize(
        "phrase",
        ["in hindsight", "it turned out", "would have returned", "as we now know"],
    )
    def test_rejects_outcome_language_in_the_prompt(self, phrase: str):
        leaked = example(
            messages=[
                Message(role="system", content=SYSTEM),
                Message(role="user", content=f"Evidence: liquidity 400000 USD. {phrase}, it fell."),
                Message(role="assistant", content="{}"),
            ]
        )
        with pytest.raises(ValidationError, match="outcome language"):
            validate(leaked)

    def test_rejects_an_outcome_note_that_appears_in_the_conversation(self):
        note = "the position lost forty percent over the following day"
        leaked = example(
            messages=[
                Message(role="system", content=SYSTEM),
                Message(role="user", content=f"Evidence: {note}."),
                Message(role="assistant", content="{}"),
            ],
            outcome=Outcome(notes=note),
        )
        with pytest.raises(ValidationError, match="outcome note"):
            validate(leaked)

    def test_rejects_an_unknown_trade_action(self):
        with pytest.raises(ValidationError, match="invalid trade action"):
            validate(example(expected_output={"action": "YOLO", "chain": "base", "reason": "x", "confidence": 0.5}))

    def test_rejects_confidence_outside_the_unit_interval(self):
        with pytest.raises(ValidationError, match="confidence"):
            validate(
                example(
                    expected_output={
                        "action": TradeAction.OPEN.value,
                        "chain": "base",
                        "reason": "x",
                        "confidence": 1.4,
                    }
                )
            )

    def test_rejects_a_near_certain_refusal(self):
        # A refusal claiming 0.99 confidence teaches the model the field is
        # decorative.
        with pytest.raises(ValidationError, match="near-certain"):
            validate(
                example(
                    expected_output={
                        "action": TradeAction.NO_ACTION.value,
                        "chain": "base",
                        "reason": "x",
                        "confidence": 0.99,
                    }
                )
            )

    def test_rejects_a_tool_call_to_an_undeclared_tool(self):
        with pytest.raises(ValidationError, match="undeclared tool"):
            validate(
                example(
                    domain=Domain.TOOL_USE,
                    tools=[ToolSpec(name="get_price", description="", parameters={})],
                    expected_output={"tool": "launch_missiles", "arguments": {}},
                )
            )

    def test_rejects_a_conversation_that_does_not_end_with_the_answer(self):
        with pytest.raises(ValidationError, match="last message"):
            validate(
                example(
                    messages=[
                        Message(role="system", content=SYSTEM),
                        Message(role="user", content="Evidence: liquidity 400000 USD."),
                    ]
                )
            )


class TestDatasetChecks:
    def test_the_generated_dataset_passes_every_gate(self):
        report = check(build_all(seed=42, per_domain=40))
        assert report.ok, report.render()

    def test_generation_is_deterministic(self):
        first = build_all(seed=42, per_domain=20)
        second = build_all(seed=42, per_domain=20)
        assert dataset_hash(first) == dataset_hash(second)

    def test_a_different_seed_gives_a_different_dataset(self):
        assert dataset_hash(build_all(seed=1, per_domain=20)) != dataset_hash(
            build_all(seed=2, per_domain=20)
        )

    def test_catches_duplicate_prompts(self):
        duplicate = example(id="test-00002")
        report = check([example(), duplicate])
        assert any("duplicate prompt" in error for error in report.errors)

    def test_catches_a_refusal_ratio_that_is_too_low(self):
        greedy = [
            example(
                id=f"greedy-{index}",
                messages=[
                    Message(role="system", content=SYSTEM),
                    Message(role="user", content=f"Evidence {index}: liquidity 900000 USD."),
                    Message(role="assistant", content="{}"),
                ],
                expected_output={
                    "action": TradeAction.OPEN.value,
                    "chain": "base",
                    "reason": "looks good",
                    "confidence": 0.7,
                },
            )
            for index in range(10)
        ]
        report = check(greedy)
        assert any("NO_ACTION" in error for error in report.errors)

    def test_catches_a_missing_chain(self):
        report = check([example()])
        assert any("no examples for chain" in error for error in report.errors)

    def test_catches_overlapping_historical_splits(self):
        train = example(
            id="hist-train",
            provenance="historical",
            split="train",
            decision_time="2026-06-01T00:00:00Z",
        )
        test = example(
            id="hist-test",
            provenance="historical",
            split="test",
            decision_time="2026-01-01T00:00:00Z",
            messages=[
                Message(role="system", content=SYSTEM),
                Message(role="user", content="Different evidence for the test split."),
                Message(role="assistant", content="{}"),
            ],
        )
        report = check([train, test])
        assert any("before" in error and "split" in error for error in report.errors)

    def test_writes_three_splits(self, tmp_path: Path):
        counts = write(build_all(seed=42, per_domain=40), tmp_path)
        assert all(count > 0 for count in counts.values())
        assert sum(counts.values()) == 200

        reloaded = load_jsonl(tmp_path / "train.jsonl")
        assert reloaded[0].messages[0].role == "system"

    def test_split_assignment_is_independent_of_template_variant(self):
        """The split must not be a function of the variant index.

        An earlier build derived the split from `index % 10` while template
        variants came from `index % 5`, so every test example came from the same
        variant and whole behaviours were never evaluated. This asserts the
        property directly rather than through a small sample: each variant class
        must receive a mix of splits.
        """
        from data.build import _split_for

        for variant in range(5):
            indices = [index for index in range(500) if index % 5 == variant]
            splits = {_split_for(index) for index in indices}
            assert splits == {"train", "validation", "test"}, (
                f"variant {variant} only ever lands in {splits}"
            )

    def test_every_trade_action_appears_somewhere_in_the_dataset(self):
        examples = build_all(seed=42, per_domain=100)
        trading = [e for e in examples if e.domain is Domain.TRADING_DECISION]
        actions = {e.expected_output.get("action") for e in trading}

        assert TradeAction.NO_ACTION.value in actions
        assert len(actions) >= 4, f"dataset covers too few actions: {actions}"


class TestEvaluation:
    @pytest.fixture
    def examples(self) -> list[Example]:
        return [e for e in build_all(seed=42, per_domain=40) if e.split == "test"]

    def test_the_oracle_scores_perfectly(self, examples: list[Example]):
        """Calibration: a model replaying the right answer must score 1.0.

        Any metric that scores the oracle below 1.0 is measuring something other
        than what its name claims.
        """
        report = evaluate(OracleModel(), examples)

        for metric in report.metrics:
            if metric.total == 0:
                continue
            expected = 0.0 if metric.lower_is_better else 1.0
            assert metric.score == expected, f"{metric.name} scored {metric.score}: {metric.failures[:3]}"

    def test_the_null_model_scores_at_the_floor(self, examples: list[Example]):
        """Calibration in the other direction: a useless model must fail."""
        report = evaluate(EchoModel(), examples)

        structured = next(m for m in report.metrics if m.name == "structured_output_validity")
        assert structured.score == 0.0

        for metric in report.metrics:
            if metric.total == 0 or metric.lower_is_better:
                continue
            assert metric.score == 0.0, f"{metric.name} scored {metric.score} for an empty reply"

    def test_a_report_records_the_dataset_it_ran_on(self, examples: list[Example]):
        report = evaluate(OracleModel(), examples)
        payload = json.loads(report.to_json())

        assert payload["dataset_hash"] == dataset_hash(examples)
        assert payload["examples"] == len(examples)
        assert payload["ran_at"].endswith("Z")


class TestReplyParsing:
    def test_parses_a_bare_object(self):
        assert parse_reply('{"action":"NO_ACTION"}') == {"action": "NO_ACTION"}

    def test_parses_a_fenced_object(self):
        assert parse_reply('```json\n{"action":"OPEN"}\n```') == {"action": "OPEN"}

    def test_parses_an_object_surrounded_by_prose(self):
        assert parse_reply('Sure!\n{"action":"CLOSE"}\nHope that helps.') == {"action": "CLOSE"}

    def test_handles_braces_inside_strings(self):
        assert parse_reply('{"reason":"a } brace"}') == {"reason": "a } brace"}

    def test_returns_none_for_prose(self):
        assert parse_reply("I think you should buy.") is None

    def test_returns_none_for_an_empty_reply(self):
        assert parse_reply("") is None
        assert parse_reply("   ") is None

    def test_returns_none_for_truncated_json(self):
        assert parse_reply('{"action":"OPEN"') is None

    def test_returns_none_for_a_json_array(self):
        assert parse_reply("[1, 2, 3]") is None
