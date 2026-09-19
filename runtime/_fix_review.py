"""One-off: fixes for the verified adversarial-review findings. Deleted after use."""

from pathlib import Path


def patch(path: str, pairs: list[tuple[str, str]]) -> None:
    file = Path(path)
    source = file.read_text(encoding="utf-8")
    for old, new in pairs:
        if old not in source:
            raise SystemExit(f"{path}: pattern not found:\n{old[:200]}")
        source = source.replace(old, new, 1)
    file.write_text(source, encoding="utf-8")
    print(f"patched {path}")


# ---- money.ts: a non-positive price is not a price ---------------------------
patch("src/risk/money.ts", [(
    """  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new MoneyFormatError(`Unsupported token decimals: ${decimals}`);
  }
  const numerator = amount * priceAtto;""",
    """  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new MoneyFormatError(`Unsupported token decimals: ${decimals}`);
  }
  // A zero price is not a price: it is a provider saying "unknown" in the
  // shape of a number. Valuing anything at it makes every USD cap pass
  // trivially, so it is refused here as defence in depth; the engine treats a
  // zero price as missing data long before reaching this point.
  if (priceAtto <= 0n) {
    throw new MoneyFormatError('Cannot value an amount at a non-positive price');
  }
  const numerator = amount * priceAtto;""",
)])

# ---- types.ts: reduceOnly only on swap; lp_* refused in this build -----------
patch("src/risk/types.ts", [(
    """    if (action.kind === 'approve') {
      if (action.quote !== null) {""",
    """    // Exit privileges (skipping the exposure caps) belong to swaps only. An
    // approve or LP action flagged reduceOnly would inherit them for nothing.
    if (action.reduceOnly && action.kind !== 'swap') {
      ctx.addIssue({
        code: 'custom',
        path: ['reduceOnly'],
        message: `${action.kind} cannot be reduce-only`,
      });
    }

    // LP execution is Phase 4. Until its checks exist the engine must refuse
    // these kinds outright rather than evaluate them as swaps — which is what
    // happened before this guard: an lp_add against a policy with LP disabled
    // was approved using the swap checks.
    if (action.kind.startsWith('lp_')) {
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: 'lp actions are not enabled in this build',
      });
    }

    if (action.kind === 'approve') {
      if (action.quote !== null) {""",
)])

# ---- engine.ts ---------------------------------------------------------------
patch("src/risk/engine.ts", [
    (
        "  const isExit = action.reduceOnly;",
        """  // Defence in depth: the schema already refuses reduceOnly on anything but a
  // swap, so this can only differ from action.reduceOnly if the schema is
  // loosened later.
  const isExit = action.reduceOnly && action.kind === 'swap';""",
    ),
    (
        """  ctx.check(
    freshnessCheck('freshness.price.tokenIn', priceIn, now, policy.freshness.priceMaxAgeMs, skew),
  );""",
        """  ctx.check(
    priceCheck('freshness.price.tokenIn', priceIn, now, policy.freshness.priceMaxAgeMs, skew),
  );""",
    ),
    (
        """    ctx.check(
      freshnessCheck(
        'freshness.price.tokenOut',
        priceOut,
        now,
        policy.freshness.priceMaxAgeMs,
        skew,
      ),
    );""",
        """    ctx.check(
      priceCheck('freshness.price.tokenOut', priceOut, now, policy.freshness.priceMaxAgeMs, skew),
    );""",
    ),
    (
        """  ctx.check(
    freshnessCheck('freshness.price.native', priceNative, now, policy.freshness.priceMaxAgeMs, skew),
  );""",
        """  ctx.check(
    priceCheck('freshness.price.native', priceNative, now, policy.freshness.priceMaxAgeMs, skew),
  );""",
    ),
    (
        """  const amountIn = amountToBigint(action.amountIn);
  const amountInUsd = priceIn
    ? nativeToUsdMicros(amountIn, action.tokenIn.decimals, priceToAtto(priceIn.value), 'ceil')
    : undefined;

  const feeNative = feeInNativeUnits(action.feeEstimate.detail);
  const feeUsd = priceNative
    ? nativeToUsdMicros(feeNative, nativeToken.decimals, priceToAtto(priceNative.value), 'ceil')
    : undefined;""",
        """  const amountIn = amountToBigint(action.amountIn);
  // A price parses to undefined when absent, malformed or zero; all mean
  // "unknown", and everything valued at it is reported as not-evaluated and
  // fails.
  const priceInAtto = usablePrice(priceIn);
  const priceNativeAtto = usablePrice(priceNative);

  const amountInUsd =
    priceInAtto === undefined
      ? undefined
      : nativeToUsdMicros(amountIn, action.tokenIn.decimals, priceInAtto, 'ceil');

  const feeNative = feeInNativeUnits(action.feeEstimate.detail);
  const feeUsd =
    priceNativeAtto === undefined
      ? undefined
      : nativeToUsdMicros(feeNative, nativeToken.decimals, priceNativeAtto, 'ceil');""",
    ),
    (
        """  const protocols = policy.protocolAllowlist[chain] ?? {};
  const protocolEntry = protocols[action.protocol];""",
        """  const protocols = policy.protocolAllowlist[chain] ?? {};
  // Own-property lookup: a protocol named "constructor" or "toString" must not
  // resolve through Object.prototype into something that is not an entry.
  const protocolEntry = Object.hasOwn(protocols, action.protocol)
    ? protocols[action.protocol]
    : undefined;""",
    ),
    (
        """  if (action.chain === 'solana') {
    const permitted = new Set([...entry.contracts, ...SOLANA_SYSTEM_PROGRAMS]);
    const offending = (action.programIds ?? []).find((id) => !permitted.has(id));
    if (offending) {""",
        """  if (action.chain === 'solana') {
    const programIds = action.programIds ?? [];

    // The declared contract must actually be invoked. An empty list, or one
    // that omits the router, describes a transaction other than the one being
    // checked.
    if (!programIds.includes(action.contract)) {
      return {
        name: 'allowlist.contract',
        code: 'CONTRACT_UNKNOWN',
        passed: false,
        observed: action.contract,
        limit: 'n/a',
        detail: 'declared program is not among the transaction top-level programs',
      };
    }

    const permitted = new Set([...entry.contracts, ...SOLANA_SYSTEM_PROGRAMS]);
    const offending = programIds.find((id) => !permitted.has(id));
    if (offending) {""",
    ),
    (
        """function freshnessCheck(
  name: string,""",
        """/**
 * A freshness check that also refuses a zero price.
 *
 * A provider reporting "0" is saying "unknown" in the shape of a number. If
 * it were accepted, every USD-denominated limit would compare against zero and
 * pass, so a zero is treated exactly like a missing datum.
 */
function priceCheck(
  name: string,
  stamped: Stamped<string> | undefined,
  now: number,
  maxAgeMs: number,
  skewMs: number,
): RiskCheck {
  const fresh = freshnessCheck(name, stamped, now, maxAgeMs, skewMs);
  if (!fresh.passed || !stamped) return fresh;

  if (usablePrice(stamped) === undefined) {
    return {
      name,
      code: 'DATA_STALE',
      passed: false,
      observed: 'zero',
      limit: String(maxAgeMs),
      detail: 'provider reported a zero or unparseable price; treated as unknown',
    };
  }

  return fresh;
}

/** The parsed price, or undefined when it is absent, malformed or zero. */
function usablePrice(stamped: Stamped<string> | undefined): bigint | undefined {
  if (!stamped) return undefined;
  try {
    const atto = priceToAtto(stamped.value);
    return atto > 0n ? atto : undefined;
  } catch {
    return undefined;
  }
}

function freshnessCheck(
  name: string,""",
    ),
])

# ---- providers: a zero price is null with a reason ---------------------------
patch("src/market/providers/dexscreener.ts", [
    (
        """/** Keep provider decimals as a string; never parse a price into a float. */
function normalizeDecimal(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return /^\\d+(\\.\\d+)?$/.test(value) ? value : null;
}""",
        """/**
 * Keep provider decimals as a string; never parse a price into a float.
 *
 * A zero is rejected along with malformed values: a provider reporting "0"
 * means it has no price, and passing that through as a number would let it
 * satisfy every downstream comparison.
 */
function normalizeDecimal(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!/^\\d+(\\.\\d+)?$/.test(value)) return null;
  return /[1-9]/.test(value) ? value : null;
}""",
    ),
    (
        """  const observedAt = fetchedAt;

  return {
    chain,
    poolId: pair.pairAddress,
    dexId: pair.dexId ?? null,
    base: toTokenRef(pair.baseToken),
    quote: toTokenRef(pair.quoteToken),
    priceUsd: normalizeDecimal(pair.priceUsd),""",
        """  const observedAt = fetchedAt;
  const priceUsd = normalizeDecimal(pair.priceUsd);

  return {
    chain,
    poolId: pair.pairAddress,
    dexId: pair.dexId ?? null,
    base: toTokenRef(pair.baseToken),
    quote: toTokenRef(pair.quoteToken),
    priceUsd,""",
    ),
    (
        """    ...(pair.priceUsd ? {} : { reason: 'provider returned no USD price for this pair' }),""",
        """    ...(priceUsd === null ? { reason: 'provider returned no usable USD price for this pair' } : {}),""",
    ),
])

patch("src/market/providers/geckoterminal.ts", [
    (
        """function decimalOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  // Scientific notation and negatives are rejected rather than coerced: a price
  // ATRA cannot parse exactly is a price it should not use.
  return /^\\d+(\\.\\d+)?$/.test(value) ? value : null;
}""",
        """function decimalOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  // Scientific notation, negatives and zero are rejected rather than coerced: a
  // price ATRA cannot parse exactly, or that is not a price at all, is one it
  // must not use.
  if (!/^\\d+(\\.\\d+)?$/.test(value)) return null;
  return /[1-9]/.test(value) ? value : null;
}""",
    ),
    (
        """  const [baseSymbol, quoteSymbol] = splitPairName(attributes.name);

  return {""",
        """  const [baseSymbol, quoteSymbol] = splitPairName(attributes.name);
  const priceUsd = decimalOrNull(attributes.base_token_price_usd);

  return {""",
    ),
    (
        """    priceUsd: decimalOrNull(attributes.base_token_price_usd),""",
        """    priceUsd,""",
    ),
    (
        """    ...(attributes.base_token_price_usd ? {} : { reason: 'provider returned no USD price' }),""",
        """    ...(priceUsd === null ? { reason: 'provider returned no usable USD price' } : {}),""",
    ),
    (
        """function percentStringToBps(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}""",
        """function percentStringToBps(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  // Number('') is 0 and Number('0x10') is 16; neither is a percentage. Only a
  // plain signed decimal is accepted.
  if (!/^-?\\d+(\\.\\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}""",
    ),
])

print("done")
