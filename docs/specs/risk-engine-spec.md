# ATRA Risk Engine Specification (Phases 1–3, with Phase 4 LP fields)

| Field | Value |
|---|---|
| Spec ID | `risk-engine-spec` |
| Version | 1.0.0 (2026-09-19) |
| Status | DRAFT — ready to implement |
| Owner | `runtime/` (TypeScript backend, `C:\ATRA\runtime`) |
| Depends on | ledger spec (position/PnL bookkeeping), adapter spec (RPC/DEX quotes), vault spec (signing), gateway spec (Telegram `/stop`) — all referenced, none required to read this |
| Verification date | 2026-09-19 (every address, chain ID and endpoint below was checked live on that date unless marked UNVERIFIED) |

The risk engine is a **pure, deterministic, LLM-free** function that decides whether a proposed on-chain action may proceed. It is the only thing standing between the LLM and the signer, so it is written to be boring: bigint arithmetic only, no I/O, no clocks, no randomness, fail-closed on anything unexpected.

Non-negotiable invariants (restated from the project charter):

1. Four chains only: `base`, `bsc`, `robinhood`, `solana`. Anything else is `SCHEMA_INVALID`.
2. `PAPER` is the default mode. `LIVE` is never entered automatically.
3. The LLM never signs and never talks to the engine directly with authority: its output is parsed into a `ProposedAction` by deterministic code, and every USD figure the engine uses is **recomputed by the engine** from the market snapshot. Numbers inside the proposal are hints at best.
4. Private keys never leave the local vault; the engine never sees them (it sees addresses only).
5. Never fabricate data: missing data is `DATA_STALE`, never a default value.

---

## 1. Scope

In scope (Phases 1–3):

- `RiskPolicy` schema, safe defaults, validation (single-field + cross-field) and normalization.
- `ProposedAction`, `RuntimeState`, `MarketSnapshot` input shapes.
- `RiskDecision` output shape with per-check evidence.
- Ordered check pipeline with rejection codes.
- Semantics: daily-loss window, cooldowns, freshness, `PAPER` vs `LIVE`, reduce-only exits, idempotency.
- The stateful `RiskGate` wrapper (idempotency store, cooldown bookkeeping, persistence).
- `LIVE` activation state machine.
- Emergency stop and global pause semantics.
- Test matrix (58 engine cases + 9 validation cases + 8 activation cases + 6 emergency-stop cases + helper vectors).

Out of scope here (other specs): how the ledger computes PnL, how adapters build transactions, how the vault signs, the dashboard UI. Phase 4 LP **fields** and their validation are specified now so the policy file does not need a breaking change later; the LP **checks** are outlined in §12 and marked Phase 4.

---

## 2. Verified constants

All values below were checked on 2026-09-19 with the methods stated. They are the seed for the default allowlists. Anything not listed here must be added by the operator through the policy editor and is untrusted until then.

### 2.1 Chains

| `ChainId` | Network | EVM chain ID | Identity check | Native token | Native decimals | Public RPC used for verification | Explorer |
|---|---|---|---|---|---|---|---|
| `base` | Base mainnet | `8453` (`0x2105`) | `eth_chainId` returned `0x2105` | ETH | 18 | `https://mainnet.base.org` | https://basescan.org |
| `bsc` | BNB Smart Chain mainnet | `56` (`0x38`) | `eth_chainId` returned `0x38` | BNB | 18 | `https://bsc-dataseed.bnbchain.org` | https://bscscan.com |
| `robinhood` | Robinhood Chain mainnet (Arbitrum Orbit/Nitro L2 on Ethereum) | `4663` (`0x1237`) | `eth_chainId` returned `0x1237` | ETH | 18 | `https://rpc.mainnet.chain.robinhood.com` (rate-limited public; docs recommend Alchemy for production) | https://robinhoodchain.blockscout.com |
| `solana` | Solana mainnet-beta | n/a | `getGenesisHash` returned `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | SOL | 9 | `https://api.mainnet-beta.solana.com` | https://solscan.io |

Robinhood Chain testnet is chain ID `46630`; it is **not** a supported `ChainId` in ATRA v1 (the engine has no testnet mode; PAPER mode is the sandbox).

Live gas prices observed on 2026-09-19 (for sizing defaults only, not constants): Base `eth_gasPrice` = `0x5b8d80` (0.006 gwei), BSC = `0x2faf080` (0.05 gwei), Robinhood = `0x3d458c0` (0.06425 gwei). Solana `getMinimumBalanceForRentExemption(165)` = **1,488,440 lamports** (this is lower than the historical 2,039,280; adapters must query it, never hard-code it).

### 2.2 Native-token sentinel IDs

| Chain family | Native token `id` used in policy/actions | Notes |
|---|---|---|
| EVM (`base`, `bsc`, `robinhood`) | `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` | Lowercase, 18 decimals. Balance lookups for this id read the account balance (`eth_getBalance`). |
| Solana | `So11111111111111111111111111111111111111112` | The wSOL mint. Balance lookups for this id read lamports (`getBalance`), not the wSOL token account. Jupiter wraps/unwraps automatically. |

### 2.3 Default token allowlist (verified via `eth_call symbol()/decimals()` or on-chain registry)

| Chain | Symbol | Address / mint (canonical form stored in policy) | Decimals | Verification |
|---|---|---|---|---|
| base | USDC | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` | 6 | `symbol()`=USDC, `decimals()`=6 via mainnet.base.org |
| base | WETH | `0x4200000000000000000000000000000000000006` | 18 | `symbol()`=WETH, `decimals()`=18 |
| base | ETH (native) | `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` | 18 | sentinel |
| bsc | USDT | `0x55d398326f99059ff775485246999027b3197955` | 18 | `symbol()`=USDT, `decimals()`=18 (BSC-pegged USDT has 18 decimals, not 6) |
| bsc | USDC | `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d` | 18 | `symbol()`=USDC, `decimals()`=18 |
| bsc | WBNB | `0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c` | 18 | `symbol()`=WBNB, `decimals()`=18 |
| bsc | BNB (native) | `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` | 18 | sentinel |
| robinhood | WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` | 18 | `symbol()`=WETH, `decimals()`=18; matches docs.robinhood.com "L2 Weth" |
| robinhood | USDG | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` | 6 | `symbol()`=USDG, `decimals()`=6; listed on docs.robinhood.com/chain/contracts |
| robinhood | ETH (native) | `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` | 18 | sentinel |
| solana | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 | Circle-issued USDC mint (well-known; Jupiter quote above resolved it) |
| solana | SOL (native) | `So11111111111111111111111111111111111111112` | 9 | sentinel / wSOL mint |

Note: `0x4200000000000000000000000000000000000006` is **not** WETH on Robinhood Chain (`eth_call` returned empty); do not copy Base/OP-stack addresses onto Orbit chains. Native USDC on Robinhood Chain: UNVERIFIED (not listed on the docs contracts page on 2026-09-19); not in defaults.

### 2.4 Default protocol allowlist (verified `eth_getCode` non-empty / program executable)

| Chain | Protocol key | Contract ID(s) | Role | Verification |
|---|---|---|---|---|
| base | `uniswap-v4` | `0x6ff5693b99212da76ad316178a184ab56d299b43` | Universal Router | code 19,499 bytes; listed at developers.uniswap.org v4 deployments |
| base | `uniswap-v4` | `0x000000000022d473030f116ddee9f6b43ac78ba3` | Permit2 (approve spender) | code 9,152 bytes |
| base | `aerodrome-v2` | `0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43` | Aerodrome Router | code 23,581 bytes; BaseScan-verified "Aerodrome: Router" |
| bsc | `pancakeswap-v3` | `0x13f4ea83d0bd40e75c8222255bc855a974568dd4` | SmartRouter (v3) | code 24,316 bytes; developer.pancakeswap.finance |
| bsc | `pancakeswap-v2` | `0x10ed43c718714eb63d5aa57b78b54704e256024e` | PancakeRouter v2 | code 21,936 bytes |
| bsc | `uniswap-v4` | `0x1906c1d672b88cd1b9ac7593301ca990f94eae07` | Universal Router | code 19,499 bytes; Uniswap v4 deployments page |
| bsc | `uniswap-v4` | `0x000000000022d473030f116ddee9f6b43ac78ba3` | Permit2 | same bytecode family |
| robinhood | `uniswap-v4` | `0x8876789976decbfcbbbe364623c63652db8c0904` | Universal Router | code 24,546 bytes; Uniswap v4 deployments page lists Robinhood Chain (4663) |
| robinhood | `uniswap-v4` | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | V4Quoter (read-only, allowed as `eth_call` target) | code 6,118 bytes |
| robinhood | `uniswap-v4` | `0x000000000022d473030f116ddee9f6b43ac78ba3` | Permit2 | code present on chain 4663 |
| solana | `jupiter-v6` | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | Jupiter Aggregator v6 program | `getAccountInfo` executable=true, owner BPFLoaderUpgradeab1e |

Solana **infrastructure programs** that may appear in a Jupiter transaction alongside the allowlisted program (constant `SOLANA_SYSTEM_PROGRAMS`, not user-editable):

```
11111111111111111111111111111111             System Program
TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA  SPL Token
TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb  SPL Token-2022
ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL  Associated Token Account
ComputeBudget111111111111111111111111111111  Compute Budget
AddressLookupTab1e1111111111111111111111111  Address Lookup Table
```

Any other program ID in the built transaction → `CONTRACT_UNKNOWN`. (Jupiter routes through DEX programs via CPI; those inner programs are not visible as top-level instructions and are not checked in v1. UNVERIFIED whether Jupiter's `/swap-instructions` can emit top-level instructions to other programs, e.g. for token-ledger routes; if it does, the adapter must reject them before the engine sees them.)

### 2.5 Data sources the defaults assume (keyless)

| Purpose | Endpoint | Auth | Observed on 2026-09-19 |
|---|---|---|---|
| Solana quote | `GET https://lite-api.jup.ag/swap/v1/quote?inputMint=&outputMint=&amount=&slippageBps=` | none (free tier; `api.jup.ag` needs a key) | Returned `inAmount`, `outAmount`, `otherAmountThreshold`, `slippageBps`, `priceImpactPct` (decimal string), `contextSlot` |
| Pool liquidity / price (all four chains) | `GET https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}` | none; 300 req/min | Returned pairs with `liquidity.usd`, `priceUsd`, `dexId`, `pairAddress` for `base/0x8335…` |
| EVM quotes | Uniswap V4Quoter / PancakeSwap QuoterV2 via `eth_call` on public RPC | none | out of scope here (adapter spec) |

DexScreener's chain slug for Robinhood Chain: UNVERIFIED (not tested). If absent, Robinhood liquidity must come from the Uniswap v4 PoolManager state via RPC, or the chain stays PAPER-only.

---

## 3. Units and money math

All arithmetic in the engine is `bigint`. No `number` ever holds money. No `Math.*`, no `parseFloat`, no `toFixed`.

### 3.1 Wire types

| Type | TypeScript | Regex / rule | Example |
|---|---|---|---|
| `UsdString` | `string` | `^-?(0|[1-9]\d*)(\.\d{1,6})?$`; at most 6 fractional digits (micro-USD). Canonical output form always has exactly 6 fractional digits. Non-negative unless the field is documented as signed. | `"25"`, `"25.000000"`, `"-3.5"` (signed fields only) |
| `PriceString` | `string` | `^(0|[1-9]\d*)(\.\d{1,18})?$` (atto-USD precision so sub-cent tokens keep precision) | `"2500.123456"`, `"0.0000123456"` |
| `AmountString` | `string` | `^(0|[1-9]\d*)$`; base units (wei, lamports, token base units); decimals come from the token registry, never from the amount | `"10000000"` (10 USDC) |
| `Bps` | `number` | integer `0..10000` | `50` = 0.50 % |
| `EpochMs` | `number` | integer, `0 <= x <= 2^53-1`, UTC milliseconds | `1789828200000` |
| `EvmAddress` | `string` | `^0x[0-9a-f]{40}$` — **lowercase only** | `0x8335…2913` |
| `SolanaPubkey` | `string` | `^[1-9A-HJ-NP-Za-km-z]{32,44}$` and base58-decodes to exactly 32 bytes | `EPjF…Dt1v` |
| `Sha256Hex` | `string` | `^[0-9a-f]{64}$` | |

### 3.2 Scales

```ts
export const USD_SCALE   = 1_000_000n;              // micro-USD
export const PRICE_SCALE = 1_000_000_000_000_000_000n; // atto-USD (1e18)
export const BPS_DENOM   = 10_000n;
```

### 3.3 Helpers (reference implementation, `runtime/src/risk/money.ts`)

```ts
const USD_RE   = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;
const PRICE_RE = /^(0|[1-9]\d*)(?:\.(\d{1,18}))?$/;
const AMT_RE   = /^(0|[1-9]\d*)$/;

export function usdToMicros(s: string): bigint {
  const m = USD_RE.exec(s); if (!m) throw new RiskSchemaError(`bad UsdString ${s}`);
  const [, sign, ip, fp = ''] = m;
  const v = BigInt(ip) * USD_SCALE + BigInt(fp.padEnd(6, '0'));
  return sign ? -v : v;
}
export function microsToUsd(m: bigint): string {            // canonical: exactly 6 decimals
  const neg = m < 0n; const a = neg ? -m : m;
  const ip = a / USD_SCALE, fp = (a % USD_SCALE).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${ip}.${fp}`;
}
export function priceToAtto(s: string): bigint {
  const m = PRICE_RE.exec(s); if (!m) throw new RiskSchemaError(`bad PriceString ${s}`);
  return BigInt(m[1]) * PRICE_SCALE + BigInt((m[2] ?? '').padEnd(18, '0'));
}
export function amountToBigint(s: string): bigint {
  if (!AMT_RE.test(s)) throw new RiskSchemaError(`bad AmountString ${s}`); return BigInt(s);
}
export const ceilDiv  = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;   // a,b >= 0
export const floorDiv = (a: bigint, b: bigint): bigint => a / b;

/** native base units × price → micro-USD. `rounding` follows §3.4. */
export function nativeToUsdMicros(amount: bigint, decimals: number, priceAtto: bigint, rounding: 'ceil'|'floor'): bigint {
  const num = amount * priceAtto;
  const den = 10n ** BigInt(decimals) * (PRICE_SCALE / USD_SCALE); // 10^decimals × 10^12
  return rounding === 'ceil' ? ceilDiv(num, den) : floorDiv(num, den);
}
/** slippage implied by expected vs minimum output, in bps, rounded UP. */
export function impliedSlippageBps(expectedOut: bigint, minOut: bigint): bigint {
  if (expectedOut <= 0n || minOut > expectedOut) throw new RiskSchemaError('bad quote');
  return ceilDiv((expectedOut - minOut) * BPS_DENOM, expectedOut);
}
```

### 3.4 Rounding rule: "round against the trade"

| Quantity | Rounding | Why |
|---|---|---|
| USD value of what leaves the wallet (`amountInUsd`, approve amount, LP capital) | ceil | Larger observed → more likely to breach a max |
| Fee in USD | ceil | same |
| Implied slippage bps, price impact bps | ceil | same |
| Observed liquidity USD, wallet balances in USD, funded USD (activation) | floor | Smaller observed → more likely to breach a min |
| Daily loss (a positive number meaning "lost") | ceil | same |

### 3.5 Helper test vectors (must pass byte-for-byte)

| Function | Input | Expected |
|---|---|---|
| `usdToMicros` | `"25"` | `25000000n` |
| `usdToMicros` | `"25.00"` | `25000000n` |
| `usdToMicros` | `"0.000001"` | `1n` |
| `usdToMicros` | `"-3.5"` | `-3500000n` |
| `usdToMicros` | `"12.3456789"` (7 decimals) | throws `RiskSchemaError` |
| `usdToMicros` | `"1e6"`, `"+5"`, `" 5"`, `"5."`, `".5"`, `"05"` | throws |
| `microsToUsd` | `25000000n` | `"25.000000"` |
| `microsToUsd` | `-1n` | `"-0.000001"` |
| `nativeToUsdMicros` | `10_000_000n`, 6, `priceToAtto("1.000027")`, ceil | `10000270n` (USD 10.000270) |
| `nativeToUsdMicros` | `5_000_000_000_000_000n` (0.005 WETH), 18, `priceToAtto("2500.123456")`, ceil | `12500618n` |
| `nativeToUsdMicros` | same, floor | `12500617n` |
| `nativeToUsdMicros` | `12_345_678_900_000_000n`, 18, `"2500.123456"`, ceil / floor | `30865722n` / `30865721n` |
| `nativeToUsdMicros` | `1_000_000_000n` (1 SOL), 9, `"111.790298"`, ceil | `111790298n` |
| `nativeToUsdMicros` | `1_000_000_000n`, 5 (a 5-decimal token), `"0.0000123456"`, ceil | `123456n` |
| `nativeToUsdMicros` | `2_500_000_000_000n` wei (250000 gas × 0.01 gwei), 18, `"2500.123456"`, ceil | `6251n` (USD 0.006251) |
| `nativeToUsdMicros` | `200_000_000_000_000n` wei (200000 gas × 1 gwei), 18, `"600.5"`, ceil | `120100n` |
| `nativeToUsdMicros` | `105_000n` lamports, 9, `"111.790298"`, ceil | `11738n` |
| `impliedSlippageBps` | `111790298n`, `111231347n` (live Jupiter quote, 2026-09-19) | `50n` (floor would give 49 — the ceil matters) |
| `impliedSlippageBps` | `1000000n`, `995000n` | `50n` |
| `impliedSlippageBps` | `1000000n`, `994999n` | `51n` |
| `impliedSlippageBps` | `3999800000000000n`, `3987800600000000n` | `30n` |

---

## 4. `RiskPolicy`

### 4.1 TypeScript shape

```ts
export type ChainId = 'base' | 'bsc' | 'robinhood' | 'solana';
export const CHAIN_IDS = ['base', 'bsc', 'robinhood', 'solana'] as const;

export interface TokenAllowEntry {
  address: string;        // EvmAddress (lowercase) or SolanaPubkey; native sentinel allowed
  symbol: string;         // ^[A-Za-z0-9.$_-]{1,16}$ — display only, never used for matching
  decimals: number;       // 0..18 EVM, 0..9 Solana; authoritative for the engine
}

export interface ProtocolAllowEntry {
  contracts: string[];    // router/program IDs the tx may target (EvmAddress lowercase | SolanaPubkey)
  approveSpenders?: string[]; // EVM only; subset of `contracts` allowed as ERC-20 approve spender (default: [] = approvals forbidden)
}

export interface RiskPolicy {
  schemaVersion: 1;
  enabledChains: ChainId[];                 // non-empty; chain absent here → CHAIN_UNSUPPORTED

  // --- sizing / loss (USD) ---
  maxAmountPerTradeUsd: string;             // UsdString > 0
  maxDailyLossUsd: string;                  // UsdString > 0
  maxTotalDeployedUsd: string;              // UsdString > 0
  maxTransactionFeeUsd: string;             // UsdString > 0
  minLiquidityUsd: string;                  // UsdString >= 0

  // --- execution quality ---
  maxSlippageBps: number;                   // 1..1000
  maxPriceImpactBps: number;                // 1..2000

  // --- pacing ---
  cooldownSeconds: number;                  // 0..86400, per market (see §8.2)
  globalMinIntervalSeconds: number;         // 0..3600, between ANY two actions

  // --- data freshness (ms) ---
  freshness: {
    priceMaxAgeMs: number;                  // 1000..3600000
    quoteMaxAgeMs: number;                  // 1000..600000
    balanceMaxAgeMs: number;                // 1000..3600000
    liquidityMaxAgeMs: number;              // 1000..86400000
    feeEstimateMaxAgeMs: number;            // 1000..600000
    actionMaxAgeMs: number;                 // 1000..600000 (age of the proposal itself)
    maxClockSkewMs: number;                 // 0..60000 (timestamps in the future beyond this → stale)
  };

  dailyLoss: { includeUnrealized: boolean };   // §8.1

  // --- allowlists ---
  tokenAllowlist: Partial<Record<ChainId, TokenAllowEntry[]>>;
  protocolAllowlist: Partial<Record<ChainId, Record<string, ProtocolAllowEntry>>>; // key: ^[a-z0-9-]{2,32}$

  // --- switches ---
  globalPause: boolean;
  emergencyStop: boolean;                   // policy-file hard stop; OR-ed with the runtime flag (§11)

  // --- Phase 4 LP (validated now, enforced in Phase 4) ---
  lp: {
    maxCapitalPerLpUsd: string;             // UsdString >= 0 ("0" = LP disabled)
    allowedPools: Array<{ chain: ChainId; protocol: string; poolId: string }>; // empty = LP disabled
    allowedProtocols: Partial<Record<ChainId, string[]>>;                       // protocol keys
    minPoolLiquidityUsd: string;
    maxRebalancePerDay: number;             // 0..48
    maxRebalanceSlippageBps: number;        // 1..500
    maxLpGasUsd: string;
    minFeeThresholdUsd: string;
  };
}
```

### 4.2 Safe defaults for a fresh install (`runtime/src/risk/defaults.ts`, also shipped as `docs/specs/fixtures/risk-policy.default.json`)

Conservative on purpose: a bug that slips through costs at most `maxDailyLossUsd` per UTC day and `maxTotalDeployedUsd` in total. PAPER mode uses the same numbers so paper results are representative.

```json
{
  "schemaVersion": 1,
  "enabledChains": ["base", "bsc", "robinhood", "solana"],

  "maxAmountPerTradeUsd": "25.000000",
  "maxDailyLossUsd": "20.000000",
  "maxTotalDeployedUsd": "100.000000",
  "maxTransactionFeeUsd": "1.000000",
  "minLiquidityUsd": "250000.000000",

  "maxSlippageBps": 50,
  "maxPriceImpactBps": 100,

  "cooldownSeconds": 300,
  "globalMinIntervalSeconds": 30,

  "freshness": {
    "priceMaxAgeMs": 60000,
    "quoteMaxAgeMs": 20000,
    "balanceMaxAgeMs": 60000,
    "liquidityMaxAgeMs": 300000,
    "feeEstimateMaxAgeMs": 30000,
    "actionMaxAgeMs": 60000,
    "maxClockSkewMs": 5000
  },

  "dailyLoss": { "includeUnrealized": true },

  "tokenAllowlist": {
    "base": [
      { "address": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "symbol": "ETH",  "decimals": 18 },
      { "address": "0x4200000000000000000000000000000000000006", "symbol": "WETH", "decimals": 18 },
      { "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "symbol": "USDC", "decimals": 6 }
    ],
    "bsc": [
      { "address": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "symbol": "BNB",  "decimals": 18 },
      { "address": "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", "symbol": "WBNB", "decimals": 18 },
      { "address": "0x55d398326f99059ff775485246999027b3197955", "symbol": "USDT", "decimals": 18 },
      { "address": "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "symbol": "USDC", "decimals": 18 }
    ],
    "robinhood": [
      { "address": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "symbol": "ETH",  "decimals": 18 },
      { "address": "0x0bd7d308f8e1639fab988df18a8011f41eacad73", "symbol": "WETH", "decimals": 18 },
      { "address": "0x5fc5360d0400a0fd4f2af552add042d716f1d168", "symbol": "USDG", "decimals": 6 }
    ],
    "solana": [
      { "address": "So11111111111111111111111111111111111111112", "symbol": "SOL",  "decimals": 9 },
      { "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "symbol": "USDC", "decimals": 6 }
    ]
  },

  "protocolAllowlist": {
    "base": {
      "uniswap-v4":   { "contracts": ["0x6ff5693b99212da76ad316178a184ab56d299b43", "0x000000000022d473030f116ddee9f6b43ac78ba3"],
                        "approveSpenders": ["0x000000000022d473030f116ddee9f6b43ac78ba3"] },
      "aerodrome-v2": { "contracts": ["0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43"],
                        "approveSpenders": ["0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43"] }
    },
    "bsc": {
      "pancakeswap-v3": { "contracts": ["0x13f4ea83d0bd40e75c8222255bc855a974568dd4"],
                          "approveSpenders": ["0x13f4ea83d0bd40e75c8222255bc855a974568dd4"] },
      "uniswap-v4":     { "contracts": ["0x1906c1d672b88cd1b9ac7593301ca990f94eae07", "0x000000000022d473030f116ddee9f6b43ac78ba3"],
                          "approveSpenders": ["0x000000000022d473030f116ddee9f6b43ac78ba3"] }
    },
    "robinhood": {
      "uniswap-v4": { "contracts": ["0x8876789976decbfcbbbe364623c63652db8c0904", "0x000000000022d473030f116ddee9f6b43ac78ba3"],
                      "approveSpenders": ["0x000000000022d473030f116ddee9f6b43ac78ba3"] }
    },
    "solana": {
      "jupiter-v6": { "contracts": ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"] }
    }
  },

  "globalPause": false,
  "emergencyStop": false,

  "lp": {
    "maxCapitalPerLpUsd": "0.000000",
    "allowedPools": [],
    "allowedProtocols": {},
    "minPoolLiquidityUsd": "1000000.000000",
    "maxRebalancePerDay": 2,
    "maxRebalanceSlippageBps": 30,
    "maxLpGasUsd": "0.500000",
    "minFeeThresholdUsd": "1.000000"
  }
}
```

Why these numbers: with `maxAmountPerTradeUsd` 25 and `minLiquidityUsd` 250,000 the default trade is ≤ 0.01 % of pool liquidity; `maxTransactionFeeUsd` 1.00 is roughly 100× the observed Base/BSC/Robinhood swap cost (≈ $0.006–0.12 at the 2026-09-19 gas prices in §2.1) and blocks trading during fee spikes; `maxDailyLossUsd` 20 < `maxAmountPerTradeUsd` so a single fully-lost position also stops the day. LP is disabled (`maxCapitalPerLpUsd` "0", empty pools) until Phase 4 ships. PancakeSwap v2 is verified but omitted from defaults (v3 SmartRouter routes v2 pools too).

### 4.3 Validation rules

Validation is `validatePolicy(input: unknown): { ok: true, policy: RiskPolicy, hash: Sha256Hex } | { ok: false, errors: PolicyError[] }` with `PolicyError = { path: string; rule: string; message: string }`. All errors are collected (no early exit). A policy that fails validation is **never loaded**: the engine keeps the last valid policy in memory and rejects every action with `SCHEMA_INVALID` / reason `policy invalid` if no valid policy exists at all (fail closed). Unknown keys are errors (`z.strictObject`), so a typo cannot silently disable a limit.

Normalization (`normalizePolicy`) is a separate step applied by the API layer **before** validation: it lowercases EVM addresses, trims strings, canonicalizes `UsdString` to 6 decimals, sorts allowlist arrays by address, and de-duplicates. The validator itself rejects non-lowercase EVM addresses so that a policy file edited by hand fails loudly instead of being silently rewritten.

| # | Rule ID | Field(s) | Rule |
|---|---|---|---|
| V01 | `schemaVersion` | `schemaVersion` | must be literal `1` |
| V02 | `chains.nonEmpty` | `enabledChains` | array of unique `ChainId`, length 1..4 |
| V03 | `usd.format` | every `UsdString` field | matches `UsdString` regex; no sign allowed on policy fields |
| V04 | `usd.positive` | `maxAmountPerTradeUsd`, `maxDailyLossUsd`, `maxTotalDeployedUsd`, `maxTransactionFeeUsd` | `> 0` |
| V05 | `usd.ceiling` | every `UsdString` field | `<= 1000000000.000000` (1e9) — sanity cap against typos |
| V06 | `trade.leDeployed` | `maxAmountPerTradeUsd`, `maxTotalDeployedUsd` | `maxAmountPerTradeUsd <= maxTotalDeployedUsd` |
| V07 | `fee.ltTrade` | `maxTransactionFeeUsd`, `maxAmountPerTradeUsd` | `maxTransactionFeeUsd < maxAmountPerTradeUsd` |
| V08 | `dailyLoss.geFee` | `maxDailyLossUsd`, `maxTransactionFeeUsd` | `maxDailyLossUsd >= maxTransactionFeeUsd` (otherwise no action could ever pass the worst-case daily-loss check) |
| V09 | `liquidity.ratio` | `minLiquidityUsd`, `maxAmountPerTradeUsd` | `minLiquidityUsd >= 100 × maxAmountPerTradeUsd` (a single trade is at most 1 % of pool liquidity) |
| V10 | `bps.slippage` | `maxSlippageBps` | integer `1..1000` |
| V11 | `bps.impact` | `maxPriceImpactBps` | integer `1..2000` and `>= maxSlippageBps` |
| V12 | `cooldown.range` | `cooldownSeconds` | integer `0..86400` |
| V13 | `interval.range` | `globalMinIntervalSeconds` | integer `0..3600` and `<= cooldownSeconds` when `cooldownSeconds > 0` |
| V14 | `freshness.range` | each `freshness.*` | integer within the ranges in §4.1; `quoteMaxAgeMs <= priceMaxAgeMs` |
| V15 | `token.address` | `tokenAllowlist[chain][i].address` | EVM chains: `^0x[0-9a-f]{40}$`; Solana: valid base58 32-byte key |
| V16 | `token.decimals` | `.decimals` | integer; EVM `0..18`; Solana `0..9`; native sentinel must be 18 (EVM) / 9 (Solana) |
| V17 | `token.unique` | per chain | no duplicate addresses; max 200 entries per chain |
| V18 | `token.chainKnown` | keys of `tokenAllowlist` | every key is a `ChainId`; every `enabledChains` entry has an allowlist (may be empty → all trades on that chain fail `TOKEN_NOT_ALLOWLISTED`, which is legal) |
| V19 | `protocol.key` | keys of `protocolAllowlist[chain]` | `^[a-z0-9-]{2,32}$`; max 32 protocols per chain |
| V20 | `protocol.contracts` | `.contracts` | non-empty, unique, valid address format for the chain, max 32 |
| V21 | `protocol.spenders` | `.approveSpenders` | EVM only; must be a subset of `.contracts`; on Solana must be absent |
| V22 | `switch.bool` | `globalPause`, `emergencyStop` | boolean |
| V23 | `lp.capital` | `lp.maxCapitalPerLpUsd` | `<= maxTotalDeployedUsd` |
| V24 | `lp.pools` | `lp.allowedPools[i]` | `chain ∈ enabledChains`; `protocol ∈ lp.allowedProtocols[chain]`; `poolId` valid address/pubkey for chain, or for Uniswap v4 a `0x`+64-hex pool ID; unique `(chain, protocol, poolId)`; max 64 |
| V25 | `lp.protocols` | `lp.allowedProtocols[chain][i]` | must also be a key of `protocolAllowlist[chain]` |
| V26 | `lp.liquidityRatio` | `lp.minPoolLiquidityUsd` | `>= 100 × lp.maxCapitalPerLpUsd` |
| V27 | `lp.rebalance` | `lp.maxRebalancePerDay`, `lp.maxRebalanceSlippageBps` | integer `0..48`; integer `1..500` |
| V28 | `lp.gas` | `lp.maxLpGasUsd` | `> 0`, `<= maxTransactionFeeUsd` |
| V29 | `lp.claim` | `lp.minFeeThresholdUsd` | `> lp.maxLpGasUsd` (never spend more gas than the fees claimed) |
| V30 | `lp.consistent` | `lp.*` | if `lp.maxCapitalPerLpUsd == 0` then `lp.allowedPools` must be empty (and vice versa); mismatch is an error, not a warning |

### 4.4 Zod 4 schema (`runtime/src/risk/policy.schema.ts`, zod `^4.6.5`)

```ts
import { z } from 'zod';

const USD  = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/);
const EVM  = z.string().regex(/^0x[0-9a-f]{40}$/);
const SOL  = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).refine(isBase58Len32, 'not a 32-byte base58 key');
const Chain = z.enum(['base', 'bsc', 'robinhood', 'solana']);
const ProtoKey = z.string().regex(/^[a-z0-9-]{2,32}$/);

const TokenEntry = z.strictObject({
  address: z.string(), symbol: z.string().regex(/^[A-Za-z0-9.$_-]{1,16}$/), decimals: z.int().min(0).max(18),
});
const ProtoEntry = z.strictObject({
  contracts: z.array(z.string()).min(1).max(32),
  approveSpenders: z.array(z.string()).max(32).optional(),
});

export const RiskPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  enabledChains: z.array(Chain).min(1).max(4),
  maxAmountPerTradeUsd: USD, maxDailyLossUsd: USD, maxTotalDeployedUsd: USD,
  maxTransactionFeeUsd: USD, minLiquidityUsd: USD,
  maxSlippageBps: z.int().min(1).max(1000),
  maxPriceImpactBps: z.int().min(1).max(2000),
  cooldownSeconds: z.int().min(0).max(86400),
  globalMinIntervalSeconds: z.int().min(0).max(3600),
  freshness: z.strictObject({
    priceMaxAgeMs: z.int().min(1000).max(3_600_000),
    quoteMaxAgeMs: z.int().min(1000).max(600_000),
    balanceMaxAgeMs: z.int().min(1000).max(3_600_000),
    liquidityMaxAgeMs: z.int().min(1000).max(86_400_000),
    feeEstimateMaxAgeMs: z.int().min(1000).max(600_000),
    actionMaxAgeMs: z.int().min(1000).max(600_000),
    maxClockSkewMs: z.int().min(0).max(60_000),
  }),
  dailyLoss: z.strictObject({ includeUnrealized: z.boolean() }),
  tokenAllowlist: z.partialRecord(Chain, z.array(TokenEntry).max(200)),
  protocolAllowlist: z.partialRecord(Chain, z.record(ProtoKey, ProtoEntry)),
  globalPause: z.boolean(),
  emergencyStop: z.boolean(),
  lp: z.strictObject({
    maxCapitalPerLpUsd: USD,
    allowedPools: z.array(z.strictObject({ chain: Chain, protocol: ProtoKey, poolId: z.string() })).max(64),
    allowedProtocols: z.partialRecord(Chain, z.array(ProtoKey).max(32)),
    minPoolLiquidityUsd: USD,
    maxRebalancePerDay: z.int().min(0).max(48),
    maxRebalanceSlippageBps: z.int().min(1).max(500),
    maxLpGasUsd: USD,
    minFeeThresholdUsd: USD,
  }),
}).superRefine(crossFieldRules); // implements V06–V09, V11, V13–V14, V15–V21 (per-chain address format), V23–V30
```

`crossFieldRules` pushes one `ctx.addIssue({ code: 'custom', path, message, params: { rule } })` per violated rule from §4.3 and never throws.

### 4.5 Policy hash

`policyHash = sha256(canonicalJson(policy))` where `canonicalJson` is: object keys sorted lexicographically at every depth, arrays kept in order (after normalization they are sorted by address), no whitespace, UTF-8, numbers as shortest round-trip integers (there are no non-integers in the policy). Vector: `canonicalJson({b:1,a:"x"})` = `{"a":"x","b":1}` → `cdab067e9f3beb32d1252cfd63e492592fecbf591b0d08cadb24bb17f3864246`. The hash appears in every `RiskDecision`, is what the operator must echo during LIVE activation (§10 step 3), and changes → demotion to PAPER (§10.4).

---

## 5. Engine inputs

`evaluate(input: RiskInput): RiskDecision` where:

```ts
export interface RiskInput {
  now: number;                 // EpochMs, injected by the caller; the engine never reads a clock
  policy: RiskPolicy;          // already validated
  policyHash: string;
  action: ProposedAction;
  state: RuntimeState;
  snapshot: MarketSnapshot;
}
```

### 5.1 `ProposedAction`

```ts
export type ActionKind = 'swap' | 'approve' | 'lp_add' | 'lp_remove' | 'lp_rebalance' | 'lp_claim';
export type ActionSource = 'llm' | 'scheduler' | 'operator' | 'test';
export type Mode = 'PAPER' | 'LIVE';

export interface TokenRef { address: string; decimals: number }   // decimals MUST equal the allowlist entry (else SCHEMA_INVALID)

export interface EvmFeeDetail    { family: 'evm';    gasLimit: string; maxFeePerGas: string }  // AmountString each; fee = gasLimit × maxFeePerGas (wei)
export interface SolanaFeeDetail { family: 'solana'; signatures: number; computeUnitLimit: number; computeUnitPriceMicroLamports: string; rentLamports: string }
// fee = 5000 × signatures + ceil(computeUnitLimit × computeUnitPriceMicroLamports / 1e6) + rentLamports   (lamports)

export interface ProposedAction {
  schemaVersion: 1;
  actionId: string;                 // UUID (any version) generated by the proposer; unique per proposal
  decisionCycleId: string;          // UUID of the scheduler tick / operator request that produced this proposal
  idempotencyKey: string;           // Sha256Hex, derived per §8.5; engine recomputes and compares
  proposedAt: number;               // EpochMs
  mode: Mode;                       // mode the proposer believes the runtime is in
  source: ActionSource;
  chain: ChainId;
  kind: ActionKind;
  protocol: string;                 // key into policy.protocolAllowlist[chain]
  contract: string;                 // EVM `to` address / Solana program the top-level instruction targets
  programIds?: string[];            // Solana only: ALL top-level program IDs in the built tx (deduplicated, sorted)
  reduceOnly: boolean;              // true = closes/reduces an existing position (§8.4)
  tokenIn: TokenRef;
  tokenOut: TokenRef;               // for `approve`: tokenOut == tokenIn, contract == spender
  amountIn: string;                 // AmountString, base units of tokenIn; for `approve`: allowance amount
  quote: {                          // required for swap / lp_*; forbidden for approve
    expectedAmountOut: string;      // AmountString, base units of tokenOut
    minAmountOut: string;           // AmountString; what the tx enforces on-chain
    slippageBps: number;            // what the adapter asked the quote API for
    priceImpactBps: number;         // ceil(priceImpactPct × 100) as computed by the adapter from the quote source
    quotedAt: number;               // EpochMs
    source: string;                 // e.g. "jupiter-lite-v1", "uniswap-v4-quoter"
    marketId: string;               // pair/pool identifier used for liquidity lookup (§5.3)
  } | null;
  feeEstimate: { estimatedAt: number; detail: EvmFeeDetail | SolanaFeeDetail };
  lp?: {                            // Phase 4 only
    poolId: string; capitalUsd: string /*UsdString*/; rebalanceIndexToday: number; claimableFeesUsd: string /*UsdString*/;
  };
  rationale?: string;               // free text from the LLM; max 2000 chars; never parsed
}
```

Validation of the action (`ActionSchema`, zod, strict): all IDs/addresses must already be canonical (lowercase EVM) — mixed case is `SCHEMA_INVALID`, because the proposal builder is deterministic code that must have normalized it; an un-normalized action means the pipeline is broken. `amountIn > 0`. `quote.minAmountOut <= quote.expectedAmountOut`, both `> 0`. `tokenIn.address != tokenOut.address` except for `approve`. `programIds` required when `chain == 'solana'`, forbidden otherwise. `rationale` is length-checked only.

### 5.2 `RuntimeState` (owned by `RiskGate`, persisted in SQLite; §9)

```ts
export interface Position { chain: ChainId; token: string; amount: string /*AmountString*/; costBasisUsd: string; openedAt: number }

export interface RuntimeState {
  mode: Mode;                                  // derived: activation.state === 'LIVE' ? 'LIVE' : 'PAPER'
  emergencyStop: { active: boolean; since: number | null; reason: string | null; source: 'api'|'file'|'telegram'|'cli'|'policy'|null };
  globalPause: boolean;                        // runtime flag OR policy.globalPause is evaluated by the engine
  activation: { state: ActivationState; liveSession: { startedAt: number; expiresAt: number } | null }; // §10
  cooldowns: Record<string /*marketKey*/, number /*EpochMs of last dispatched action*/>;
  lastAnyActionAt: number | null;
  ledger: {
    dayStartUtcMs: number;                     // floor(now / 86_400_000) × 86_400_000 as of the ledger snapshot
    deployedUsd: string;                       // UsdString >= 0: Σ costBasisUsd of open positions (+ LP capital in Phase 4)
    realizedPnlTodayUsd: string;               // signed UsdString: Σ realized PnL of fills with fillTime ∈ [dayStartUtcMs, now), fees (gas + protocol) included as negatives
    unrealizedPnlUsd: string;                  // signed UsdString: Σ (mark − costBasis) over open positions at the snapshot's prices
    unrealizedPnlAtDayStartUsd: string;        // signed UsdString: same quantity as recorded at dayStartUtcMs (0 if ledger started today)
    positions: Position[];
    lpRebalancesToday: Record<string /*poolKey*/, number>;   // Phase 4
  };
}
```

### 5.3 `MarketSnapshot` (assembled by the adapter layer; immutable for one evaluation)

```ts
export interface Stamped<T> { value: T; at: number /*EpochMs*/; source: string }

export interface MarketSnapshot {
  prices:    Record<string /*`${chain}:${tokenAddress}`*/, Stamped<string /*PriceString USD*/>>;
  liquidity: Record<string /*`${chain}:${marketId}`*/,     Stamped<string /*UsdString*/>>;
  balances:  Record<string /*`${chain}:${tokenAddress}`*/, Stamped<string /*AmountString*/>>;   // wallet balances; native sentinel = wei/lamports
  poolLiquidity?: Record<string /*`${chain}:${poolId}`*/,  Stamped<string /*UsdString*/>>;      // Phase 4
}
```

Keys are exact strings; the engine never fuzzy-matches. A missing key is treated as infinitely stale (`DATA_STALE`, observed `missing`).

`marketId` convention: EVM Uniswap v4 = the 32-byte pool ID hex; Aerodrome/PancakeSwap = pair contract address (lowercase); Solana Jupiter = `${sortedMintA}:${sortedMintB}` (routing is multi-hop, liquidity is taken as the DexScreener liquidity of the deepest pair for that mint pair). The adapter spec owns these; the engine only needs `snapshot.liquidity[`${chain}:${quote.marketId}`]` to exist.

---

## 6. `RiskDecision` output

```ts
export type RejectionCode =
  | 'SCHEMA_INVALID' | 'EMERGENCY_STOP' | 'GLOBAL_PAUSE' | 'LIVE_NOT_ACTIVATED' | 'MODE_MISMATCH'
  | 'CHAIN_UNSUPPORTED' | 'DATA_STALE'
  | 'TOKEN_NOT_ALLOWLISTED' | 'PROTOCOL_NOT_ALLOWLISTED' | 'CONTRACT_UNKNOWN' | 'REDUCE_ONLY_MISMATCH'
  | 'SIZE_EXCEEDS_MAX_TRADE' | 'DAILY_LOSS_BREACHED' | 'TOTAL_DEPLOYED_BREACHED'
  | 'SLIPPAGE_EXCEEDS_MAX' | 'FEE_EXCEEDS_MAX' | 'LIQUIDITY_BELOW_MIN' | 'COOLDOWN_ACTIVE' | 'BALANCE_INSUFFICIENT'
  | 'DUPLICATE_ACTION'                                                            // gate-level only (§9)
  | 'POOL_NOT_ALLOWLISTED' | 'LP_CAPITAL_EXCEEDS_MAX' | 'POOL_LIQUIDITY_BELOW_MIN' | 'REBALANCE_LIMIT_REACHED' | 'FEE_BELOW_CLAIM_THRESHOLD'; // Phase 4

export interface RiskCheck {
  name: string;          // canonical check name from §7 (e.g. "size.amountInUsd")
  code: RejectionCode;   // the code this check maps to when it fails
  passed: boolean;
  observed: string;      // ALWAYS a string: UsdString, bps, seconds, "true"/"false", "missing", address…
  limit: string;         // ALWAYS a string; "n/a" when the check is a membership test
  skipped?: 'not-applicable' | 'short-circuit';   // present when the check did not run (§7.1)
  detail?: string;       // <= 200 chars, human readable
}

export interface RiskDecision {
  schemaVersion: 1;
  engineVersion: string;          // "risk-engine/1.0.0"
  actionId: string;
  idempotencyKey: string;
  mode: Mode;                     // runtime mode at evaluation time
  evaluatedAt: number;            // == input.now
  policyHash: string;
  allowed: boolean;
  code: 'OK' | RejectionCode;     // first failed check in canonical order, or "OK"
  reason: string;                 // "<check name>: observed <x> vs limit <y>" of the first failed check, or "all checks passed"
  checks: RiskCheck[];            // every check in canonical order (§7), including skipped ones
  derived: {                      // the numbers the engine computed, for the audit log / dashboard
    amountInUsd: string; feeUsd: string; impliedSlippageBps: number; dailyLossUsd: string; projectedDeployedUsd: string;
  } | null;                       // null when short-circuited before derivation
  replayOf?: string;              // set by the gate when returning a cached decision for a duplicate idempotencyKey
}
```

Determinism guarantee: for identical `RiskInput` (deep-equal), `evaluate` returns a byte-identical `canonicalJson(decision)`. Tests assert this by evaluating twice and by shuffling object key order in the input.

---

## 7. Check pipeline

### 7.1 Execution model

- Checks are listed in a fixed canonical order. `code` = code of the **first** failed check in that order.
- Tier 0 checks (`schema.*`, `stop.*`, `pause.*`, `live.*`) **short-circuit**: if one fails, every later check is emitted with `skipped: 'short-circuit'`, `passed: false`, `observed: 'not-evaluated'`. Rationale: nothing below is meaningful without a valid action and an un-stopped runtime, and the dashboard should not show "size OK" while the emergency stop is on.
- Tier 1+ checks are all evaluated (no short-circuit) so the operator sees every problem at once. A check that cannot be evaluated because its data is missing fails as `DATA_STALE` in the `freshness.*` group and the dependent check reports `observed: 'not-evaluated'`, `passed: false`.
- Checks not applicable to the action kind (§7.3) are emitted with `skipped: 'not-applicable'`, `passed: true`.

### 7.2 Canonical check list (Phases 1–3)

Comparison convention: "max" limits are inclusive (`observed <= limit` passes); "min" limits are inclusive (`observed >= limit` passes); ages are compared as `now - at <= maxAge` passes.

| # | Check name | Code | Passes iff | `observed` | `limit` |
|---|---|---|---|---|---|
| 0 | `schema.policy` | `SCHEMA_INVALID` | a validated policy is loaded | `valid`/`invalid` | `valid` |
| 1 | `schema.action` | `SCHEMA_INVALID` | `ActionSchema.safeParse(action).success` and `action.tokenIn.decimals`/`tokenOut.decimals` equal the allowlist entries (when allowlisted) | first zod issue path | `n/a` |
| 2 | `schema.idempotency` | `SCHEMA_INVALID` | `action.idempotencyKey == deriveIdempotencyKey(action)` (§8.5) | given key | derived key |
| 3 | `stop.emergency` | `EMERGENCY_STOP` | `!(policy.emergencyStop || state.emergencyStop.active)` | `true`/`false` | `false` |
| 4 | `pause.global` | `GLOBAL_PAUSE` | `!(policy.globalPause || state.globalPause)` | `true`/`false` | `false` |
| 5 | `live.modeMatch` | `MODE_MISMATCH` | `action.mode == state.mode` | action.mode | state.mode |
| 6 | `live.activated` | `LIVE_NOT_ACTIVATED` | `action.mode == 'PAPER'` OR (`state.activation.state == 'LIVE'` AND `state.activation.liveSession.expiresAt > now`) | activation state | `LIVE` |
| 7 | `chain.enabled` | `CHAIN_UNSUPPORTED` | `action.chain ∈ policy.enabledChains` | chain | enabledChains joined by `,` |
| 8 | `freshness.action` | `DATA_STALE` | `0 <= now - action.proposedAt <= actionMaxAgeMs` and `action.proposedAt - now <= maxClockSkewMs` | age ms | max ms |
| 9 | `freshness.price.tokenIn` | `DATA_STALE` | price present and `now - at <= priceMaxAgeMs` and not in the future beyond skew | age ms or `missing` | max ms |
| 10 | `freshness.price.tokenOut` | `DATA_STALE` | same for tokenOut (skipped for `approve`) | | |
| 11 | `freshness.price.native` | `DATA_STALE` | same for the chain's native token (needed for fee USD) | | |
| 12 | `freshness.quote` | `DATA_STALE` | `now - quote.quotedAt <= quoteMaxAgeMs` (skipped for `approve`) | | |
| 13 | `freshness.fee` | `DATA_STALE` | `now - feeEstimate.estimatedAt <= feeEstimateMaxAgeMs` | | |
| 14 | `freshness.balance.tokenIn` | `DATA_STALE` | balance present and fresh (`balanceMaxAgeMs`) | | |
| 15 | `freshness.balance.native` | `DATA_STALE` | same for native | | |
| 16 | `freshness.liquidity` | `DATA_STALE` | `snapshot.liquidity[chain:marketId]` present and `<= liquidityMaxAgeMs` (skipped for `approve`) | | |
| 17 | `allowlist.tokenIn` | `TOKEN_NOT_ALLOWLISTED` | `tokenIn.address ∈ tokenAllowlist[chain]` | address | `n/a` |
| 18 | `allowlist.tokenOut` | `TOKEN_NOT_ALLOWLISTED` | `tokenOut.address ∈ tokenAllowlist[chain]` | address | `n/a` |
| 19 | `allowlist.protocol` | `PROTOCOL_NOT_ALLOWLISTED` | `protocol ∈ keys(protocolAllowlist[chain])` | protocol | `n/a` |
| 20 | `allowlist.contract` | `CONTRACT_UNKNOWN` | swap/lp: `contract ∈ protocolAllowlist[chain][protocol].contracts`; approve: `contract ∈ …approveSpenders`; Solana: additionally every `programIds[i] ∈ contracts ∪ SOLANA_SYSTEM_PROGRAMS` | contract (or first offending program) | `n/a` |
| 21 | `position.reduceOnly` | `REDUCE_ONLY_MISMATCH` | if `reduceOnly`: a `Position` exists with `chain == action.chain && token == tokenIn.address` and `amountIn <= position.amount`; if not `reduceOnly`: always passes | amountIn | position amount or `none` |
| 22 | `size.amountInUsd` | `SIZE_EXCEEDS_MAX_TRADE` | `amountInUsd <= maxAmountPerTradeUsd` where `amountInUsd = nativeToUsdMicros(amountIn, tokenIn.decimals, price(tokenIn), ceil)`. For `approve`: `amountIn` valued the same way (so unlimited approvals fail here). **Skipped when `reduceOnly`** | UsdString | UsdString |
| 23 | `loss.daily` | `DAILY_LOSS_BREACHED` | `dailyLossUsd + worstCaseCostUsd <= maxDailyLossUsd` (§8.1). **Skipped when `reduceOnly`** | `dailyLoss+worstCase` UsdString | UsdString |
| 24 | `deployed.total` | `TOTAL_DEPLOYED_BREACHED` | `deployedUsd + amountInUsd <= maxTotalDeployedUsd`. **Skipped when `reduceOnly` or `approve`** | projected UsdString | UsdString |
| 25 | `slippage.implied` | `SLIPPAGE_EXCEEDS_MAX` | `max(quote.slippageBps, impliedSlippageBps(expectedOut, minOut)) <= maxSlippageBps` | bps | bps |
| 26 | `slippage.priceImpact` | `SLIPPAGE_EXCEEDS_MAX` | `quote.priceImpactBps <= maxPriceImpactBps` | bps | bps |
| 27 | `fee.usd` | `FEE_EXCEEDS_MAX` | `feeUsd <= maxTransactionFeeUsd` where `feeUsd = nativeToUsdMicros(feeNative, nativeDecimals, price(native), ceil)` and `feeNative` per §5.1 | UsdString | UsdString |
| 28 | `liquidity.market` | `LIQUIDITY_BELOW_MIN` | `liquidityUsd >= minLiquidityUsd` (`floor` when converting) | UsdString | UsdString |
| 29 | `cooldown.market` | `COOLDOWN_ACTIVE` | `cooldowns[marketKey]` absent OR `now - cooldowns[marketKey] >= cooldownSeconds × 1000`. **Skipped when `reduceOnly` or `approve`** | elapsed s | cooldown s |
| 30 | `cooldown.global` | `COOLDOWN_ACTIVE` | `lastAnyActionAt` null OR `now - lastAnyActionAt >= globalMinIntervalSeconds × 1000`. **Skipped when `reduceOnly`** | elapsed s | interval s |
| 31 | `balance.tokenIn` | `BALANCE_INSUFFICIENT` | `balance(tokenIn) >= amountIn` (native tokenIn: `>= amountIn + feeNative`). Skipped for `approve` | AmountString | AmountString |
| 32 | `balance.gas` | `BALANCE_INSUFFICIENT` | `balance(native) >= feeNative` (if tokenIn is native this is subsumed but still reported) | AmountString | AmountString |

`marketKey = `${chain}:${min(a,b)}:${max(a,b)}`` with `a,b` the two token addresses compared as plain strings (§8.2 vectors).

`worstCaseCostUsd = feeUsd + ceilDiv(amountInUsd × maxSlippageBps, 10000)` for swaps; `feeUsd` for approve.

### 7.3 Applicability by action kind

| Check | `swap` (open) | `swap` `reduceOnly` | `approve` | `lp_*` (Phase 4) |
|---|---|---|---|---|
| 0–8 tier 0 + chain + action freshness | ✓ | ✓ | ✓ | ✓ |
| price/quote/liquidity freshness | ✓ | ✓ | price.tokenIn + native + fee + balance only | ✓ |
| allowlists | ✓ | ✓ | ✓ (spender rule) | ✓ + `POOL_NOT_ALLOWLISTED` |
| reduceOnly | ✓ | ✓ | n/a | n/a |
| size | ✓ | skipped | ✓ | replaced by `LP_CAPITAL_EXCEEDS_MAX` |
| daily loss | ✓ | skipped | ✓ (fee only) | ✓ |
| deployed total | ✓ | skipped | skipped | ✓ (capital) |
| slippage / impact | ✓ | ✓ | skipped | `maxRebalanceSlippageBps` |
| fee | ✓ | ✓ | ✓ | `maxLpGasUsd` |
| liquidity | ✓ | ✓ | skipped | `minPoolLiquidityUsd` |
| cooldown market / global | ✓ / ✓ | skipped / skipped | skipped / ✓ | ✓ / ✓ |
| balance tokenIn / gas | ✓ / ✓ | ✓ / ✓ | skipped / ✓ | ✓ / ✓ |

Design note — why exits are privileged: a `reduceOnly` swap can only lower exposure, so the checks that exist to cap exposure (size, deployed, daily loss, cooldown) would otherwise trap the operator in a losing position. Exits still must respect allowlists, slippage, fee, liquidity and balances, and `reduceOnly` is verified against the ledger (`REDUCE_ONLY_MISMATCH`), so the LLM cannot smuggle an entry through the exit door.

---

## 8. Semantics

### 8.1 Daily-loss window

- **Window**: the UTC calendar day. `dayStartUtcMs = floor(now / 86_400_000) × 86_400_000`. The ledger, not the engine, rolls the window; the engine asserts `state.ledger.dayStartUtcMs == floor(now / 86_400_000) × 86_400_000`, otherwise the ledger snapshot is stale → `DATA_STALE` (check `freshness.ledger`, reported inside `loss.daily`'s detail; treated as check 8b in order).
  Vectors: `2026-09-19T14:30:00Z` = `1789828200000` → dayStart `1789776000000`; `2026-09-19T23:59:59.999Z` = `1789862399999` → dayStart `1789776000000`; `2026-09-20T00:00:00.000Z` = `1789862400000` → dayStart `1789862400000`.
- **Formula** (all signed micro-USD; a positive result is a loss):

  ```
  realizedLoss   = -realizedPnlTodayUsd                      // fees are already inside realized PnL as negatives
  unrealizedMove = includeUnrealized ? -(unrealizedPnlUsd - unrealizedPnlAtDayStartUsd) : 0
  dailyLossUsd   = max(0, realizedLoss + unrealizedMove)
  ```

  This equals the day's equity drawdown excluding deposits/withdrawals: yesterday's underwater position does not count again today (its day-start mark is the baseline), but a position that drops further today does. Gains today offset losses today.
- **Pre-trade projection**: the check is `dailyLossUsd + worstCaseCostUsd <= maxDailyLossUsd`. An action is refused when its own fee plus full slippage tolerance would push the day over the limit, so the limit is a hard ceiling, not a trigger that fires after the fact.
- `includeUnrealized: true` by default. Setting it to `false` is allowed (some operators only want realized), but the dashboard must show a warning.
- **Reset**: nothing to reset; at the next UTC day boundary the ledger records a new `unrealizedPnlAtDayStartUsd` and `realizedPnlTodayUsd` starts at 0. There is no "end-of-day flatten".
- **After a breach**: only `reduceOnly` swaps (and `approve`? no — approve costs gas and is not an exit; it is refused too) pass until the next UTC day.

### 8.2 Cooldown

- **Scope**: per market by default, plus a global minimum interval. `marketKey` uses the unordered token pair so a buy and the reverse sell share one cooldown.
  Vectors: `marketKey("base","0x8335…2913","0x4200…0006")` = `base:0x4200000000000000000000000000000000000006:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (same result with the arguments swapped); `marketKey("solana","So111…112","EPjF…Dt1v")` = `solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:So11111111111111111111111111111111111111112`.
- **Clock start**: the gate records `cooldowns[marketKey] = now` and `lastAnyActionAt = now` when an action is **dispatched** (decision allowed and handed to the executor), not when it fills and not when it is proposed. Rejected actions never start a cooldown (otherwise a burst of rejections would lock the market).
- **Inclusive**: elapsed `>= cooldownSeconds` passes. `cooldownSeconds: 0` disables the market cooldown; `globalMinIntervalSeconds: 0` disables the global one.
- **Exits** (`reduceOnly`) bypass both cooldowns; `approve` bypasses the market cooldown only.
- **Persistence**: cooldowns survive restarts (SQLite `cooldowns` table); on boot, entries older than `cooldownSeconds` are pruned.

### 8.3 Data freshness

Every stamped datum has `at`. It is stale when `now - at > maxAge` **or** `at - now > maxClockSkewMs` (a timestamp from the future means a broken clock or a forged snapshot; both are refused). Missing = stale. `now` is the gate's clock (`Date.now()` in the gate, never in the engine).

### 8.4 Reduce-only

`reduceOnly: true` is set by the proposal builder when the LLM's intent is `close`/`reduce`. The engine verifies it against `state.ledger.positions`: same chain, `tokenIn.address == position.token`, `amountIn <= position.amount`. Partial reductions are allowed. If several positions exist for the same token they are summed. Failure → `REDUCE_ONLY_MISMATCH` (never silently downgraded to a normal swap, because that would change which checks apply).

### 8.5 Idempotency keys

Purpose: the same intent must not execute twice (LLM retries, scheduler replays, dashboard double-clicks, crash-restart).

```
idempotencyKey = sha256( "atra-action-v1|" + decisionCycleId + "|" + chain + "|" + kind + "|" + protocol
                         + "|" + tokenIn.address + "|" + tokenOut.address + "|" + amountIn + "|" + (reduceOnly ? "true" : "false") )
```

- Same cycle re-proposing the same trade → same key → `DUPLICATE_ACTION` (cached decision returned, `replayOf` set, nothing executed). Different cycles → different keys; spacing is the cooldown's job, not idempotency's.
- The engine recomputes the key (check `schema.idempotency`); a mismatch is `SCHEMA_INVALID` (the proposer is corrupt).
- Retention: 24 h in `action_decisions` (SQLite), pruned lazily.
- Executor-level idempotency (for completeness): once a tx is signed, `actionId → txHash` is written **before** broadcast; on restart, actions in `SIGNED`/`BROADCAST` state are reconciled by hash and never re-broadcast.

Vectors:

| Input string | sha256 |
|---|---|
| `atra-action-v1\|0192f3a0-6b1e-7c2d-9a4b-1c2d3e4f5a6b\|base\|swap\|uniswap-v4\|0x833589fcd6edb6e08f4c7c32d4f71b54bda02913\|0x4200000000000000000000000000000000000006\|10000000\|false` | `1a623ec2163f3a1e983061ac7078482a5ca5340d8c48dcdf57a758cb77a0b9d1` |
| same with `amountIn` `10000001` | `e2c5f160d3531225d007f9f9d8b985d52c75596dcd09aa49d974eb9c63536920` |
| same as first with `reduceOnly` `true` | `36fd99b1967bedc1a4a5a82d5fcada44a5d2215f74fb7207a80e57caccd85900` |

### 8.6 `PAPER` vs `LIVE`

Identical check list, identical limits, identical code paths. Differences are confined to the inputs and to two tier-0 checks:

| Aspect | PAPER | LIVE |
|---|---|---|
| `live.modeMatch` | action.mode must be `PAPER` | must be `LIVE` |
| `live.activated` | always passes | requires activation state `LIVE` with an unexpired session (§10) |
| `snapshot.balances` | paper ledger balances (seeded by the paper-trading spec) | real RPC balances |
| `snapshot.prices/liquidity` | real market data (paper trades against real prices) | real market data |
| `feeEstimate` | real estimate (paper fees are charged to the paper ledger) | real estimate |
| Executor | simulates fills at `expectedAmountOut` minus a deterministic paper slippage | signs and broadcasts |

There is no "PAPER-only relaxed limit": if it would be refused live, it is refused on paper, so paper statistics predict live behaviour.

---

## 9. `RiskGate` (stateful wrapper) and persistence

```ts
export class RiskGate {
  constructor(deps: { db: DatabaseSync /* node:sqlite */; clock: () => number; policyStore: PolicyStore; events: EventBus });
  /** Full path: idempotency lookup → assemble RuntimeState → evaluate → persist decision → (if allowed) reserve cooldown. */
  async decide(action: ProposedAction, snapshot: MarketSnapshot): Promise<RiskDecision>;
  /** Called by the executor when the action is actually handed to the signer/simulator. Starts cooldowns. */
  markDispatched(actionId: string): void;
  /** Dry run for the dashboard: same as decide() but never persists, never reserves. */
  preview(action: ProposedAction, snapshot: MarketSnapshot): RiskDecision;
}
```

Order inside `decide()`:

1. `SELECT decision_json FROM action_decisions WHERE idempotency_key = ?` → if found, return it with `code: 'DUPLICATE_ACTION'`, `allowed: false`, `replayOf: <original actionId>`, `checks: []`. (A duplicate is never re-executed, even if the original was allowed.)
2. Build `RuntimeState` from the tables below plus the ledger service.
3. `evaluate()` (pure).
4. `INSERT` the decision (`action_decisions`) and an audit row (`risk_events`) in one transaction.
5. Return. Cooldowns are **not** written here; `markDispatched` writes them so that an allowed-but-never-dispatched action (executor crashed) does not lock the market.

Node 24.17 ships `node:sqlite` (`DatabaseSync`) without an experimental warning (checked locally: `new DatabaseSync(':memory:')` works). Use it; `better-sqlite3` `13.0.3` is the fallback only if a native-module build is preferred for some reason.

```sql
CREATE TABLE IF NOT EXISTS risk_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL, hash TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS risk_policy_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL, hash TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_flags (            -- keys: emergency_stop, global_pause, scheduler_state, last_any_action_at
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cooldowns (
  market_key TEXT PRIMARY KEY, last_action_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS action_decisions (
  action_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, decision_json TEXT NOT NULL,
  allowed INTEGER NOT NULL, code TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS action_decisions_expires ON action_decisions(expires_at);
CREATE TABLE IF NOT EXISTS live_activation (
  id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS live_activation_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, from_state TEXT NOT NULL, event TEXT NOT NULL, to_state TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS risk_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
```

HTTP surface (dashboard; all under the local auth of the runtime spec):

| Method | Path | Effect |
|---|---|---|
| `GET` | `/v1/risk/policy` | current policy + hash |
| `PUT` | `/v1/risk/policy` | `normalizePolicy` → `validatePolicy` → on success store + history + event `POLICY_CHANGED` (demotes LIVE → PAPER, §10.4); on failure `422` with `errors[]`, nothing stored |
| `POST` | `/v1/risk/preview` | body = `{ action, snapshot? }`; returns a `RiskDecision` without persisting |
| `GET` | `/v1/risk/state` | mode, flags, cooldowns, activation state, ledger summary |
| `POST` | `/v1/risk/pause` / `/v1/risk/unpause` | sets `runtime_flags.global_pause` |

---

## 10. `LIVE` activation state machine

### 10.1 States

```
PAPER ──ACK──▶ ACTIVATING ──(REAUTH, RISK_REVIEW, VERIFY×3 all pass)──▶ READY ──CONFIRM──▶ LIVE
  ▲                │                                                       │                 │
  └────────────────┴───────── any failure / timeout / demotion event ──────┴─────────────────┘
```

`ActivationState = 'PAPER' | 'ACTIVATING' | 'READY' | 'LIVE'`. `ACTIVATING` carries a checklist:

```ts
interface ActivationChecklist {
  startedAt: number; expiresAt: number;               // expiresAt = startedAt + 600_000 (10 min TTL for the whole sequence)
  steps: {
    ack:           { done: boolean; at: number | null };
    reauth:        { done: boolean; at: number | null; liveTokenId: string | null };
    riskReviewed:  { done: boolean; at: number | null; policyHash: string | null };
    walletFunded:  { done: boolean; at: number | null; perChain: Record<ChainId, { fundedUsd: string }> };
    gasPresent:    { done: boolean; at: number | null; perChain: Record<ChainId, { nativeUsd: string; required: string }> };
    adapterReady:  { done: boolean; at: number | null; perChain: Record<ChainId, { chainIdOk: boolean; headFresh: boolean; quoteOk: boolean; signerOk: boolean }> };
  };
  lastFailure: { step: string; reason: string; at: number } | null;
}
```

### 10.2 Steps (strictly in this order; a step cannot run unless the previous is `done`)

| # | Step | Trigger | Pass criteria | On failure |
|---|---|---|---|---|
| 1 | `ack` (acknowledgement) | `POST /v1/live/ack` body `{ "text": "I understand ATRA will sign real transactions with real funds and that losses are mine." }` — exact string, byte-compared | text matches; no emergency stop active; policy valid | `400`, stays PAPER |
| 2 | `reauth` (re-authentication) | `POST /v1/live/reauth` body `{ "passphrase": "…" }` | passphrase verifies against the stored argon2id hash (vault spec); issues a `liveToken` (random 32 bytes, base64url, 10-min expiry, single session) returned once; rate-limited 5/10 min | `401`, failure counter; 3 failures → PAPER + 15-min lockout |
| 3 | `riskReviewed` | `POST /v1/live/risk-review` body `{ "policyHash": "<64 hex>" }` + header `X-Live-Token` | `policyHash == current policy hash` (proves the operator looked at the policy that will be enforced) AND `liveEligible(policy)`: every enabled chain has ≥ 1 non-native token in `tokenAllowlist` and ≥ 1 protocol in `protocolAllowlist`; `emergencyStop == false`; `globalPause == false` | `409` with the mismatch/ineligibility; stays ACTIVATING until TTL, then PAPER |
| 4 | `walletFunded` | automatic, part of `POST /v1/live/verify` (requires `X-Live-Token`) | for **every** chain in `enabledChains`: Σ over allowlisted tokens of `nativeToUsdMicros(balance, decimals, price, floor)` `>= 5.000000` USD, using fresh (`balanceMaxAgeMs`, `priceMaxAgeMs`) data fetched during the step | PAPER, `lastFailure.step = 'walletFunded'`, per-chain detail retained |
| 5 | `gasPresent` | automatic, same call | for every enabled chain: native balance in USD (floor) `>= 5 × maxTransactionFeeUsd` (defaults: $5.00); Solana additionally `lamports >= 1_488_440 + 5 × feeNative` using the live `getMinimumBalanceForRentExemption(165)` value, not the constant | PAPER |
| 6 | `adapterReady` | automatic, same call | for every enabled chain, all four: (a) `eth_chainId` == expected (`0x2105`/`0x38`/`0x1237`) or `getGenesisHash` == `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, within 5 s; (b) head freshness: latest block `timestamp` within 120 s of local clock (Solana: `getSlot` advanced across two calls 2 s apart); (c) a quote for the first allowlisted non-native token vs the native/stable pair returns within `quoteMaxAgeMs`; (d) vault unlocked and derived address == configured address for that chain (no signature is produced) | PAPER |
| — | `READY` | reached automatically when step 6 passes | `READY` expires 5 minutes after it is reached (`readyExpiresAt`) | → PAPER on expiry |
| 7 | `CONFIRM` | `POST /v1/live/confirm` body `{ "phrase": "GO LIVE" }` + `X-Live-Token` | state `READY`, not expired, phrase exact, token valid | `409`; stays READY until expiry |

**"Never auto-switch"** is enforced structurally: the only code path that writes `state = 'LIVE'` is the `confirm` handler, which requires `READY` and a valid `liveToken` that only step 2 (a human typing a passphrase) can mint. The scheduler, the LLM tool surface and the Telegram bot have no route to `confirm`. A code-review rule (`eslint` `no-restricted-syntax` on the string literal `'LIVE'` outside `runtime/src/live/activation.ts`) backs this up.

### 10.3 Session

On `CONFIRM`: `liveSession = { startedAt: now, expiresAt: now + 24 h }`. When `expiresAt` passes the runtime demotes itself to PAPER (auto-**demotion** is allowed; auto-promotion never). The dashboard shows the remaining time and offers "re-arm", which is the full sequence again.

### 10.4 Demotion events (any state → `PAPER`, logged in `live_activation_log`)

| Event | Source |
|---|---|
| `DEACTIVATE` | operator (`POST /v1/live/deactivate`, no re-auth needed — leaving LIVE must be easy) |
| `EMERGENCY_STOP` | §11 |
| `POLICY_CHANGED` | any successful `PUT /v1/risk/policy` (the reviewed hash is no longer the enforced one) |
| `TTL_EXPIRED` / `READY_EXPIRED` / `SESSION_EXPIRED` | timers |
| `RESTART` | every process start begins in `PAPER`; `live_activation` row is reset on boot |
| `VAULT_LOCKED` | vault auto-lock or explicit lock |
| `ADAPTER_UNHEALTHY` | 3 consecutive failed health probes (same criteria as step 6a/6b) on any enabled chain |
| `REAUTH_FAILED` | 3 wrong passphrases during activation |

Demotion never cancels an already-broadcast transaction; it prevents new signing (`live.activated` fails for every subsequent action).

---

## 11. Emergency stop and global pause

### 11.1 Emergency stop

- **Triggers** (all equivalent; each records `source`): `POST /v1/emergency-stop {reason}` (authenticated session, **no re-auth**: stopping must never be slower than one click); presence of the file `<ATRA_HOME>/EMERGENCY_STOP` (watched with `fs.watch` plus a 1 s poll fallback, content = reason); Telegram `/stop` via the gateway (gateway spec; the runtime treats it as `source: 'telegram'`); CLI `atra stop` (writes the file and calls the endpoint); `policy.emergencyStop: true`.
- **Independence**: the flag lives in memory and in `runtime_flags` (SQLite) and the file. None of the trigger paths touch the LLM, the gateway's market feed or any RPC, so the stop works with the LLM offline, the network down, or the model hung. The engine check is a boolean read.
- **Effects, in this order, all within one event-loop turn of the trigger**:
  1. `state.emergencyStop = { active: true, since: now, reason, source }` written to memory, then SQLite (`runtime_flags.emergency_stop = '{"active":true,…}'`), then the file if not already present.
  2. Scheduler: every pending timer is cleared, every queued job is marked `CANCELLED(EMERGENCY_STOP)`, scheduler state → `PAUSED_EMERGENCY`; it does not tick again until explicitly resumed.
  3. Executor: actions in `PROPOSED`/`RISK_APPROVED`/`BUILT` are cancelled; the executor re-reads the flag **immediately before `sign`** and **immediately before `broadcast`** so an action that was approved a millisecond earlier still does not go out. Anything already broadcast cannot be recalled; its monitor keeps running to record the outcome.
  4. Activation: demotion to `PAPER` (§10.4); pending `liveToken`s revoked.
  5. Engine: every `evaluate()` fails at `stop.emergency` (tier 0, short-circuit), including `reduceOnly` exits and paper actions. (Exits are blocked on purpose: the stop exists for the case where the operator no longer trusts the pipeline, including its exit logic. The operator can still exit manually with their wallet.)
  6. Notification: dashboard banner, Telegram message (best effort), `risk_events` row.
- **Persistence**: survives restarts (both the SQLite flag and the file are read on boot; either one → active).
- **Clear**: `POST /v1/emergency-stop/clear` body `{ "reason": "<≥ 10 chars>", "confirm": "CLEAR EMERGENCY STOP" }` **with re-authentication** (passphrase, same rules as §10.2 step 2). Refused with `409` while the file `<ATRA_HOME>/EMERGENCY_STOP` still exists (the operator deletes it by hand — a deliberate friction) or while `policy.emergencyStop` is `true`. After a clear: flag off, scheduler remains `PAUSED_EMERGENCY` until `POST /v1/scheduler/resume`, mode remains `PAPER`. Nothing resumes by itself.
- **Precedence**: `EMERGENCY_STOP` is reported before `GLOBAL_PAUSE` when both are set.

### 11.2 Global pause

Soft switch for "do nothing for a while": scheduler keeps ticking and the LLM may keep proposing, but every action is refused with `GLOBAL_PAUSE`. Toggled by `POST /v1/risk/pause|unpause` (no re-auth), Telegram `/pause` `/unpause`, or `policy.globalPause`. No auto-expiry in v1. Does not demote LIVE. Does not cancel in-flight actions that were approved before the pause (they are already past the engine); the executor does **not** re-check the pause before signing (only the emergency stop gets that treatment — pause is a planning-level switch, stop is a safety switch).

---

## 12. Phase 4 LP checks (outline; fields are validated today, checks ship with Phase 4)

| Check name | Code | Passes iff |
|---|---|---|
| `lp.pool` | `POOL_NOT_ALLOWLISTED` | `(chain, protocol, poolId) ∈ lp.allowedPools` and `protocol ∈ lp.allowedProtocols[chain]` |
| `lp.capital` | `LP_CAPITAL_EXCEEDS_MAX` | `lp.capitalUsd (ceil) <= lp.maxCapitalPerLpUsd` (for `lp_add`/`lp_rebalance`) |
| `lp.poolLiquidity` | `POOL_LIQUIDITY_BELOW_MIN` | `poolLiquidity[chain:poolId] (floor) >= lp.minPoolLiquidityUsd` |
| `lp.rebalanceCount` | `REBALANCE_LIMIT_REACHED` | `ledger.lpRebalancesToday[poolKey] < lp.maxRebalancePerDay` (for `lp_rebalance`; UTC day) |
| `lp.rebalanceSlippage` | `SLIPPAGE_EXCEEDS_MAX` | implied slippage of the rebalance swap leg `<= lp.maxRebalanceSlippageBps` |
| `lp.gas` | `FEE_EXCEEDS_MAX` | `feeUsd <= lp.maxLpGasUsd` |
| `lp.claimThreshold` | `FEE_BELOW_CLAIM_THRESHOLD` | for `lp_claim`: `claimableFeesUsd (floor) >= lp.minFeeThresholdUsd` |
| `deployed.total` | `TOTAL_DEPLOYED_BREACHED` | `deployedUsd + capitalUsd <= maxTotalDeployedUsd` |

`lp_remove` is treated like `reduceOnly` (privileged exit). Until Phase 4 ships, any `lp_*` kind is refused with `SCHEMA_INVALID` (reason `lp not enabled in this build`).

---

## 13. Test matrix

Framework: `vitest` `^5.0.1`, files under `runtime/src/risk/__tests__/`. Every case is a row in a `test.each` table built from a baseline fixture plus a mutation function; assertions are `decision.code`, `decision.allowed`, and for the named check `passed/observed/limit`. Fixtures are JSON under `docs/specs/fixtures/risk/` so the frontend session can reuse them for the dashboard's "preview" UI without importing runtime code.

### 13.1 Baseline fixture `F0` (all fixture prices are synthetic test values, not market claims)

```ts
export const NOW = 1789828200000;                     // 2026-09-19T14:30:00.000Z
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const WETH = '0x4200000000000000000000000000000000000006';
export const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const UR_BASE = '0x6ff5693b99212da76ad316178a184ab56d299b43';
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
export const AERO_ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';
export const AERO_TOKEN = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';   // not allowlisted by default
export const CYCLE = '0192f3a0-6b1e-7c2d-9a4b-1c2d3e4f5a6b';
export const MARKET = '0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a'; // arbitrary 32-byte pool id for the fixture

export const policy = DEFAULT_POLICY;                                     // §4.2

export const action: ProposedAction = {
  schemaVersion: 1, actionId: '11111111-1111-4111-8111-111111111111', decisionCycleId: CYCLE,
  idempotencyKey: '1a623ec2163f3a1e983061ac7078482a5ca5340d8c48dcdf57a758cb77a0b9d1',  // §8.5 vector 1
  proposedAt: NOW - 2000, mode: 'PAPER', source: 'llm', chain: 'base', kind: 'swap',
  protocol: 'uniswap-v4', contract: UR_BASE, reduceOnly: false,
  tokenIn: { address: USDC, decimals: 6 }, tokenOut: { address: WETH, decimals: 18 },
  amountIn: '10000000',                                                    // 10 USDC
  quote: { expectedAmountOut: '3999800000000000', minAmountOut: '3987800600000000', slippageBps: 30, priceImpactBps: 2,
           quotedAt: NOW - 3000, source: 'uniswap-v4-quoter', marketId: MARKET },
  feeEstimate: { estimatedAt: NOW - 3000, detail: { family: 'evm', gasLimit: '250000', maxFeePerGas: '10000000' } }, // 0.01 gwei
};

export const state: RuntimeState = {
  mode: 'PAPER',
  emergencyStop: { active: false, since: null, reason: null, source: null },
  globalPause: false,
  activation: { state: 'PAPER', liveSession: null },
  cooldowns: {}, lastAnyActionAt: null,
  ledger: { dayStartUtcMs: 1789776000000, deployedUsd: '0.000000', realizedPnlTodayUsd: '0.000000',
            unrealizedPnlUsd: '0.000000', unrealizedPnlAtDayStartUsd: '0.000000', positions: [], lpRebalancesToday: {} },
};

export const snapshot: MarketSnapshot = {
  prices: { [`base:${USDC}`]: { value: '1.000027', at: NOW - 5000, source: 'fixture' },
            [`base:${WETH}`]: { value: '2500.123456', at: NOW - 5000, source: 'fixture' },
            [`base:${NATIVE}`]: { value: '2500.123456', at: NOW - 5000, source: 'fixture' } },
  liquidity: { [`base:${MARKET}`]: { value: '1500000.000000', at: NOW - 60000, source: 'fixture' } },
  balances: { [`base:${USDC}`]: { value: '100000000', at: NOW - 5000, source: 'fixture' },        // 100 USDC
              [`base:${NATIVE}`]: { value: '10000000000000000', at: NOW - 5000, source: 'fixture' } }, // 0.01 ETH
};
```

Derived values for `F0` (asserted in T01): `amountInUsd = "10.000270"`, `feeUsd = "0.006251"`, `impliedSlippageBps = 30`, `worstCaseCostUsd = 0.006251 + ceil(10.000270 × 50 / 10000) = 0.006251 + 0.050002 = "0.056253"`, `dailyLossUsd = "0.000000"`, `projectedDeployedUsd = "10.000270"`.

Additional baselines: `F_SOL` (solana, `jupiter-v6`, SOL→USDC, `amountIn` `50000000` = 0.05 SOL, price `111.790298` → `5.589515` USD, `programIds` = `[JUP6…, ComputeBudget…, ATokenG…, TokenkegQ…, 1111…]`, fee detail `{signatures:1, computeUnitLimit:200000, computeUnitPriceMicroLamports:'500', rentLamports:'0'}` → `5000 + 100000 = 105000` lamports → `0.011738` USD), `F_BSC` (bsc, `pancakeswap-v3`, USDT→WBNB), `F_RH` (robinhood, `uniswap-v4`, USDG→WETH via `0x8876…0904`). Each passes unchanged.

### 13.2 Engine cases

| ID | Mutation (relative to `F0` unless stated) | Expected `code` | Key assertion (check → observed / limit) |
|---|---|---|---|
| T01 | none | `OK` | `allowed=true`; `derived` equals §13.1 values; all 33 checks `passed` or `skipped:'not-applicable'` |
| T02 | `policy.emergencyStop = true` | `EMERGENCY_STOP` | `stop.emergency` → `true` / `false`; checks 4–32 `skipped:'short-circuit'` |
| T03 | `state.emergencyStop.active = true` (policy false) | `EMERGENCY_STOP` | same |
| T04 | `policy.globalPause = true` | `GLOBAL_PAUSE` | `pause.global` → `true` / `false` |
| T05 | `state.globalPause = true` AND `state.emergencyStop.active = true` | `EMERGENCY_STOP` | precedence: `stop.emergency` is the first failure |
| T06 | `action.chain = 'ethereum'` | `SCHEMA_INVALID` | `schema.action` → `chain` / `n/a` (closed enum) |
| T07 | `policy.enabledChains = ['base']`, action from `F_SOL` | `CHAIN_UNSUPPORTED` | `chain.enabled` → `solana` / `base` |
| T08 | `action.tokenOut = { address: AERO_TOKEN, decimals: 18 }` + price entry added fresh | `TOKEN_NOT_ALLOWLISTED` | `allowlist.tokenOut` → `0x9401…8631` |
| T09 | `action.tokenIn = AERO_TOKEN` (+ price, balance) | `TOKEN_NOT_ALLOWLISTED` | `allowlist.tokenIn` |
| T10 | `action.tokenIn.address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'` (mixed case) | `SCHEMA_INVALID` | `schema.action` → `tokenIn.address` |
| T11 | `action.protocol = 'pancakeswap-v3'` | `PROTOCOL_NOT_ALLOWLISTED` | `allowlist.protocol` → `pancakeswap-v3` |
| T12 | `action.contract = AERO_ROUTER` (protocol still `uniswap-v4`) | `CONTRACT_UNKNOWN` | `allowlist.contract` → `0xcf77…4e43` |
| T13 | `amountIn = '30000000'`, quote scaled ×3 | `SIZE_EXCEEDS_MAX_TRADE` | `size.amountInUsd` → `30.000810` / `25.000000` |
| T14 | `amountIn = '24999325'` (→ ceil 25.000000) | `OK` | inclusive boundary: `size.amountInUsd` → `25.000000` / `25.000000` passed |
| T15 | `amountIn = '24999326'` (→ ceil 25.000001) | `SIZE_EXCEEDS_MAX_TRADE` | `size.amountInUsd` → `25.000001` / `25.000000` |
| T16 | `ledger.realizedPnlTodayUsd = '-20.000000'` | `DAILY_LOSS_BREACHED` | `loss.daily` → `20.056253` / `20.000000` |
| T17 | realized `-19.000000`, unrealized `-0.500000`, atDayStart `0` | `OK` | `loss.daily` → `19.556253` / `20.000000` |
| T18 | realized `-19.950000` | `DAILY_LOSS_BREACHED` | `loss.daily` → `20.006253` (worst case pushes it over) |
| T19 | `policy.dailyLoss.includeUnrealized = false`, realized `-5`, unrealized `-30` | `OK` | `loss.daily` → `5.056253` |
| T20a | realized `0`, unrealized `-30`, atDayStart `-15` | `OK` | `loss.daily` → `15.056253` (only today's move counts) |
| T20b | realized `0`, unrealized `-30`, atDayStart `0` | `DAILY_LOSS_BREACHED` | `loss.daily` → `30.056253` |
| T21 | realized `+5`, unrealized `-22`, atDayStart `0` | `OK` | `loss.daily` → `17.056253` (gains offset) |
| T22 | `ledger.deployedUsd = '95.000000'` | `TOTAL_DEPLOYED_BREACHED` | `deployed.total` → `105.000270` / `100.000000` |
| T23 | `ledger.deployedUsd = '89.999730'` | `OK` | `deployed.total` → `100.000000` / `100.000000` (inclusive) |
| T24 | `quote.minAmouhntOut` typo guard: `quote.minAmountOut = '3979401000000000'` (implied 51 bps) | `SLIPPAGE_EXCEEDS_MAX` | `slippage.implied` → `51` / `50` |
| T25 | `quote.slippageBps = 80` (implied still 30) | `SLIPPAGE_EXCEEDS_MAX` | `slippage.implied` → `80` / `50` (max of requested and implied) |
| T26 | `quote.priceImpactBps = 150` | `SLIPPAGE_EXCEEDS_MAX` | `slippage.priceImpact` → `150` / `100` |
| T27 | `feeEstimate.detail.maxFeePerGas = '2000000000'` (2 gwei × 250000 = 5e14 wei) | `FEE_EXCEEDS_MAX` | `fee.usd` → `1.250062` / `1.000000` |
| T28 | `feeEstimate.detail.maxFeePerGas = '1599921000'` → 3.99980e14 wei → `0.999999…` ceil `1.000000`? Compute: 250000 × 1599921000 = 399980250000000 wei × 2500.123456 / 1e18 = 0.99999999… → ceil `1.000000` | `OK` | `fee.usd` → `1.000000` / `1.000000` inclusive |
| T29a | `liquidity = '249999.990000'` | `LIQUIDITY_BELOW_MIN` | `liquidity.market` → `249999.990000` / `250000.000000` |
| T29b | `liquidity = '250000.000000'` | `OK` | inclusive |
| T30a | `state.cooldowns[marketKey] = NOW - 299000` | `COOLDOWN_ACTIVE` | `cooldown.market` → `299` / `300` |
| T30b | `state.cooldowns[marketKey] = NOW - 300000` | `OK` | `cooldown.market` → `300` / `300` |
| T31a | `state.cooldowns['base:0x4200…0006:0x9401…8631'] = NOW - 1000` (other market) | `OK` | unaffected |
| T31b | `state.lastAnyActionAt = NOW - 10000` | `COOLDOWN_ACTIVE` | `cooldown.global` → `10` / `30` |
| T32 | `reduceOnly = true`, tokenIn/tokenOut swapped (WETH→USDC, `amountIn = '4000000000000000'`, quote/min adjusted at 30 bps), position `{token: WETH, amount: '5000000000000000'}`, balance WETH `5000000000000000` fresh, **and** `cooldowns[marketKey] = NOW - 1000`, realized `-25` | `OK` | `size.*`, `loss.daily`, `deployed.total`, `cooldown.*` all `skipped:'not-applicable'`; `position.reduceOnly` passed |
| T33 | as T32 but `positions = []` | `REDUCE_ONLY_MISMATCH` | `position.reduceOnly` → `4000000000000000` / `none` |
| T34 | as T32 but position amount `'3000000000000000'` | `REDUCE_ONLY_MISMATCH` | → `4000000000000000` / `3000000000000000` |
| T35 | balance USDC `'9999999'` | `BALANCE_INSUFFICIENT` | `balance.tokenIn` → `9999999` / `10000000` |
| T36 | balance native `'0'` | `BALANCE_INSUFFICIENT` | `balance.gas` → `0` / `2500000000000` |
| T37 | tokenIn = native ETH, `amountIn = '4000000000000000'`, balance native exactly `'4000000000000000'` | `BALANCE_INSUFFICIENT` | `balance.tokenIn` → `4000000000000000` / `4002500000000000` (amount + fee) |
| T38 | `prices[base:USDC].at = NOW - 61000` | `DATA_STALE` | `freshness.price.tokenIn` → `61000` / `60000` |
| T39 | `quote.quotedAt = NOW - 21000` | `DATA_STALE` | `freshness.quote` → `21000` / `20000` |
| T40 | `balances[base:USDC].at = NOW - 61000` | `DATA_STALE` | `freshness.balance.tokenIn` |
| T41 | `liquidity[...].at = NOW - 301000` | `DATA_STALE` | `freshness.liquidity` → `301000` / `300000` |
| T42 | `prices[base:USDC].at = NOW + 6000` | `DATA_STALE` | `freshness.price.tokenIn` → `-6000` / `60000` (future beyond 5000 skew) |
| T43 | delete `prices[base:WETH]` | `DATA_STALE` | `freshness.price.tokenOut` → `missing`; `slippage.*` still evaluated (do not need price), `size.*` evaluated (tokenIn price present) |
| T44a | `amountIn = '0'` | `SCHEMA_INVALID` | `schema.action` → `amountIn` |
| T44b | `amountIn = '-5'` / `'1e6'` / `'10.5'` / `'010'` | `SCHEMA_INVALID` | four sub-cases |
| T44c | `tokenIn.decimals = 18` (allowlist says 6) | `SCHEMA_INVALID` | `schema.action` → `tokenIn.decimals` |
| T45 | `action.mode = 'LIVE'` (state PAPER) | `MODE_MISMATCH` | `live.modeMatch` → `LIVE` / `PAPER` |
| T46 | `action.mode = 'LIVE'`, `state.mode = 'LIVE'`, `activation.state = 'READY'` | `LIVE_NOT_ACTIVATED` | `live.activated` → `READY` / `LIVE` |
| T47 | `action.mode = 'LIVE'`, `state.mode='LIVE'`, `activation = {state:'LIVE', liveSession:{startedAt: NOW-3600000, expiresAt: NOW+82800000}}` | `OK` | identical `checks[]` to T01 except `live.*` observed values |
| T48 | `activation.liveSession.expiresAt = NOW - 1` (rest as T47) | `LIVE_NOT_ACTIVATED` | session expired |
| T49 | `action.idempotencyKey = 'e2c5f160…6920'` (vector 2, wrong for this action) | `SCHEMA_INVALID` | `schema.idempotency` → given / `1a623ec2…b9d1` |
| T50a | `F_SOL` unchanged | `OK` | `derived.amountInUsd = '5.589515'`, `feeUsd = '0.011738'` |
| T50b | `F_SOL` with `programIds` += `'Stake11111111111111111111111111111111111111'` | `CONTRACT_UNKNOWN` | `allowlist.contract` → `Stake111…` |
| T50c | `F_SOL` with `programIds` omitted | `SCHEMA_INVALID` | `schema.action` → `programIds` |
| T51 | `F_BSC` unchanged (USDT 18 decimals: `amountIn = '10000000000000000000'` = 10 USDT) | `OK` | `derived.amountInUsd` computed with 18 decimals |
| T52 | `F_RH` unchanged (USDG 6 decimals → WETH via `0x8876…0904`) | `OK` | |
| T53 | T08 mutation + T13 mutation together | `TOKEN_NOT_ALLOWLISTED` | `code` = first in order; `checks` shows `allowlist.tokenOut` **and** `size.amountInUsd` failed |
| T54a | `kind='approve'`, `tokenOut = tokenIn`, `contract = PERMIT2`, `quote = null`, `amountIn = '25000000'` | `OK` | `allowlist.contract` uses `approveSpenders`; `deployed.total`, `cooldown.market`, `slippage.*`, `liquidity.*` `skipped` |
| T54b | as T54a with `contract = UR_BASE` (in `contracts` but not in `approveSpenders`) | `CONTRACT_UNKNOWN` | |
| T54c | as T54a with `amountIn = '115792089237316195423570985008687907853269984665640564039457584007913129639935'` (2^256−1) | `SIZE_EXCEEDS_MAX_TRADE` | unlimited approvals are impossible |
| T54d | as T54a with `action.protocol='jupiter-v6'`, chain `solana` | `SCHEMA_INVALID` | approve is EVM-only |
| T55 | `kind = 'lp_add'` | `SCHEMA_INVALID` | reason `lp not enabled in this build` (until Phase 4) |
| T56 | `proposedAt = NOW - 61000` | `DATA_STALE` | `freshness.action` → `61000` / `60000` |
| T57 | `ledger.dayStartUtcMs = 1789689600000` (yesterday) | `DATA_STALE` | ledger snapshot from the previous UTC day |
| T58 | determinism: evaluate `F0` twice; evaluate with all object keys shuffled | `OK` | `canonicalJson(d1) === canonicalJson(d2) === canonicalJson(d3)` |

(T24's mutation label contains a deliberate typo guard in the description only; the field is `quote.minAmountOut`.)

### 13.3 Policy validation cases (`validatePolicy`)

| ID | Mutation of `DEFAULT_POLICY` | Expected `errors[].rule` |
|---|---|---|
| P01 | none | `ok: true`, hash is 64 hex |
| P02 | `maxAmountPerTradeUsd = '150'`, `maxTotalDeployedUsd = '100'` | `trade.leDeployed` |
| P03 | `maxSlippageBps = 1001` | `bps.slippage` |
| P04 | `tokenAllowlist.base[2].address = '0x833589fCD6…'` (mixed case) | `token.address` |
| P05 | `maxAmountPerTradeUsd = '5000'` (minLiquidity 250000 < 500000) | `liquidity.ratio` |
| P06 | `lp.minFeeThresholdUsd = '0.5'`, `lp.maxLpGasUsd = '0.5'` | `lp.claim` |
| P07 | `cooldownSeconds = -1` | `cooldown.range` |
| P08 | add `maxLeverage: 3` | zod `unrecognized_keys` (strict) |
| P09 | `maxTransactionFeeUsd = '25'` (== maxAmountPerTrade) | `fee.ltTrade` |
| P10 | `lp.maxCapitalPerLpUsd = '50'` with `allowedPools = []` | `lp.consistent` |
| P11 | `enabledChains = ['base','base']` | `chains.nonEmpty` (unique) |
| P12 | `protocolAllowlist.solana['jupiter-v6'].approveSpenders = ['JUP6…']` | `protocol.spenders` (Solana must not have spenders) |

### 13.4 Activation state-machine cases

| ID | Sequence | Expected |
|---|---|---|
| A01 | `ack` with wrong text | `400`; state `PAPER` |
| A02 | `ack` ok → `reauth` wrong ×3 | state `PAPER`, `lastFailure.step='reauth'`, lockout 15 min |
| A03 | `ack` → `reauth` ok → `risk-review` with stale hash | `409`; state `ACTIVATING` |
| A04 | A03 then correct hash → `verify` with one enabled chain holding `$4.99` funded | state `PAPER`, `lastFailure.step='walletFunded'` |
| A05 | full sequence with gas `$4.99` on bsc (limit `$5.00`) | `PAPER`, `lastFailure.step='gasPresent'` |
| A06 | full sequence, `eth_chainId` on robinhood returns `0x0` (mock) | `PAPER`, `lastFailure.step='adapterReady'`, `perChain.robinhood.chainIdOk=false` |
| A07 | full sequence passes → wait 5 min 1 s → `confirm` | `409 READY_EXPIRED`; state `PAPER` |
| A08 | full sequence → `confirm "GO LIVE"` → `PUT /v1/risk/policy` (valid change) | state `LIVE` after confirm, then `PAPER` with event `POLICY_CHANGED`; T47-style action now fails `LIVE_NOT_ACTIVATED` |
| A09 | full sequence → `confirm` → process restart | state `PAPER` on boot; `live_activation_log` has `RESTART` |
| A10 | scheduler/LLM tool tries `POST /v1/live/confirm` | route is not exposed to those principals (`403`); state unchanged |

### 13.5 Emergency-stop cases

| ID | Sequence | Expected |
|---|---|---|
| E01 | `POST /v1/emergency-stop` while LLM provider is unreachable (mock provider throws) | `200` within 100 ms; `state.emergencyStop.active=true`; next `evaluate` → `EMERGENCY_STOP` |
| E02 | create file `<ATRA_HOME>/EMERGENCY_STOP` | within 1 s: flag active, `source='file'` |
| E03 | scheduler has 3 pending jobs; stop | all 3 `CANCELLED(EMERGENCY_STOP)`; scheduler `PAUSED_EMERGENCY`; no tick for 60 s |
| E04 | action approved, executor between `build` and `sign`; stop | executor aborts before `sign`; audit row `ABORTED_EMERGENCY_STOP`; no signature produced (vault mock asserts zero calls) |
| E05 | stop → restart process | flag still active (from SQLite); if file deleted but SQLite flag set → still active |
| E06 | `clear` without re-auth / with file present / with `policy.emergencyStop=true` | `401` / `409` / `409`; after a valid clear: flag off, scheduler still `PAUSED_EMERGENCY`, mode `PAPER` |

---

## 14. Implementation layout and dependencies

```
runtime/src/risk/
  money.ts            §3 helpers (pure)
  policy.schema.ts    §4.4 zod schema + crossFieldRules
  policy.ts           normalizePolicy, validatePolicy, policyHash, DEFAULT_POLICY
  action.schema.ts    ProposedAction zod schema
  engine.ts           evaluate(): pure, no imports from node:* except nothing; sha256 via node:crypto is allowed (deterministic)
  gate.ts             RiskGate (node:sqlite), idempotency, cooldown bookkeeping
  codes.ts            RejectionCode union + check name constants
  __tests__/          vitest tables (§13)
runtime/src/live/activation.ts     §10 (the only file allowed to write state 'LIVE')
runtime/src/safety/emergency.ts    §11 (flag, file watcher, scheduler/executor hooks)
docs/specs/fixtures/risk/          risk-policy.default.json, F0.json, F_SOL.json, F_BSC.json, F_RH.json
```

| Dependency | Version (npm view, 2026-09-19) | Use |
|---|---|---|
| `zod` | `4.6.5` | schemas (`z.strictObject`, `z.int()`, `z.partialRecord`, `superRefine`) |
| `vitest` | `5.0.1` | tests |
| `typescript` | `7.0.2` | `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` |
| `viem` | `2.56.8` | adapters only (address checksum helpers are **not** used by the engine; the engine uses the lowercase regex) |
| `@solana/kit` | `8.3.0` | adapters only; base58 decode for `SolanaPubkey` validation can be a 40-line local implementation to keep the engine dependency-free |
| `node:sqlite` | built into Node 24.17 | gate persistence (`better-sqlite3` `13.0.3` fallback) |
| `node:crypto` | built-in | `createHash('sha256')` for idempotency keys and policy hash |

The engine module (`engine.ts` + `money.ts` + schemas) must have **zero** runtime dependencies other than `zod` so it can be imported by the frontend's preview UI or a Worker later without pulling chain SDKs.

---

## 15. Unknowns / UNVERIFIED (carry into implementation tickets)

1. Native USDC on Robinhood Chain (address, decimals): UNVERIFIED — not on the docs contracts page; only WETH and USDG are in defaults.
2. DexScreener chain slug for Robinhood Chain (liquidity source): UNVERIFIED. Fallback: Uniswap v4 PoolManager liquidity via RPC, or keep Robinhood PAPER-only until a liquidity source exists.
3. Whether Jupiter `/swap-instructions` can emit top-level instructions targeting programs outside `SOLANA_SYSTEM_PROGRAMS ∪ {JUP6…}` (e.g. token-ledger or DCA flows): UNVERIFIED. The adapter must fail closed; the engine already does.
4. Solana rent-exempt minimum is currently 1,488,440 lamports (live query) — it has changed historically, so it stays a live query, never a constant.
5. `z.partialRecord` semantics with enum keys under `strictObject` in zod 4.6.x: assumed per zod.dev API docs (`z.record` with enum keys is exhaustive; `partialRecord` is not). Confirm with a unit test before relying on it.
6. Paper-ledger seeding (starting balances) and the exact ledger PnL bookkeeping are owned by the ledger/paper-trading spec; this spec fixes only the field contract in §5.2.
7. Dashboard auth model (session vs passphrase, argon2id parameters) is owned by the runtime/vault spec; §10 step 2 assumes an argon2id-verified passphrase exists.

---

## 16. Sources

- Robinhood Chain connection details (chain IDs 4663 / 46630, RPC, explorer): https://docs.robinhood.com/chain/connecting
- Robinhood Chain contracts (WETH `0x0Bd7…AD73`, USDG `0x5fc5…d168`, Permit2, multicall): https://docs.robinhood.com/chain/contracts and https://docs.robinhood.com/chain/protocol-contracts/
- Robinhood Chain mainnet launch (2026-07-01): https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/
- Base mainnet chain 8453: https://chainlist.org/chain/8453 (and live `eth_chainId` on `https://mainnet.base.org`)
- BNB Smart Chain 56: https://chainlist.org/chain/56 (and live `eth_chainId` on `https://bsc-dataseed.bnbchain.org`)
- Uniswap v4 deployments (Universal Router / PoolManager / V4Quoter / Permit2 for Base, BSC, Robinhood Chain): https://developers.uniswap.org/contracts/v4/deployments
- Aerodrome Router on Base (BaseScan verified): https://basescan.org/address/0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
- PancakeSwap v3 addresses (SmartRouter, QuoterV2): https://developer.pancakeswap.finance/contracts/v3/addresses
- Jupiter Aggregator v6 program: https://solscan.io/account/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
- Jupiter Swap API (lite tier, `slippageBps`, `priceImpactPct`): https://github.com/jup-ag/jupiter-quote-api-node/blob/main/swagger.yaml and live `GET https://lite-api.jup.ag/swap/v1/quote`
- DexScreener API reference: https://docs.dexscreener.com/api/reference (live `GET https://api.dexscreener.com/token-pairs/v1/base/0x8335…`)
- Zod 4 API (strictObject, int, partialRecord, superRefine, templateLiteral): https://zod.dev/api
- Zod versioning / releases: https://zod.dev/v4/versioning , https://github.com/colinhacks/zod/releases
- viem `parseUnits` / `formatUnits` (adapter layer): https://viem.sh/docs/utilities/parseUnits
- Package versions: `npm view <pkg> version` on 2026-09-19 (zod 4.6.5, viem 2.56.8, vitest 5.0.1, decimal.js 10.6.0, @solana/kit 8.3.0, @solana/web3.js 1.99.0, better-sqlite3 13.0.3, typescript 7.0.2, uuid 14.0.2)
- Node 24.17 `node:sqlite` smoke test executed locally (`DatabaseSync(':memory:')`, no experimental warning)
- Live RPC checks executed 2026-09-19: `eth_chainId`, `eth_call symbol()/decimals()`, `eth_getCode`, `eth_gasPrice` on the three EVM public RPCs; `getGenesisHash`, `getAccountInfo(JUP6…)`, `getMinimumBalanceForRentExemption(165)`, `getRecentPrioritizationFees` on `https://api.mainnet-beta.solana.com`
