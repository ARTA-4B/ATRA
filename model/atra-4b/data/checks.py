"""Dataset quality gates.

These run before any training and fail the build rather than warn. A dataset
defect is invisible in the trained model but shows up as a confident wrong
answer months later, so the checks are deliberately unforgiving.

What is checked:

- **Leakage** — nothing in a prompt may postdate its decision time, and no
  historical example may appear in a split earlier than one it chronologically
  follows.
- **Duplication** — exact and near-duplicate prompts inflate apparent dataset
  size and let the model memorise instead of generalise.
- **Balance** — refusals must be well represented. A model that has rarely seen
  ``NO_ACTION`` will not produce it when it matters.
- **Chain coverage** — all four chains must appear, so the model does not learn
  that "chain" means Base.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .schema import (
    CHAINS,
    Domain,
    Example,
    Message,
    Outcome,
    ToolSpec,
    TradeAction,
    parse_time,
    validate_all,
)


# A dataset with fewer refusals than this teaches the model that doing nothing
# is an edge case. It is the single most important behaviour ATRA needs.
MIN_NO_ACTION_RATIO = 0.40

# Near-duplicate threshold on token-set similarity.
MAX_JACCARD = 0.90


@dataclass
class CheckReport:
    total: int
    errors: list[str]
    warnings: list[str]
    stats: dict[str, object]

    @property
    def ok(self) -> bool:
        return not self.errors

    def render(self) -> str:
        lines = [f"examples: {self.total}"]
        for key, value in sorted(self.stats.items()):
            lines.append(f"  {key}: {value}")
        if self.warnings:
            lines.append(f"warnings ({len(self.warnings)}):")
            lines.extend(f"  - {warning}" for warning in self.warnings[:20])
        if self.errors:
            lines.append(f"ERRORS ({len(self.errors)}):")
            lines.extend(f"  - {error}" for error in self.errors[:40])
        else:
            lines.append("no errors")
        return "\n".join(lines)


def load_jsonl(path: Path) -> list[Example]:
    examples: list[Example] = []

    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{line_number}: malformed JSON") from error
        examples.append(_from_dict(raw))

    return examples


def _from_dict(raw: dict) -> Example:
    outcome = raw.get("outcome")
    return Example(
        id=raw["id"],
        domain=Domain(raw["domain"]),
        schema_version=raw.get("schema_version", 1),
        chain=raw.get("chain"),
        decision_time=raw.get("decision_time", ""),
        created_at=raw.get("created_at", ""),
        messages=[Message(**message) for message in raw.get("messages", [])],
        tools=[ToolSpec(**tool) for tool in raw.get("tools", [])],
        expected_output=raw.get("expected_output", {}),
        outcome=Outcome(**outcome) if outcome else None,
        provenance=raw.get("provenance", "synthetic"),
        license=raw.get("license", "MIT"),
        quality_score=raw.get("quality_score", 1.0),
        split=raw.get("split", "train"),
        tags=list(raw.get("tags", [])),
    )


def check(examples: list[Example]) -> CheckReport:
    errors = validate_all(examples)
    warnings: list[str] = []

    errors.extend(_check_duplicates(examples))
    errors.extend(_check_chronological_splits(examples))
    warnings.extend(_check_near_duplicates(examples))

    stats = _statistics(examples)

    refusal_ratio = stats.get("no_action_ratio", 0.0)
    if isinstance(refusal_ratio, float) and stats.get("trading_examples", 0):
        if refusal_ratio < MIN_NO_ACTION_RATIO:
            errors.append(
                f"only {refusal_ratio:.0%} of trading examples are NO_ACTION; "
                f"at least {MIN_NO_ACTION_RATIO:.0%} is required"
            )

    missing_chains = [chain for chain in CHAINS if stats.get(f"chain_{chain}", 0) == 0]
    if missing_chains:
        errors.append(f"no examples for chain(s): {', '.join(missing_chains)}")

    for split in ("train", "validation", "test"):
        if stats.get(f"split_{split}", 0) == 0:
            errors.append(f"split {split!r} is empty")

    return CheckReport(total=len(examples), errors=errors, warnings=warnings, stats=stats)


def _check_duplicates(examples: Iterable[Example]) -> list[str]:
    """Exact duplicate prompts, by hash of the non-assistant turns."""
    seen: dict[str, str] = {}
    errors: list[str] = []

    for example in examples:
        digest = _prompt_hash(example)
        if digest in seen:
            errors.append(f"{example.id}: duplicate prompt of {seen[digest]}")
        else:
            seen[digest] = example.id

    return errors


def _check_near_duplicates(examples: list[Example]) -> list[str]:
    """Flag prompts that are nearly identical.

    Reported as warnings, not errors: templated generation legitimately
    produces similar prompts, and the right response is usually to widen the
    generator rather than to drop examples.
    """
    warnings: list[str] = []
    token_sets = [(example.id, _tokens(example)) for example in examples]

    for index, (left_id, left) in enumerate(token_sets):
        for right_id, right in token_sets[index + 1 : index + 40]:
            if not left or not right:
                continue
            similarity = len(left & right) / len(left | right)
            if similarity >= MAX_JACCARD:
                warnings.append(
                    f"{left_id} and {right_id} are {similarity:.0%} similar"
                )

    return warnings


def _check_chronological_splits(examples: list[Example]) -> list[str]:
    """Historical splits must not overlap in time.

    If a test example predates a training example, the model has been trained
    on the future of its own test set and every metric is optimistic.
    """
    errors: list[str] = []
    bounds: dict[str, tuple[str, str]] = {}

    for split in ("train", "validation", "test"):
        stamps = sorted(
            example.decision_time
            for example in examples
            if example.split == split and example.provenance == "historical"
        )
        if stamps:
            bounds[split] = (stamps[0], stamps[-1])

    order = [split for split in ("train", "validation", "test") if split in bounds]
    for earlier, later in zip(order, order[1:]):
        if parse_time(bounds[later][0]) < parse_time(bounds[earlier][1]):
            errors.append(
                f"historical {later} split starts at {bounds[later][0]}, "
                f"before {earlier} ends at {bounds[earlier][1]}"
            )

    return errors


def _statistics(examples: list[Example]) -> dict[str, object]:
    domains = Counter(example.domain.value for example in examples)
    splits = Counter(example.split for example in examples)
    chains = Counter(example.chain for example in examples if example.chain)

    trading = [e for e in examples if e.domain is Domain.TRADING_DECISION]
    no_action = [
        e for e in trading if e.expected_output.get("action") == TradeAction.NO_ACTION.value
    ]

    stats: dict[str, object] = {
        "trading_examples": len(trading),
        "no_action_examples": len(no_action),
        "no_action_ratio": (len(no_action) / len(trading)) if trading else 0.0,
    }

    for domain, count in domains.items():
        stats[f"domain_{domain}"] = count
    for split, count in splits.items():
        stats[f"split_{split}"] = count
    for chain in CHAINS:
        stats[f"chain_{chain}"] = chains.get(chain, 0)

    return stats


def _prompt_hash(example: Example) -> str:
    prompt = "\n".join(
        f"{message.role}:{message.content}"
        for message in example.messages
        if message.role != "assistant"
    )
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def _tokens(example: Example) -> set[str]:
    text = " ".join(m.content for m in example.messages if m.role == "user")
    return set(text.lower().split())


def dataset_hash(examples: list[Example]) -> str:
    """A stable hash of the whole dataset, recorded in every training run."""
    digest = hashlib.sha256()
    for example in sorted(examples, key=lambda item: item.id):
        digest.update(example.to_json().encode("utf-8"))
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate an ATRA-4B dataset")
    parser.add_argument("directory", type=Path, help="directory containing *.jsonl")
    args = parser.parse_args()

    files = sorted(args.directory.glob("*.jsonl"))
    if not files:
        print(f"no .jsonl files found in {args.directory}", file=sys.stderr)
        return 2

    examples: list[Example] = []
    for path in files:
        examples.extend(load_jsonl(path))

    report = check(examples)
    print(report.render())
    print(f"dataset hash: {dataset_hash(examples)}")

    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
