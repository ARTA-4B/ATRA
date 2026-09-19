"""Deterministic dataset generation for ATRA-4B.

Examples are generated from templates with a fixed seed, so the same seed gives
byte-identical output and a dataset can be reproduced from its hash alone.

The generators are written around the behaviours ATRA actually needs:

- calling the right tool with valid arguments, and **waiting** for the result
  rather than inventing one;
- refusing when data is stale, missing, contradictory or off-policy;
- telling the four supported chains apart and rejecting everything else;
- producing a schema-valid structured decision every single time.

Refusals are the majority class on purpose. An agent that trades whenever it is
asked is not useful; one that declines most of the time and explains why is.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .schema import (
    CHAINS,
    Domain,
    Example,
    LpAction,
    Message,
    Outcome,
    ResearchStatus,
    ToolSpec,
    TradeAction,
)


# Phrasings, so the same underlying situation is asked about in different words.
# Without this the templates collapse into a handful of identical prompts, the
# duplicate check fails, and a model trained on them memorises wording rather
# than reasoning.
ASK_TRADE = (
    "Should ATRA open a position?",
    "Is this a market ATRA should enter?",
    "What should ATRA do here?",
    "Does this justify deploying capital?",
    "Recommend an action for this market.",
)

ASK_CHAIN = (
    "What does ATRA need to know about {chain} before trading on it?",
    "Summarise how {chain} differs from the other chains ATRA supports.",
    "An operator is enabling {chain}. What matters?",
    "Describe {chain} for the purposes of routing a trade.",
    "What are the gas and address characteristics of {chain}?",
)

ASK_UNSUPPORTED = (
    "Should ATRA open a position on {chain}?",
    "Can ATRA route a swap through {chain}?",
    "An operator wants to add {chain}. Is that possible?",
    "Evaluate this {chain} opportunity.",
    "Is {chain} available for automation?",
)

SYSTEM_PROMPT = (
    "You are ATRA's reasoning layer. You read evidence and produce a structured "
    "decision. You never sign transactions, never move funds, and never state a "
    "number that is not in the evidence. When the evidence is insufficient, "
    "stale or off-policy, you answer NO_ACTION and say why. Reply only with JSON."
)

EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)
ISO = "%Y-%m-%dT%H:%M:%SZ"

TOOLS = [
    ToolSpec(
        name="get_market_snapshot",
        description="Current price, liquidity and volume for a pool.",
        parameters={
            "type": "object",
            "required": ["chain", "pool_id"],
            "properties": {
                "chain": {"type": "string", "enum": list(CHAINS)},
                "pool_id": {"type": "string"},
            },
        },
    ),
    ToolSpec(
        name="get_ohlcv",
        description="Historical candles for a pool.",
        parameters={
            "type": "object",
            "required": ["chain", "pool_id", "timeframe"],
            "properties": {
                "chain": {"type": "string", "enum": list(CHAINS)},
                "pool_id": {"type": "string"},
                "timeframe": {"type": "string", "enum": ["5m", "1h", "1d"]},
            },
        },
    ),
    ToolSpec(
        name="get_token_balance",
        description="Wallet balance of a token.",
        parameters={
            "type": "object",
            "required": ["chain", "token"],
            "properties": {
                "chain": {"type": "string", "enum": list(CHAINS)},
                "token": {"type": "string"},
            },
        },
    ),
    ToolSpec(
        name="get_risk_policy",
        description="The operator's current hard limits.",
        parameters={"type": "object", "properties": {}},
    ),
]

TOOL_NAMES = [tool.name for tool in TOOLS]


def _stamp(minutes: int) -> str:
    return (EPOCH + timedelta(minutes=minutes)).strftime(ISO)


def _example(
    index: int,
    domain: Domain,
    chain: str | None,
    minute: int,
    user: str,
    answer: dict,
    split: str,
    *,
    tool_turns: list[Message] | None = None,
    outcome: Outcome | None = None,
    tags: list[str] | None = None,
) -> Example:
    messages = [Message(role="system", content=SYSTEM_PROMPT), Message(role="user", content=user)]
    if tool_turns:
        messages.extend(tool_turns)
    messages.append(Message(role="assistant", content=json.dumps(answer, sort_keys=True)))

    return Example(
        id=f"{domain.value}-{index:05d}",
        domain=domain,
        chain=chain,
        decision_time=_stamp(minute),
        created_at=_stamp(minute),
        messages=messages,
        tools=TOOLS,
        expected_output=answer,
        outcome=outcome,
        split=split,
        tags=tags or [],
    )


def _split_for(index: int) -> str:
    """80/10/10, deterministic but independent of the template variant.

    A plain `index % 10` correlated with the `index % 5` used to pick template
    variants, so every test example came from the same variant and whole
    behaviours were never evaluated. Hashing the index breaks that alignment
    while staying reproducible.
    """
    bucket = int(hashlib.sha256(str(index).encode("utf-8")).hexdigest()[:8], 16) % 10
    if bucket == 8:
        return "validation"
    if bucket == 9:
        return "test"
    return "train"


def build_tool_use(rng: random.Random, count: int) -> list[Example]:
    """Selecting the right tool, and refusing to invent its result."""
    examples: list[Example] = []

    for index in range(count):
        chain = rng.choice(CHAINS)
        minute = index * 7
        split = _split_for(index)
        variant = index % 5

        if variant == 0:
            user = f"What is the current price in pool 0xpool{index} on {chain}?"
            answer = {
                "tool": "get_market_snapshot",
                "arguments": {"chain": chain, "pool_id": f"0xpool{index}"},
                "reason": "The current price requires a market snapshot.",
            }
            examples.append(_example(index, Domain.TOOL_USE, chain, minute, user, answer, split))

        elif variant == 1:
            user = f"How did pool 0xpool{index} on {chain} move over the last day?"
            answer = {
                "tool": "get_ohlcv",
                "arguments": {"chain": chain, "pool_id": f"0xpool{index}", "timeframe": "1h"},
                "reason": "A movement over time requires candles, not a spot price.",
            }
            examples.append(_example(index, Domain.TOOL_USE, chain, minute, user, answer, split))

        elif variant == 2:
            # The tool failed. The model must report the failure, not guess.
            user = f"What is the price in pool 0xpool{index} on {chain}?"
            tool_turns = [
                Message(
                    role="tool",
                    name="get_market_snapshot",
                    tool_call_id=f"call-{index}",
                    content=json.dumps({"error": "UPSTREAM_UNAVAILABLE", "detail": "provider timed out"}),
                )
            ]
            answer = {
                "status": "INSUFFICIENT_DATA",
                "reason": "The market data provider did not respond, so no price is known.",
            }
            examples.append(
                _example(
                    index,
                    Domain.TOOL_USE,
                    chain,
                    minute,
                    user,
                    answer,
                    split,
                    tool_turns=tool_turns,
                )
            )

        elif variant == 3:
            # Rate limited: wait rather than fabricate.
            user = f"Check the balance of token 0xtok{index} on {chain}."
            tool_turns = [
                Message(
                    role="tool",
                    name="get_token_balance",
                    tool_call_id=f"call-{index}",
                    content=json.dumps({"error": "RATE_LIMITED", "retry_after_sec": 30}),
                )
            ]
            answer = {
                "status": "INSUFFICIENT_DATA",
                "reason": "The balance lookup was rate limited; the balance is unknown until it succeeds.",
            }
            examples.append(
                _example(
                    index,
                    Domain.TOOL_USE,
                    chain,
                    minute,
                    user,
                    answer,
                    split,
                    tool_turns=tool_turns,
                )
            )

        else:
            # A tool that does not exist must not be invented.
            user = f"Use the sentiment analyser to score token 0xtok{index} on {chain}."
            answer = {
                "status": "INSUFFICIENT_DATA",
                "reason": (
                    "No sentiment tool is available. The tools I have are "
                    + ", ".join(TOOL_NAMES)
                    + "."
                ),
            }
            examples.append(_example(index, Domain.TOOL_USE, chain, minute, user, answer, split))

    return examples


def build_trading(rng: random.Random, count: int) -> list[Example]:
    """Trading decisions, weighted heavily towards refusal."""
    examples: list[Example] = []

    for index in range(count):
        chain = rng.choice(CHAINS)
        minute = 10_000 + index * 11
        split = _split_for(index)
        variant = index % 10

        # Seven of every ten are refusals, each for a different reason, so the
        # model learns the distinct shapes of "no" rather than one catch-all.
        ask = ASK_TRADE[index % len(ASK_TRADE)]
        pool = f"0xpool{index}"
        # Derived from the index so no two examples read alike.
        liquidity = 250_000 + index * 9_137
        price = f"{1 + (index % 97) / 100:.4f}"

        if variant == 0:
            price_age = 600 + index * 37
            user = (
                f"Evidence for {chain}: price {price} USD observed {price_age}s ago "
                f"(limit 120s), liquidity {liquidity} USD, policy max trade 25 USD. {ask}"
            )
            answer = {
                "action": TradeAction.NO_ACTION.value,
                "chain": chain,
                "market": f"0xpool{index}",
                "reason": (
                    f"The price is {price_age}s old and the freshness limit is 120s."
                ),
                "confidence": 0.85,
                "requestedNotionalUsd": "0",
            }

        elif variant == 1:
            thin = 1_000 + index * 211
            user = (
                f"Evidence for {chain}: liquidity {thin} USD, policy minimum liquidity "
                f"250000 USD, price {price} USD fresh. {ask}"
            )
            answer = {
                "action": TradeAction.NO_ACTION.value,
                "chain": chain,
                "market": f"0xpool{index}",
                "reason": "Liquidity is far below the policy minimum, so any entry would move the price against itself.",
                "confidence": 0.9,
                "requestedNotionalUsd": "0",
            }

        elif variant == 2:
            user = (
                f"Evidence for {chain}: token 0xunknown{index} is not on the allowlist. "
                f"Price {price} USD, liquidity {liquidity} USD. {ask}"
            )
            answer = {
                "action": TradeAction.NO_ACTION.value,
                "chain": chain,
                "market": f"0xunknown{index}",
                "reason": "The token is not allowlisted, so it cannot be traded regardless of how the market looks.",
                "confidence": 0.9,
                "requestedNotionalUsd": "0",
            }

        elif variant == 3:
            spread = 300 + index * 23
            user = (
                f"Evidence for {chain}: two providers disagree about pool {pool} by "
                f"{spread} bps, tolerance 200 bps. {ask}"
            )
            answer = {
                "action": TradeAction.NO_ACTION.value,
                "chain": chain,
                "market": f"0xpool{index}",
                "reason": (
                    f"The two price sources disagree by {spread} bps, so neither can be relied on."
                ),
                "confidence": 0.8,
                "requestedNotionalUsd": "0",
            }

        elif variant == 4:
            user = (
                f"Evidence for {chain}: no price could be retrieved for pool {pool}. "
                f"Liquidity unknown. {ask}"
            )
            answer = {
                "action": TradeAction.NO_ACTION.value,
                "chain": chain,
                "market": f"0xpool{index}",
                "reason": "There is no price and no liquidity figure, so there is nothing to judge.",
                "confidence": 0.9,
                "requestedNotionalUsd": "0",
            }

        elif variant == 5:
            loss = 40 + (index % 10)
            user = (
                f"Evidence for {chain}: daily loss so far {loss} USD, policy limit 50 USD, "
                f"fee estimate 2 USD, pool {pool}. {ask}"
            )
            answer = {
                "action": TradeAction.NO_ACTION.value,
                "chain": chain,
                "market": f"0xpool{index}",
                "reason": (
                    f"The day's loss of {loss} USD plus the fee would reach the daily limit."
                ),
                "confidence": 0.85,
                "requestedNotionalUsd": "0",
            }

        elif variant == 6:
            elapsed = 1 + (index % 14)
            user = (
                f"Evidence for {chain}: the last action in pool {pool} was {elapsed} minutes "
                f"ago and the cooldown is 15 minutes. {ask}"
            )
            answer = {
                "action": TradeAction.NO_ACTION.value,
                "chain": chain,
                "market": f"0xpool{index}",
                "reason": "The market cooldown has not elapsed.",
                "confidence": 0.9,
                "requestedNotionalUsd": "0",
            }

        elif variant == 7:
            user = (
                f"Evidence for {chain}: price {price} USD fresh, liquidity {liquidity} USD, "
                f"spread {10 + index % 20} bps, policy max trade 25 USD, pool {pool}, "
                f"wallet holds 500 USDC. A rebalance into WETH is requested."
            )
            answer = {
                "action": TradeAction.SWAP.value,
                "chain": chain,
                "market": f"0xpool{index}",
                "reason": "Data is fresh, liquidity is deep and the size fits the per-trade limit.",
                "confidence": 0.6,
                "requestedNotionalUsd": "25",
            }

        elif variant == 8:
            drawdown = 5 + (index % 30)
            user = (
                f"Evidence for {chain}: the open position in {pool} is {drawdown}% below cost, "
                f"price fresh, liquidity {liquidity} USD. The operator asked to reduce exposure."
            )
            answer = {
                "action": TradeAction.REDUCE.value,
                "chain": chain,
                "market": f"0xpool{index}",
                "reason": "Reducing an existing position lowers exposure and the market is liquid enough to exit.",
                "confidence": 0.7,
                "requestedNotionalUsd": "12",
            }

        else:
            user = (
                f"Evidence for {chain}: the position in {pool} reached its target, price fresh, "
                f"liquidity {liquidity} USD, no capacity left under the deployment cap."
            )
            answer = {
                "action": TradeAction.CLOSE.value,
                "chain": chain,
                "market": f"0xpool{index}",
                "reason": "The position reached its target and no capacity remains to extend it.",
                "confidence": 0.65,
                "requestedNotionalUsd": "20",
            }

        # variant 0 is the freshness refusal; variant 4 is missing data. Both are
        # what the stale-rejection metric is meant to measure.
        tags = ["refusal"] if answer["action"] == TradeAction.NO_ACTION.value else []
        if variant in (0, 4):
            tags.append("stale")

        examples.append(
            _example(
                index,
                Domain.TRADING_DECISION,
                chain,
                minute,
                user,
                answer,
                split,
                outcome=Outcome(realized_return_bps=rng.randint(-400, 400), was_correct=None),
                tags=tags,
            )
        )

    return examples


def build_market_reasoning(rng: random.Random, count: int) -> list[Example]:
    examples: list[Example] = []

    for index in range(count):
        chain = rng.choice(CHAINS)
        minute = 20_000 + index * 13
        split = _split_for(index)

        if index % 3 == 0:
            close_from = f"{1 + (index % 50) / 100:.2f}"
            close_to = f"{1 + (index % 50) / 100 + 0.04:.2f}"
            volume = 100_000 + index * 7_919
            user = (
                f"Evidence for {chain}, pool 0xpool{index}: 24 hourly candles, close moved "
                f"from {close_from} to {close_to}, volume {volume} USD, liquidity "
                f"{500_000 + index * 3_137} USD, all observed 30s ago."
            )
            answer = {
                "status": ResearchStatus.OK.value,
                "facts": [
                    f"close moved from {close_from} to {close_to}",
                    f"volume {volume} USD",
                ],
                "interpretation": ["The market rose modestly on volume that liquidity supports."],
                "stale_inputs": [],
            }
        elif index % 3 == 1:
            liquidity = 500_000 + index * 4_241
            user = (
                f"Evidence for {chain}, pool 0xpool{index}: liquidity {liquidity} USD observed "
                f"30s ago; no candles were returned by any provider."
            )
            answer = {
                "status": ResearchStatus.INSUFFICIENT_DATA.value,
                "facts": [f"liquidity {liquidity} USD"],
                "interpretation": [],
                "stale_inputs": ["no historical candles were available"],
            }
        else:
            age = 600 + index * 53
            stale_price = f"{1 + (index % 40) / 100:.2f}"
            user = (
                f"Evidence for {chain}, pool 0xpool{index}: price {stale_price} USD observed "
                f"{age}s ago, liquidity unknown, volume unknown."
            )
            answer = {
                "status": ResearchStatus.INSUFFICIENT_DATA.value,
                "facts": [],
                "interpretation": [],
                "stale_inputs": [
                    f"price is {age}s old",
                    "liquidity unknown",
                    "volume unknown",
                ],
            }

        tags = ["stale"] if answer["status"] == ResearchStatus.INSUFFICIENT_DATA.value else []
        examples.append(
            _example(index, Domain.MARKET_REASONING, chain, minute, user, answer, split, tags=tags)
        )

    return examples


def build_chain_knowledge(rng: random.Random, count: int) -> list[Example]:
    """Telling the four chains apart, and rejecting anything else."""
    facts = {
        "base": "Base is an OP-stack L2 with chain id 8453 and ETH for gas.",
        "bsc": "BNB Smart Chain has chain id 56 and BNB for gas; its pegged stablecoins use 18 decimals.",
        "robinhood": "Robinhood Chain is an Arbitrum Orbit L2 with chain id 4663 and ETH for gas.",
        "solana": "Solana is not EVM; it uses ed25519 keypairs, lamports, and rent-exempt accounts.",
    }

    examples: list[Example] = []
    unsupported = ["ethereum", "polygon", "arbitrum", "avalanche", "optimism"]

    for index in range(count):
        minute = 30_000 + index * 17
        split = _split_for(index)

        if index % 4 == 3:
            chain = unsupported[index % len(unsupported)]
            phrasing = ASK_UNSUPPORTED[(index // len(unsupported)) % len(ASK_UNSUPPORTED)]
            user = phrasing.format(chain=chain) + f" (request {index})"
            answer = {
                "status": ResearchStatus.INSUFFICIENT_DATA.value,
                "reason": (
                    f"ATRA supports only base, bsc, robinhood and solana. {chain} is not supported."
                ),
            }
            examples.append(
                _example(
                    index,
                    Domain.CHAIN_KNOWLEDGE,
                    None,
                    minute,
                    user,
                    answer,
                    split,
                    tags=["unsupported-chain", "refusal"],
                )
            )
        else:
            chain = CHAINS[index % 4]
            phrasing = ASK_CHAIN[(index // 4) % len(ASK_CHAIN)]
            user = phrasing.format(chain=chain) + f" (request {index})"
            answer = {
                "status": ResearchStatus.OK.value,
                "facts": [facts[chain]],
                "interpretation": [],
                "stale_inputs": [],
            }
            examples.append(
                _example(index, Domain.CHAIN_KNOWLEDGE, chain, minute, user, answer, split)
            )

    return examples


def build_lp(rng: random.Random, count: int) -> list[Example]:
    examples: list[Example] = []

    for index in range(count):
        chain = rng.choice(CHAINS)
        minute = 40_000 + index * 19
        split = _split_for(index)
        variant = index % 4

        if variant == 0:
            fees = 1 + (index % 4)
            user = (
                f"LP on {chain}, pool 0xlp{index}: position in range, unclaimed fees {fees} USD, "
                f"minimum claim threshold 5 USD, last rebalance {1 + index % 6} hours ago."
            )
            answer = {"action": LpAction.HOLD.value, "reason": "Fees are below the claim threshold and the position is in range."}
        elif variant == 1:
            hours = 1 + (index % 12)
            user = (
                f"LP on {chain}, pool 0xlp{index}: out of range for {hours} hours, rebalances "
                f"today {index % 3}, daily limit 4, pool liquidity {600_000 + index * 5_101} USD."
            )
            answer = {"action": LpAction.REBALANCE.value, "reason": "The position is out of range and the daily rebalance budget allows one."}
        elif variant == 2:
            claimable = 6 + (index % 40)
            user = (
                f"LP on {chain}, pool 0xlp{index}: unclaimed fees {claimable} USD, threshold "
                f"5 USD, gas estimate 0.4 USD, position in range."
            )
            answer = {"action": LpAction.COLLECT_FEES.value, "reason": "Fees exceed the threshold and the gas cost is small relative to them."}
        else:
            fallen = 1_000 + index * 307
            user = (
                f"LP on {chain}, pool 0xlp{index}: pool liquidity fell to {fallen} USD, "
                f"policy minimum 500000 USD."
            )
            answer = {"action": LpAction.EXIT.value, "reason": "Pool liquidity is below the policy minimum, so the position should be withdrawn."}

        examples.append(_example(index, Domain.LP_REASONING, chain, minute, user, answer, split))

    return examples


def build_all(seed: int, per_domain: int) -> list[Example]:
    rng = random.Random(seed)
    examples: list[Example] = []
    examples.extend(build_tool_use(rng, per_domain))
    examples.extend(build_trading(rng, per_domain))
    examples.extend(build_market_reasoning(rng, per_domain))
    examples.extend(build_chain_knowledge(rng, per_domain))
    examples.extend(build_lp(rng, per_domain))
    return examples


def write(examples: list[Example], out: Path) -> dict[str, int]:
    out.mkdir(parents=True, exist_ok=True)
    counts = {"train": 0, "validation": 0, "test": 0}

    for split in counts:
        path = out / f"{split}.jsonl"
        selected = [example for example in examples if example.split == split]
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            for example in sorted(selected, key=lambda item: item.id):
                handle.write(json.dumps(asdict(example), default=str, sort_keys=True) + "\n")
        counts[split] = len(selected)

    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the ATRA-4B dataset")
    parser.add_argument("--out", type=Path, default=Path("data/out"))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--per-domain", type=int, default=200)
    args = parser.parse_args()

    examples = build_all(args.seed, args.per_domain)
    counts = write(examples, args.out)

    print(f"wrote {sum(counts.values())} examples to {args.out}")
    for split, count in counts.items():
        print(f"  {split}: {count}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
