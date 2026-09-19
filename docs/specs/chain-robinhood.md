# ATRA Chain Spec — Robinhood Chain (`robinhood`)

| Field | Value |
|---|---|
| Spec ID | `chain-robinhood` |
| Spec date | 2026-09-19 (Saturday, ~15:40 UTC — all live probes below were taken at this time) |
| Status | **MAINNET LIVE** — ATRA label: `robinhood: MAINNET` (testnet label: `robinhood-testnet: TESTNET`) |
| Owner | ATRA backend (`C:\ATRA\runtime`) |
| Scope | Everything ATRA needs to treat Robinhood Chain as one of its four supported chains: identity, RPC, gas, finality, bridge, tokens, stock-token asset model, DEXes, indexers, oracles, risks, viem config, test vectors |
| Verification method | Live JSON-RPC probes against the official RPC, on-chain `eth_call`s, official docs (docs.robinhood.com), Uniswap `deployments/json/4663.json`, Chainlink reference-data-directory JSON, ethereum-lists `chains.json`, DexScreener / GeckoTerminal / CoinGecko public APIs, Robinhood `api.robinhood.com/rhj/*` REST |

Anything not marked **VERIFIED** in this document is marked **UNVERIFIED**. Where a live probe and a document disagree, the live probe is quoted and the disagreement is called out.

---

## 0. TL;DR for implementers

1. **Mainnet is live** (public mainnet 2026-07-01; public testnet 2026-02-10). Chain ID **4663** (`0x1237`). Testnet chain ID **46630** (`0xb626`), settles to Sepolia. VERIFIED by `eth_chainId` on both RPCs.
2. It is an **Arbitrum (Orbit / "Arbitrum Dedicated Blockchain") Nitro rollup** settling to **Ethereum L1**, DA via **Ethereum blobs**, native gas token **ETH** (18 dec). Client at probe time: `nitro/v3.12.0-rc.2`, **ArbOS 61**. Block time **100 ms** (measured ~11 blocks/s incl. HTTP latency).
3. **Quote/stable asset is USDG (Paxos Global Dollar), NOT USDC.** Canonical USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec, natively issued, supply ~686 M). Bridged USDC/USDT/WBTC exist but are near-empty (USDC supply ≈ 336 USDC at probe). WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.
4. **Canonical AMM = Uniswap** (v2, v3, v4, UniswapX, Universal Router all deployed; Uniswap Labs calls itself "the primary public AMM"). Addresses in §10 / Appendix C. GeckoTerminal lists **42 DEX venues** on the chain; most volume in stock tokens is on Uniswap v3/v4 + Ramses v3 + "Up V3".
5. **Stock Tokens** (194 active tickers at probe) are ERC-20 (18 dec) **beacon proxies sharing one beacon** (`0xe10b6f6b275de231345c20d14ab812db62151b00`), implement **ERC-8056 `uiMultiplier()`** for splits/dividends, are issued by **Robinhood Assets (Jersey) Ltd ("RHJ")** as tokenised debt securities, **not offered to US persons or UK residents**, and each has a **Chainlink 24/5 price feed**. Canonical registry: `GET https://api.robinhood.com/rhj/assets`.
6. **Impersonation is rampant**: DexScreener shows many pools whose base/quote is a *fake* `USDG`, `TSLA`, `NVDA`, `HOOD`, `SPY` at a different address (several with >$1 M of "liquidity" and ~$0 volume). ATRA must resolve tokens **only by address**, from a pinned allowlist + the RHJ registry, and must check the EIP-1967 beacon slot for stock tokens.
7. **Indexer slugs**: DexScreener `chainId = "robinhood"`, GeckoTerminal `network = "robinhood"`, CoinGecko `asset_platform = "robinhood"` (`chain_identifier: 4663`). All VERIFIED via API.
8. **Gas**: EIP-1559 fields present; **minimum base fee 0.02 gwei** (`ArbGasInfo.getMinimumGasPrice()`), observed ~0.063–0.067 gwei with congestion pricing; **priority fee is ignored** (FCFS sequencing, `eth_maxPriorityFeePerGas` = 0). L1 data fee is folded into the gas *units* returned by `eth_estimateGas`; at probe time `ArbGasInfo.getL1BaseFeeEstimate()` returned **0** (effectively zero L1 component) — do **not** hardcode; always `eth_estimateGas`.
9. **Finality**: sequencer soft-confirm (sub-second) → L1 batch posted (minutes; observed `safe` lag ≈ 10 min) → Ethereum-finalized (observed `finalized` lag ≈ 16 min). Canonical-bridge withdrawals: **~7-day challenge window** (L2BEAT measures 6d 8h). Sequencer reorgs are possible in theory but not observed; ATRA treats **soft-confirm as tradeable, `safe` as settled for P&L, `finalized` for withdrawals**.
10. **Explorer**: Blockscout `https://robinhoodchain.blockscout.com` (mainnet) — **its `/api` and `/api/v2` return HTTP 403 Cloudflare JS-challenge to headless clients** (curl, any UA). Testnet Blockscout API works. ATRA must not depend on the mainnet Blockscout API; use RPC + DexScreener/GeckoTerminal + Chainlink.
11. **Security posture (L2BEAT, 2026-09)**: not yet Stage 0; 2 whitelisted validators (Offchain Labs, Alchemy); BoLD dispute protocol; **instant upgrades via Safe multisig (no exit window)**; **transaction-filtering precompile (`0x…0074`) is actively used** by a compliance address. Treat as a permissioned, censorable chain in ATRA's risk model.

---

## 1. Network identity

### 1.1 Mainnet — VERIFIED

| Field | Value | Source |
|---|---|---|
| Name | Robinhood Chain | chains.json, docs |
| Chain ID | `4663` (`0x1237`) | `eth_chainId` → `0x1237` |
| Network ID | `4663` | chains.json |
| ethereum-lists `shortName` | `robinhoodchain` | chains.json |
| Native currency | Ether, `ETH`, 18 decimals | chains.json, docs |
| Parent | `eip155-1` (Ethereum mainnet), type `L2` | chains.json |
| Stack | Arbitrum Nitro (Orbit / "Arbitrum Dedicated Blockchain"), Rollup mode, DA = Ethereum blobs | docs `/chain`, `/chain/connecting`, L2BEAT |
| Client (probe) | `nitro/v3.12.0-rc.2+19e94c6-20260901T094258Z/linux-arm64/go1.25.12` | `web3_clientVersion` |
| ArbOS version | `61` (`ArbSys.arbOSVersion()` = 116; ArbOS = raw − 55) | on-chain |
| Block time | 100 ms (viem `blockTime: 100`; measured 55 blocks / ~5 s wall clock) | viem, probe |
| Block height @ probe | 67,194,946 (2026-09-19T15:37:23Z), L1 block ref 26,012,520 | `eth_getBlockByNumber` |
| Block gas limit field | `1125899906842624` (= 2^50, Arbitrum "unlimited" sentinel; per-tx limit is enforced separately, UNVERIFIED value, Arbitrum One uses 32 M) | probe |
| Public mainnet launch | 2026-07-01 | robinhood.com newsroom, Arbitrum DAO factsheet |
| Public testnet launch | 2026-02-10 | robinhood.com newsroom |
| Sequencing | First-come-first-served (no priority-fee ordering) | docs `/chain/differences-from-ethereum` |
| Chain owners (`ArbOwnerPublic.getAllChainOwners()`) | `0x2a153c6a1b66dbc930a8d7017230ab0253005c09`, `0x5eb36fd3a11f3a123c046e3bf84195bb4f5a2690` | on-chain |
| Network fee account | `0xbc5c3a7adecf54d34169fd90dbd1b7d3142df067` | on-chain |
| Scheduled ArbOS upgrade @ probe | none (`getScheduledUpgrade()` = (0, 0)) | on-chain |

### 1.2 Testnet — VERIFIED

| Field | Value |
|---|---|
| Name | Robinhood Chain Testnet |
| Chain ID | `46630` (`0xb626`) — `eth_chainId` → `0xb626` |
| ethereum-lists `shortName` | `rh-testnet` |
| Native currency | Sepolia Ether, `ETH`, 18 dec (`slip44: 1`) |
| Parent | `eip155-11155111` (Sepolia) |
| Block height @ probe | 121,725,998 |
| Explorer | `https://explorer.testnet.chain.robinhood.com` (Blockscout; **API works headless**: `/api/v2/stats` returned JSON) |
| Faucets | chains.json lists none. Third-party: `https://faucets.chain.link/robinhood-testnet`, `https://faucet.quicknode.com/robinhood/testnet`, `https://faucet.chainstack.com/robinhood-chain-testnet-faucet` (UNVERIFIED amounts/limits); or bridge Sepolia ETH via `https://portal.arbitrum.io/bridge` |

### 1.3 Registry entries (ethereum-lists/chains `chains.json`, fetched 2026-09-19) — VERIFIED verbatim

```json
{
  "name": "Robinhood Chain",
  "chain": "ETH",
  "rpc": [
    "https://rpc.mainnet.chain.robinhood.com",
    "https://robinhood-rpc.publicnode.com",
    "wss://robinhood-rpc.publicnode.com",
    "https://rpc.arrowrpc.com",
    "https://rpc.ordofi.network",
    "wss://rpc.ordofi.network"
  ],
  "faucets": [],
  "nativeCurrency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
  "infoURL": "https://docs.robinhood.com/chain",
  "shortName": "robinhoodchain",
  "chainId": 4663,
  "networkId": 4663,
  "explorers": [
    { "name": "robinscan", "url": "https://robinscan.io", "icon": "robinscan", "standard": "EIP3091" },
    { "name": "blockscout", "url": "https://robinhoodchain.blockscout.com", "icon": "blockscout", "standard": "EIP3091" },
    { "name": "hoodscan", "url": "https://hoodscan.co", "standard": "EIP3091" },
    { "name": "stonkscan", "url": "https://stonkscan.io", "standard": "EIP3091" }
  ],
  "status": "active",
  "parent": {
    "type": "L2",
    "chain": "eip155-1",
    "bridges": [ { "url": "https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum" } ]
  }
}
```

```json
{
  "name": "Robinhood Chain Testnet",
  "title": "Robinhood Chain Testnet",
  "chain": "ETH",
  "rpc": [
    "https://rpc.testnet.chain.robinhood.com/rpc",
    "https://robinhood-sepolia-rpc.publicnode.com",
    "wss://robinhood-sepolia-rpc.publicnode.com"
  ],
  "faucets": [],
  "nativeCurrency": { "name": "Sepolia Ether", "symbol": "ETH", "decimals": 18 },
  "infoURL": "https://docs.robinhood.com/chain/",
  "shortName": "rh-testnet",
  "chainId": 46630,
  "networkId": 46630,
  "slip44": 1,
  "explorers": [
    { "name": "blockscout", "url": "https://explorer.testnet.chain.robinhood.com", "icon": "blockscout", "standard": "EIP3091" }
  ],
  "parent": { "type": "L2", "chain": "eip155-11155111", "bridges": [ { "url": "https://portal.arbitrum.io/bridge" } ] }
}
```

chainlist.org pages: `https://chainlist.org/chain/4663`, `https://chainlist.org/chain/46630`. Note: `https://robinscan.io` resolved at probe time to a Vercel `DEPLOYMENT_NOT_FOUND` page — **do not use robinscan**.

---

## 2. RPC endpoints

### 2.1 Mainnet — probe results 2026-09-19

| Endpoint | Type | Auth | `eth_chainId` | Notes |
|---|---|---|---|---|
| `https://rpc.mainnet.chain.robinhood.com` | HTTP | none | `0x1237` ✅ | **Official public**, "rate-limited" per docs. Batch JSON-RPC ✅. `eth_getLogs`: **max 10,000 matching logs per query** (error: `logs matched by query exceeds limit of 10000`); a 50k-block range returned `Too Many Requests`. |
| `https://robinhood-rpc.publicnode.com` | HTTP | none | `0x1237` ✅ | Allnodes/PublicNode. **Archive/`eth_getLogs` over older ranges requires a token** (`Archive requests require a personal token`). Fine for head reads. |
| `wss://robinhood-rpc.publicnode.com` | WSS | none | handshake 101 ✅ | Use for `newHeads` subscriptions. |
| `https://rpc.ordofi.network` | HTTP | none | `0x1237` ✅ | Community. |
| `wss://rpc.ordofi.network` | WSS | none | handshake 101 ✅ | Community. |
| `https://robinhood.drpc.org` | HTTP | none (public tier) | `0x1237` ✅ | dRPC public endpoint. |
| `https://rpc.arrowrpc.com` | HTTP | none | ❌ `error code: 1033` (Cloudflare tunnel down) | **Exclude** until it recovers. |
| `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}` | HTTP | BYOK | (not probed) | **Recommended by Robinhood docs**; Alchemy free tier supports the chain (Alchemy blog). |
| `wss://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}` | WSS | BYOK | (not probed) | |
| `wss://feed.mainnet.chain.robinhood.com` | Sequencer feed | none | plain-WS handshake → HTTP 400 | This is the **Nitro sequencer feed** (broadcast protocol), not JSON-RPC. Requires the Nitro feed client protocol; UNVERIFIED for third-party consumption. Not used by ATRA v1. |
| `https://sequencer.mainnet.chain.robinhood.com` | Sequencer endpoint | none | (not probed) | Documented in `/chain/connecting`. UNVERIFIED whether it accepts `eth_sendRawTransaction` directly. ATRA sends via the public RPC. |

Other providers named by Robinhood docs (BYOK, UNVERIFIED URLs): Chainstack, QuickNode, Blockdaemon, dRPC, Validation Cloud, GetBlock.

### 2.2 Testnet

| Endpoint | `eth_chainId` |
|---|---|
| `https://rpc.testnet.chain.robinhood.com` | `0xb626` ✅ |
| `https://rpc.testnet.chain.robinhood.com/rpc` | `0xb626` ✅ (chains.json form) |
| `https://robinhood-sepolia-rpc.publicnode.com` | `0xb626` ✅ |
| `wss://robinhood-sepolia-rpc.publicnode.com` | (not probed) |
| `https://robinhood-testnet.g.alchemy.com/v2/{API_KEY}` / `wss://…` | BYOK |
| `wss://feed.testnet.chain.robinhood.com`, `https://sequencer.testnet.chain.robinhood.com` | documented, not probed |

### 2.3 ATRA transport policy (normative)

```text
ROBINHOOD_RPC_URLS (ordered, keyless default):
  1. https://rpc.mainnet.chain.robinhood.com      # official; head + logs ≤ 10k matches
  2. https://robinhood.drpc.org                    # public tier
  3. https://rpc.ordofi.network                    # community
  4. https://robinhood-rpc.publicnode.com          # head reads only (no archive logs)
ROBINHOOD_WSS_URLS: wss://robinhood-rpc.publicnode.com, wss://rpc.ordofi.network
BYOK override: ROBINHOOD_RPC_URL / ROBINHOOD_WSS_URL (e.g. Alchemy) → prepended to the lists.
```

* Every endpoint is **validated at boot** by `eth_chainId === 0x1237` (or `0xb626`); mismatch ⇒ endpoint disabled + logged (this is also the "never substitute another chain" guard).
* Log scanning: chunk ≤ 1,000 blocks for busy contracts (USDG Transfer over 1,000 blocks returned 8,975 logs — close to the 10k cap) and back off on `Too Many Requests`. Prefer indexers (§12) for history.
* With 100 ms blocks, a `newHeads` WSS subscription yields ~10 events/s. ATRA's price loop should sample **at most every 1–2 s** (poll `latest` via HTTP) rather than react to every head.

---

## 3. Block explorers and their APIs

| Explorer | URL | API | Headless status (probe) |
|---|---|---|---|
| Blockscout (official, mainnet) | `https://robinhoodchain.blockscout.com` | `/api` (Etherscan-compatible), `/api/v2/*` | **HTTP 403 + Cloudflare "Just a moment…" challenge** for curl with default and Chrome UAs. Browser use only. |
| Blockscout (testnet) | `https://explorer.testnet.chain.robinhood.com` | same | ✅ `/api/v2/stats` returns JSON (avg block time reported 293 ms on testnet, gas ~0.19 gwei) |
| Bitquery | `https://explorer.bitquery.io/robinhood` | Bitquery GraphQL (BYOK) | UNVERIFIED |
| robinscan.io / hoodscan.co / stonkscan.io | listed in chains.json | — | robinscan returned Vercel `DEPLOYMENT_NOT_FOUND`; the others UNVERIFIED |

**Normative:** ATRA's `explorerUrl` for tx/address links = Blockscout. ATRA **must not** make server-side calls to the mainnet Blockscout API on any critical path; if a future contract-verification lookup is needed, treat 403 as "unavailable", never as an error that blocks trading.

---

## 4. viem configuration (exact)

viem `2.56.8` (latest at spec time; `npm view viem version`) **already ships** `robinhood` and `robinhoodTestnet` in `viem/chains`, verbatim:

```ts
// viem/_esm/chains/definitions/robinhood.js  (viem 2.56.8)
export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockTime: 100,
  rpcUrls: {
    default: {
      http: ['https://rpc.mainnet.chain.robinhood.com', 'https://rpc.ordofi.network'],
      webSocket: ['wss://rpc.ordofi.network'],
    },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com', apiUrl: 'https://robinhoodchain.blockscout.com/api' },
  },
  contracts: { multicall3: { address: '0xca11bde05977b3631167028862be2a173976ca11' } },
})
// robinhoodTestnet: id 46630, nativeCurrency 'Sepolia Ether', http ['https://rpc.testnet.chain.robinhood.com'],
//   explorer https://explorer.testnet.chain.robinhood.com (+ /api), multicall3 same address, testnet: true
```

Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11` has code on **both** mainnet and testnet (VERIFIED `eth_getCode`).

**ATRA's own definition** (pin it; do not rely on viem's RPC list, and add the Arbitrum-specific fields ATRA needs). File: `C:\ATRA\runtime\src\chains\robinhood.ts`.

```ts
import { defineChain } from 'viem'

export const ROBINHOOD_CHAIN_ID = 4663 as const
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630 as const

export const robinhood = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  network: 'robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockTime: 100, // ms — Arbitrum Nitro, measured 2026-09-19
  rpcUrls: {
    default: {
      http: [
        'https://rpc.mainnet.chain.robinhood.com',
        'https://robinhood.drpc.org',
        'https://rpc.ordofi.network',
        'https://robinhood-rpc.publicnode.com',
      ],
      webSocket: ['wss://robinhood-rpc.publicnode.com', 'wss://rpc.ordofi.network'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://robinhoodchain.blockscout.com',
      apiUrl: 'https://robinhoodchain.blockscout.com/api', // NOTE: Cloudflare-challenged for headless clients
    },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
    // Arbitrum precompiles (identical on every Nitro chain)
    arbSys: { address: '0x0000000000000000000000000000000000000064' },
    arbGasInfo: { address: '0x000000000000000000000000000000000000006C' },
    nodeInterface: { address: '0x00000000000000000000000000000000000000C8' },
    // Canonical assets (see §9)
    weth9: { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' },
    usdg: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' },
    // Uniswap (see §10)
    uniswapV3Factory: { address: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' },
    uniswapV3QuoterV2: { address: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' },
    uniswapV3SwapRouter02: { address: '0xcaf681a66d020601342297493863e78c959e5cb2' },
    uniswapV4PoolManager: { address: '0x8366a39cc670b4001a1121b8f6a443a643e40951' },
    uniswapV4Quoter: { address: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' },
    uniswapV4StateView: { address: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' },
    uniswapUniversalRouter: { address: '0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99' },
    permit2: { address: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
    // Stock-token shared beacon (see §9.4) — used to authenticate real Robinhood Stock Tokens
    stockTokenBeacon: { address: '0xe10b6f6b275de231345c20d14ab812db62151b00' },
  },
  fees: {
    // FCFS sequencer: priority fee is ignored. Keep it 0; bump only maxFeePerGas.
    defaultPriorityFee: 0n,
  },
  sourceId: 1, // settles to Ethereum mainnet
})

export const robinhoodTestnet = defineChain({
  id: ROBINHOOD_TESTNET_CHAIN_ID,
  name: 'Robinhood Chain Testnet',
  network: 'robinhood-testnet',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  blockTime: 100,
  rpcUrls: {
    default: {
      http: ['https://rpc.testnet.chain.robinhood.com', 'https://robinhood-sepolia-rpc.publicnode.com'],
      webSocket: ['wss://robinhood-sepolia-rpc.publicnode.com'],
    },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com', apiUrl: 'https://explorer.testnet.chain.robinhood.com/api' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
    weth9: { address: '0x7943e237c7F95DA44E0301572D358911207852Fa' },
  },
  fees: { defaultPriorityFee: 0n },
  sourceId: 11155111,
  testnet: true,
})
```

Client construction (fallback transport, chain-ID guard):

```ts
import { createPublicClient, fallback, http, webSocket } from 'viem'
import { robinhood } from './chains/robinhood'

export const robinhoodClient = createPublicClient({
  chain: robinhood,
  transport: fallback(
    robinhood.rpcUrls.default.http.map((u) => http(u, { batch: true, timeout: 10_000, retryCount: 2 })),
    { rank: true },
  ),
  pollingInterval: 1_000, // do not poll every 100 ms block
})

// Boot guard — ATRA never substitutes another chain
export async function assertRobinhood(client: typeof robinhoodClient) {
  const id = await client.getChainId()
  if (id !== 4663) throw new Error(`robinhood: RPC returned chainId ${id}, expected 4663 — endpoint disabled`)
}
```

---

## 5. Protocol contracts (rollup + canonical bridge) — VERIFIED from docs `/chain/protocol-contracts`

### 5.1 Ethereum L1 side

| Contract | Mainnet (Ethereum) | Testnet (Sepolia) |
|---|---|---|
| Rollup | `0x23A19d23e89166adedbDcB432518AB01e4272D94` | `0xdc5F8E399DBd8a9F5F87AeC4C23Beb12431b386D` |
| Sequencer Inbox | `0xBd0D173EEb87D57A09521c24388a12789F33ba96` | `0xA0D9dB3DC9791D54b5183C1C1866eFe1eCA7D414` |
| Delayed Inbox | `0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D` | `0xF2939afA86F6f933A3CE17fCAB007907B6b0B7a4` |
| Bridge | `0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3` | `0x96295BDad104eaD97cC08797b3dC68efF59CcF30` |
| Outbox | `0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9` | `0x8D180Caf588f3Da027BEf1F42a106Da93F90b166` |
| Core Proxy Admin / L1 Proxy Admin | `0x1232813BDd40aa9d53066A880dE78a4Be70B90FD` | `0x20d5d542c1bF0a3c295524Eaef336fC07e890622` |
| L1 Gateway Router | `0x6a2E3a1e16FC29f27Ce61429746D558d656975bB` | `0xF6F11aAEE80875776C264d93B37B34cE437382D1` |
| L1 ERC20 Gateway | `0x85001CC4867C5e1C22dA4B79BB8852B9e2a06da0` | `0x52C2976cbDEf48BcC51d07d3c523769F76ECBd09` |
| L1 Custom Gateway | `0x9368EAEbFe6E063C69dcF8126711A6997E0eCeE1` | `0xFB4aa8024F70B00121723A9C923BaD0Dd2dFaf8F` |
| L1 WETH Gateway | `0xF7e12b9614b509C747ab4423bC4ACF923759Cf1B` | `0x8f8A6799F2b1978c6586318543c73D8Fb12f218f` |
| L1 WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` |
| L1 Multicall | `0x7cdCB0Cc61f47B8Dd8f47C5A29edaDd84a1BDf5e` | — |

### 5.2 Robinhood Chain (L2) side

| Contract | Mainnet (4663) | Testnet (46630) |
|---|---|---|
| L2 Gateway Router | `0x1E324B9316138CA9a73F960213621AD1aaf01B89` | `0x77bF00A6A90c600f214b34BAFBB7918c0cF113A8` |
| L2 ERC20 Gateway | `0xfd9b17206278C16DdaacF6AC8f05dBf97EdCb31e` | `0x8689aFB9086734e12beA6b5DF541a1da252Ea32a` |
| L2 Custom Gateway | `0x912285144fC0f6e89d3Ed16F5Ab72f87A1878959` | `0xE4EE9C15e2cA44136796342e31b67d953E67a70b` |
| L2 WETH Gateway | `0x1D187C3E2dA52D72BC9C41e3AbA0fdFa6a7bF055` | `0x5A8F55202A625D12FFCb76F857FE4563bC8Ce413` |
| **L2 WETH (WETH9)** | **`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`** | `0x7943e237c7F95DA44E0301572D358911207852Fa` |
| L2 Proxy Admin | `0xa3Acd31AFb851B4eB9DAD00F5204c01D924267dF` | `0xE743e696B00789Ef489cF617477771764E9283a0` |
| L2 Multicall (Arbitrum-style) | `0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1` | `0xa432504b6F04Cafe775b09D8AA92e8dbe41Ec7a8` |
| Multicall3 (canonical) | `0xcA11bde05977b3631167028862bE2a173976CA11` (VERIFIED code present) | same |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same |

### 5.3 Arbitrum precompiles (both networks; `eth_getCode` returns `0xfe` sentinel)

`ArbSys 0x…0064`, `ArbInfo 0x…0065`, `ArbAddressTable 0x…0066`, `ArbFunctionTable 0x…0068`, `ArbOwnerPublic 0x…006b`, `ArbGasInfo 0x…006C`, `ArbAggregator 0x…006D`, `ArbRetryableTx 0x…006E`, `ArbStatistics 0x…006F`, `ArbOwner 0x…0070`, `ArbWasm 0x…0071`, `ArbWasmCache 0x…0072`, `NodeInterface 0x…00C8`, and (not in Robinhood's docs, present on-chain with code `0xfe`) `0x…0073` and **`ArbFilteredTransactionsManager 0x…0074`** (ArbOS ≥ 60; `isTransactionFiltered(bytes32)` selector `0x…` computed below returns `0` for a zero hash — VERIFIED callable).

---

## 6. EVM differences that affect a trading agent (docs `/chain/differences-from-ethereum` + probes)

| Topic | Behaviour | ATRA rule |
|---|---|---|
| `block.number` (in-EVM) | "returns an estimate of the **L1** (Ethereum) block number, not the Robinhood Chain block number" | Never use in-contract `block.number` for L2 timing. Use `eth_blockNumber` / `ArbSys.arbBlockNumber()` (selector `0xa3b1b31d`; returned 67,198,621 = the L2 height) |
| Block JSON extra fields | `l1BlockNumber`, `sendRoot`, `sendCount`, `mixHash` present in `eth_getBlockByNumber` | ATRA records `l1BlockNumber` alongside L2 height in fills |
| `block.prevrandao`/`difficulty` | constant; not random | n/a |
| `blockhash(n)` | only reliable for recent blocks | n/a |
| `block.coinbase` | network fee account | n/a |
| Ordering | FCFS by sequencer arrival; priority fee does not reorder | `maxPriorityFeePerGas = 0` |
| Contract size | 96 KB code / 192 KB initcode | n/a |
| L1→L2 msg sender | aliased address (+ fixed offset) | n/a |
| Tx types | Arbitrum types (retryables, deposits, internal) appear in blocks | ATRA's receipt parser must tolerate `type` values `0x64`–`0x6a` (100–106) and `0x7e`-style internal txs; ignore unknown types rather than throw |
| Transaction filtering | `ArbFilteredTransactionsManager` (`0x…0074`) lets an authorised filterer force-fail specific tx hashes, **including L1 force-included ones** (L2BEAT). Third-party analysis reports the compliance filterer `0xebDc18A1F5C42fC25552eA233fAcf4054DF224b7` has registered thousands of hashes since 2026-06-30 (UNVERIFIED count) | ATRA must handle "tx mined but `status: 0x0` with no revert reason" as a possible filtered tx; never retry blindly |

---

## 7. Gas and fee model

### 7.1 Documented model (docs `/chain/gas-and-fees`)

* Two components: **L2 execution fee** (gas used × L2 gas price) + **L1 data fee** (posting calldata to Ethereum; scales with calldata size and Ethereum congestion). "Standard fee estimation (`eth_estimateGas`, wallet fee previews) automatically accounts for both." (Arbitrum implementation detail: the L1 component is expressed as **extra gas units**, priced at the L2 base fee.)
* Native token ETH.

### 7.2 Live values (2026-09-19T15:40Z) — VERIFIED

| Probe | Result |
|---|---|
| `eth_gasPrice` | `0x3e1d5e0` = 65,000,000 wei = **0.065 gwei** |
| `baseFeePerGas` (latest block) | 62,988,000 wei = 0.063 gwei |
| `eth_maxPriorityFeePerGas` | `0x0` |
| `eth_feeHistory(5, latest, [50])` | rewards all `0x0`; baseFee 0.0649→0.0663 gwei drifting; `gasUsedRatio` 1,1,1,1,0.22 (ratio is vs. Arbitrum speed-limit target, not the 2^50 header limit) |
| `ArbGasInfo.getMinimumGasPrice()` (`0xf918379a`) | **20,000,000 wei = 0.02 gwei** (floor) |
| `ArbGasInfo.getPricesInWei()` (`0x41b247a8`) | perL2Tx 0; **perL1CalldataByte 0**; perStorageAllocation 1,346.44 gwei; perArbGasBase 0.02 gwei; perArbGasCongestion 0.047322 gwei; perArbGasTotal 0.067322 gwei |
| `ArbGasInfo.getL1BaseFeeEstimate()` (`0xf5d6ded7`) | **0 wei** |
| `ArbGasInfo.getL1PricingSurplus()` | 134,964,675,565,782,520 wei (≈ 0.135 ETH surplus) |
| `ArbGasInfo.getPerBatchGasCharge()` | 210,000 |
| `ArbGasInfo.getL1RewardRate()` | 10 |
| `eth_estimateGas` (plain ETH transfer, 1 wei) | `0x52e9` = **21,225** gas (21,000 + 225 L1/overhead units) |
| Uniswap v3 `QuoterV2.quoteExactInputSingle` WETH→USDG 1 ETH @ fee 500 | `gasEstimate` 139,261 |

**Interpretation (state as observed, not as a guarantee):** at probe time the chain's L1 pricing component was effectively **zero** (`perL1CalldataByte = 0`, `getL1BaseFeeEstimate = 0`), i.e. users paid essentially only L2 execution at ~0.065 gwei. A Uniswap swap (~140k–250k gas) therefore cost ≈ 0.00001–0.00002 ETH (≈ $0.03–$0.05 at ETH ≈ $2,640). This can change at any time via chain-owner parameters or Ethereum blob-market pressure (a Base traffic spike in 2026 was reported to have delayed Robinhood Chain batch posting — UNVERIFIED article).

### 7.3 ATRA fee rules (normative)

```text
gasLimit          = ceil(eth_estimateGas × 1.25)          # L1 component is inside the units; NEVER hardcode 21000/200000
maxPriorityFeePerGas = 0                                  # FCFS; nonzero tip buys nothing
maxFeePerGas      = max(2 × latest.baseFeePerGas, 0.05 gwei)  # floor is 0.02 gwei; 2× covers congestion drift within seconds
fee sanity        : abort if estimated fee > 0.001 ETH for a single swap (≈ 10× the observed cost) → flag "gas anomaly"
```

Cost attribution in PAPER mode: `feeWei = gasUsed × effectiveGasPrice` from the receipt (Arbitrum receipts also expose `gasUsedForL1`; record it when present).

---

## 8. Finality, reorgs, and confirmation policy

### 8.1 Documented stages (docs `/chain/transaction-finality`)

1. **Soft confirmation (sequencer)** — "sub-second"; "the sequencer has committed to your transaction's inclusion and ordering. Reversible only if the sequencer posts a batch with a different transaction order."
2. **L1 batch posted** — "within minutes"; "ordering is now fixed — your transaction can only be reorganized if Ethereum itself reorganizes."
3. **Ethereum finality** — "approximately 13 minutes after posting"; irreversible.
4. **Withdrawals via canonical bridge** — "7-day challenge period" (L2BEAT measures the configured window as **6d 8h**).

Recommendation from docs: soft confirmation for routine interactions; wait for L1 posting or Ethereum finality for high-value operations.

### 8.2 Observed block-tag lag — VERIFIED (2026-09-19T15:43Z)

| Tag | L2 height | `l1BlockNumber` | Age |
|---|---|---|---|
| `latest` | 67,197,249 | 26,012,520 | 2 s |
| `safe` (batch posted to L1) | 67,191,262 | 26,012,470 | **606 s (~10 min)** |
| `finalized` (L1 finalized) | 67,187,545 | 26,012,438 | **980 s (~16 min)** |

### 8.3 ATRA confirmation policy (normative)

| Purpose | Requirement |
|---|---|
| Consider a fill "executed" (position open, UI shows fill) | receipt with `status: 0x1` at `latest` (soft confirmation) |
| Mark P&L as "settled" / allow re-use of proceeds for another trade | tx block ≤ `safe` **or** ≥ 30 s elapsed and block still canonical (`eth_getBlockByNumber(hash)` matches) |
| Anything that crosses the bridge or is reported to the user as final | tx block ≤ `finalized` |
| Reorg detection | ATRA keeps the last 600 block hashes (60 s); on `newHeads` parent-hash mismatch → mark affected fills `REORGED`, re-check receipts. Sequencer reorgs are rare on Nitro but not impossible (e.g., sequencer restart before batch posting). |
| Sequencer outage | if `latest` age > 30 s (300 missed blocks) ⇒ `robinhood: DEGRADED` → no new orders; resume when age < 5 s for 10 s. (A Chainlink L2 Sequencer Uptime Feed for Robinhood is **not** listed in Chainlink docs — UNVERIFIED whether one exists; do not depend on it.) |

---

## 9. Assets

### 9.1 Native + core tokens (mainnet) — VERIFIED on-chain (`name()/symbol()/decimals()/totalSupply()`)

| Asset | Address | Dec | Verified metadata | Notes |
|---|---|---|---|---|
| ETH (native) | — | 18 | — | gas token |
| **WETH** | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 18 | `WETH`/`WETH`, supply 36,527.77 WETH | canonical L2 WETH (bridge WETH gateway target) |
| **USDG** (Paxos Global Dollar) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | **6** | `Global Dollar`/`USDG`, supply 686,038,813.379541 | **Natively issued** by Paxos on Robinhood Chain (globaldollar.com newsroom; not the bridge-derived address, `l1Address()` reverts; `owner()` = `0xcfa0388f5ddf905fdc08c45c716c15dc10a14c6f`). Chainlink USDG/USD = $0.999923 at probe. **ATRA quote asset for `robinhood`.** |
| USDC (Arbitrum-bridged, **not** Circle-native) | `0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8` | 6 | `USD Coin`/`USDC`, supply **336.536993** | Derived via `L2GatewayRouter.calculateL2TokenAddress(0xA0b8…eB48)` and verified by `eth_getCode` (835 bytes, standard `L2GatewayToken`). Effectively unused — **do not quote in USDC on this chain**. |
| USDT (bridged) | `0xe246bc49b0598d7cd9f0ead48b885034f1254380` | 6 | `Tether USD`/`USDT`, supply 2,584.241238 | same derivation; negligible liquidity |
| WBTC (bridged) | `0x6bac06600d220ac5ac281ad1f504d2cf0f90f6e6` | 8 | `Wrapped BTC`/`WBTC`, supply 0.15628711 | negligible |
| Bridge-derived USDG (what the router *would* mint for L1 USDG `0xe343…491D`) | `0xfd338ec5f42f3c0551a0a8f6c687908892ad75a6` | — | **no code** | proves USDG is native, not bridged |

Chainlink also publishes feeds on this chain for `cbBTC`, `BTC.B`, `LBTC`, `weETH`, `wstETH`, `USDe`, `USDS`, `EURC`, `LINK`, `ENA`, `syrupUSDC/USDT/USDG` (Appendix B) — implying those tokens are present, **but their L2 addresses are UNVERIFIED here**; ATRA v1 allowlists only WETH + USDG + Stock Tokens.

### 9.2 Impersonation warning — VERIFIED via DexScreener

DexScreener search on 2026-09-19 returned pools such as:

* `USDG` at `0xeC90adc7157d68d9213a88627b66956950374a3e`, `0xAc1334…51b1`, `0x65ABEb…c0d5` (4.27 M "liquidity", $0.15 24h volume), … — **fake USDG** paired with WETH on Uniswap v3.
* `TSLA` at `0x745f78…7ba3`, `0x4cE288…1e18`; `NVDA` at `0xAaeA5E…43C9`; `SPY` at `0xe9Db5E…f743` — fake stock tokens.
* `HOOD` at `0x32aC8C1D7672667D5EbdEa22935F7B06fC8D496f` (name `HOOD`, 2,056-byte contract) is **not** in the RHJ registry (registry has no `HOOD` ticker at all) — it is a memecoin used as a quote token by other memecoins.
* `AI` at `0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18` = "Artificial Inu" (memecoin), paired with real NVDA with $6.4 M liquidity — symbol collision with a plausible ETF ticker.

**Normative:** ATRA resolves symbols → addresses **only** from (a) the pinned table in §9.1, (b) the RHJ registry (§9.3). Any pool whose base or quote is not in that set is `UNTRUSTED` and never traded, regardless of DexScreener/GeckoTerminal liquidity numbers. Stock tokens additionally pass the beacon check in §9.4.

### 9.3 Stock Tokens — asset model (docs `/chain/stock-tokens`, `/chain/building-with-stock-tokens`, `/chain/stock-token-apis`; on-chain probes)

| Property | Value |
|---|---|
| Issuer | **Robinhood Assets (Jersey) Limited ("RHJ")** — Stock Tokens are "tokenised debt securities" giving "economic exposure to underlying securities" and "do not grant investors any legal or beneficial rights" in the shares |
| Eligibility | "may not be offered, sold, or delivered … in the United States … to U.S. Persons"; **UK residents also prohibited**; "available in more than 120 countries, availability varies by jurisdiction" |
| Primary market | Only Authorised Participants (at issuance: **BBVI**) mint/redeem via RHJ after KYB. Tokenisation window: **Monday 02:00 CET/CEST – Saturday 02:00 CET/CEST**. Secondary (DEX) trading is 24/7 and permissionless on-chain. |
| Standard | ERC-20, **18 decimals** (`tokenDecimals: 18` in registry, VERIFIED `decimals()` = 18 on AAPL) |
| Corporate actions | **ERC-8056 "Scaled UI Amount"**: raw balances never rebase; `uiMultiplier()` (18-dec fixed point) scales the *displayed* amount. `underlying shares = raw × uiMultiplier / 1e18`. Also `balanceOfUI(address)`, `totalSupplyUI()`, `newUIMultiplier()`, `effectiveAt()`, event `UIMultiplierUpdated(uint256 old, uint256 new, uint256 effectiveAtTimestamp)`. Supported now: forward/reverse splits, cash dividends, stock dividends. Planned: spin-offs, mergers, redemptions, name changes, worthless removal, rights, unit splits. |
| Verified AAPL values | `uiMultiplier()` = `1000566080061092436` (1.000566…; matches registry `currentMultiplier`); `newUIMultiplier()` same; `effectiveAt()` = 1789395310 (2026-08-14T15:12:46Z); `totalSupplyUI()` = 16,324,178.5…; `paused()` = false; `oraclePaused()` = false |
| Pricing | Every Stock Token has a **Chainlink `AggregatorV3Interface` feed** (8 dec) on Robinhood Chain: `Token Price = Underlying Equity Market Price × Multiplier` (multiplier already applied — **do not multiply again**). Feeds run **24/5** (regular, pre-, post-market, overnight) and honour an `oraclePaused()` flag on the token. Heartbeat 86,400 s, deviation 0.5 %. **SVR (Smart Value Recapture) enabled.** |
| Verified feed reads | `Robinhood AAPL / USD` (`0x6B22A786bAa607d76728168703a39Ea9C99f2cD0`): answer 33,538,474,720 = **$335.3847**, `updatedAt` 1789744288 → **24.6 h stale at probe (Saturday)** — expected for 24/5. `ETH / USD` (`0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`): $2,639.89, 6.2 h old. `USDG / USD` (`0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`): $0.999923, 10 min old. |
| REST registry (no auth observed) | `GET https://api.robinhood.com/rhj/assets` (60 req/s doc limit) → `{ "assets": [ { id, tokenSymbol, tokenName, deployments:[{contractAddress, chainId:4663, networkName}], currentMultiplier, pendingMultiplier, status, logoUrl, tradingCapabilities:{market,extended,overnight → {whole,fractional}}, tokenDecimals, isin } ] }` — **194 assets, all `ASSET_STATUS_ACTIVE`, all on chain 4663** at probe. |
| REST prices | `GET https://api.robinhood.com/rhj/prices/{SYMBOL}` (15 s cache) → `{ "quotes":[{ tokenSymbol, deployments, bid, ask, currency:"USD", dailyTradingVolume, isTradingHalt, generatedAt, dailyHigh, dailyLow, mintBurnTokenVolume, mintBurnUsdVolume }] }`. **Returns raw underlying-equity bid/ask, NOT multiplier-adjusted** (the Chainlink feed is). Sample AAPL: bid 334.76 / ask 334.94 at 2026-09-19T15:38:53Z. |
| REST corporate actions | `GET https://api.robinhood.com/rhj/corporate-actions` (1 h cache) |
| Transfer restrictions | Official docs: none described ("standard ERC-20 … any compatible wallet"). Third-party code analyses (dev.to, Beosin) report an `onlyNotBlocked` modifier backed by an external `IAccessControlsRegistry.isBlocked(account)`, a per-contract `paused` flag and an `OraclePausable` layer, and **13 access-control roles** — **UNVERIFIED by ATRA** (calling `isBlocked(address)` / `isBlacklisted(address)` on the token reverts, consistent with the check living in a separate registry). Treat as: **default-open, revocable per address, pausable per token and globally.** |
| Upgradeability | **Beacon proxy**: EIP-1967 beacon slot on AAPL/NVDA/TSLA/SPY all = `0xe10b6f6b275de231345c20d14ab812db62151b00`; `beacon.implementation()` = `0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2` — VERIFIED. One beacon upgrade changes **every** Stock Token at once (unified kill-switch). |
| Asset mix | 194 tickers: US equities + 17 ETF-like (`SPY GLD SKHY SGOV BND VTI EWY SMH XLK USO SHY SCHD EWT SLV SPMO SOXX INDA`). 28 tokens had a non-1.0 multiplier at probe (dividend/split history). |

**Key Stock Token addresses (mainnet, VERIFIED via registry + on-chain; full 194-row list in Appendix A):**

| Ticker | Token address | Chainlink feed (USD, 8 dec) | Multiplier @ probe |
|---|---|---|---|
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | 1.000566080061092436 |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | 1.000775159164630595 |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | `0x4A1166a659A55625345e9515b32adECea5547C38` | 1.0 |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | `0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E` | 1.000412952576205964 |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | `0xF6f373a037c30F0e5010d854385cA89185AE638b` | 1.000193924414112587 |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | `0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C` | 1.0 |
| META | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | `0x7C38C00C30BEe9378381E7B6135d7283356D71b1` | 1.0 |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | `0x319724394D3A0e3669269846abE664Cd621f9f6A` | 1.001717991187472003 |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | `0x80901d846d5D7B030F26B480776EE3b29374C2ae` | 1.0 |
| MSTR | `0xec262a75e413fAfD0dF80480274532C79D42da09` | `0x396118bdFB181e6240E74D243F266B061c0edc3D` | 1.0 |
| COIN | `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | `0xA3a468A452940B7D6b69991207B508c609a98Ef2` | 1.0 |
| PLTR | `0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A` | `0x820ABedFF239034956B7A9d2F0a331f9F075eB4c` | 1.0 |
| AMD | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | `0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72` | 1.0 |
| AVGO | `0x156E175DD063a8cE274C50654eF40e0032b3fbcF` | — (no feed in Chainlink JSON at probe) | 1.0 |
| NFLX | `0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8` | — | 1.0 |
| QCOM | `0x0f17206447090e464C277571124dD2688E48AEA9` | — | 1.0 |

Only **35 of 194** tickers have a Chainlink feed in the reference directory at probe time (Appendix A marks them). Tokens without a feed: ATRA may only price them from DEX pools + REST `/rhj/prices` and must label them `ORACLE_MISSING` (lower max position size).

### 9.4 Stock-token authentication check (normative, VERIFIED technique)

```ts
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' // EIP-1967 beacon
const STOCK_BEACON = '0xe10b6f6b275de231345c20d14ab812db62151b00'
async function isRobinhoodStockToken(client, token: `0x${string}`) {
  const slot = await client.getStorageAt({ address: token, slot: BEACON_SLOT })
  const beacon = '0x' + slot!.slice(-40)
  return beacon.toLowerCase() === STOCK_BEACON
}
// Fake tokens return 0x000…000 in this slot (verified: fake-USDG/TSLA/NVDA pools are non-beacon contracts).
```

Plus: symbol/name must match the registry (`tokenName` ends with ` • Robinhood Token`; note the on-chain `name()` uses the same U+2022 bullet — compare after NFC normalisation) and `paused()`/`oraclePaused()` must be `false` at trade time.

### 9.5 Weekend / after-hours semantics (normative)

* DEX pools trade 24/7; Chainlink stock feeds and RHJ `/prices` stop at Friday close (feed `updatedAt` was 24.6 h old on Saturday). **A stale feed on Sat/Sun is expected, not an error.**
* ATRA's reference price for a Stock Token = **Chainlink feed** while `now − updatedAt ≤ 86,400 s` **and** a market session is open per RHJ `tradingCapabilities` (`market`/`extended`/`overnight`); otherwise = **last feed value marked `STALE_WEEKEND`**, and trading of that token is restricted to `paper` (or disabled in `live`) unless the operator sets `ROBINHOOD_ALLOW_OFFHOURS=true`.
* Multiplier changes (`UIMultiplierUpdated`) are treated as corporate-action events: ATRA re-reads `uiMultiplier()` on every position valuation and stores raw balances only.

---

## 10. DEXes / AMMs

### 10.1 Canonical: Uniswap (VERIFIED from `Uniswap/contracts` `deployments/json/4663.json`, commit `56928a9`, deployed 2026-05-22; Universal Router redeployed 2026-07-06)

| Component | Address | Notes |
|---|---|---|
| **UniswapV3Factory** | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | VERIFIED live: `getPool(SPY, USDG, 500)` → `0xa7bb1ac63bbab0c44316e6c8c455213441689167`; `getPool(WETH, USDG, 500)` → `0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a` |
| **QuoterV2** (v3) | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` | VERIFIED live quote: 1 WETH → **2,642.519452 USDG** (fee 500, 1 tick crossed, gas 139,261) |
| **SwapRouter02** (v3 + v2) | `0xcaf681a66d020601342297493863e78c959e5cb2` | ATRA v1 execution router for v3 pools |
| MixedRouteQuoterV2 | `0x7edd862aa08dd5be664c21188e1a2a0e64e3a283` | v2+v3+v4 mixed routes |
| NonfungiblePositionManager (v3) | `0x73991a25c818bf1f1128deaab1492d45638de0d3` | |
| TickLens | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` | |
| UniswapInterfaceMulticall | `0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3` | |
| **UniswapV2Factory** | `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f` | |
| **UniswapV2Router02** | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` | |
| **PoolManager** (v4) | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | most stock-token liquidity is in v4 pools (pool IDs are 32-byte hashes on DexScreener/GeckoTerminal) |
| **V4Quoter** | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | |
| **StateView** (v4) | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | read slot0/liquidity for v4 pools |
| PositionManager (v4) | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | |
| **UniversalRouter v2.1.1** | `0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99` | redeployed 2026-07-06 wired to Across SpokePool; previous `0x8876…0904` is **deprecated** — do not use |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical |
| SwapProxy | `0x0000000085E102724e78eCd2F45DC9cA239Affad` | |
| CaliburEntry | `0x000000009b1d0af20d8c6d0a44e162d11f9b8f00` | |
| UniswapX | live per Uniswap blog; reactor addresses **UNVERIFIED** (not in 4663.json) | not used by ATRA v1 |

Full table (23 entries incl. proxies/admins) in Appendix C. Source of truth: `https://raw.githubusercontent.com/Uniswap/contracts/main/deployments/json/4663.json` — ATRA CI should diff this file weekly and fail on address drift.

**v4 hooks caveat.** Community hooks exist on this chain (e.g. `SessionHook`, `StonkHook`, `UnihoodStockHook` in `Uniswap/hooklist`) that restrict swaps to US market hours or add dynamic fees. ATRA v1 **only routes through hookless v3 pools and v4 pools whose `hooks == 0x0`** (read via `StateView`/pool key); hooked pools are `UNSUPPORTED` until a hook allowlist exists.

### 10.2 Other venues (GeckoTerminal `GET /api/v2/networks/robinhood/dexes`, 42 entries, VERIFIED list; addresses UNVERIFIED)

`uniswap-v2-robinhood`, `uniswap-v3-robinhood`, `uniswap-v4-robinhood`, `uniswap-pools-trade`, `pancakeswap-v2-robinhood`, `pancakeswap-v3-robinhood`, `pancakeswap-infinity-clmm-robinhood`, `sushiswap-v2-robinhood`, `sushiswap-v3-robinhood`, `curve-robinhood`, `ramses-v3-robinhood`, `ramses-dlmm-robinhood`, `ramses-legacy-robinhood`, `ekubo-v3-robinhood`, `up-v3`, `alandale`, `alandale-cl`, `giga-v2`, `giga-v3`, `orvex-v2`, `orvex-v4`, `synthra-robinhood`, `rubicon-robinhood`, `rubicon-clmm-robinhood`, `brownfi-v3-robinhood`, `sectorone-v2-0-robinhood`, `sectorone-v2-2-robinhood`, `parityswap`, `robinswap`, `hoodit`, `swaphood-finance-v2`, `swaphood-finance-v3`, `pons-dot-family`, `pons-v2`, `pons-v2-dex`, `abyss`, `bankr-robinhood`, `virtuals-robinhood`, `clanker-robinhood`, `mint-club-robinhood`, `easya-kickstart-robinhood`, `o1-launchpad-robinhood`.

DexScreener `dexId`s observed for chain `robinhood`: `uniswap` (labels `v2`/`v3`/`v4`), `up` (`v3`), `ramses`, `alandale`, plus raw factory addresses for unlabeled venues.

Stock-token liquidity snapshot (GeckoTerminal, SPY): `SPY/USDG 0.3%` v4 **$8.58 M**; `SPY/WETH 0.05%` v3 $1.91 M; `SPY/USDG` v4 $1.79 M; `SPY/USDG 0.01%` Ramses v3 $0.49 M (24 h vol $3.86 M); `SPY/QQQ 0.05%` v4 $1.46 M. NVDA/USDG v4 pools $0.62 M and $1.07 M; NVDA/USDG Up-V3 $0.24 M ($2.5 M 24 h vol).

**Pleiades** ("proprietary AMM for prop trading", Robinhood newsroom) — **no public contract addresses found; not listed on GeckoTerminal/DexScreener. UNVERIFIED / likely not permissionless. Not integrated.** Other partners named at launch: Rialto, Lighter (perps, has its own L2BEAT entry "Lighter on Robinhood"), Arcus, 1inch, Morpho (Robinhood Earn on USDG). All out of ATRA v1 scope.

### 10.3 ATRA routing policy (normative)

1. Quote via `QuoterV2.quoteExactInputSingle` / `quoteExactInput` on **Uniswap v3** and `V4Quoter` on **hookless v4** pools; pick best `amountOut` net of fee tier; require pool `liquidity > 0` and quoted price within **1.5 %** of the reference price (Chainlink for stock tokens/ETH; $1.00 ± 0.5 % for USDG). Outside that band ⇒ `PRICE_DEVIATION` reject.
2. Execute via `SwapRouter02` (v3/v2) or `UniversalRouter` (v4) with `deadline = now + 60 s`, `amountOutMinimum = quote × (1 − slippage)`, default slippage **0.5 %** for stock tokens, **0.3 %** for WETH/USDG.
3. Never route through pools with a token outside the allowlist (§9).
4. Default pairs: `<STOCK>/USDG`, `WETH/USDG`; `<STOCK>/WETH` only as a 2-hop fallback.

---

## 11. Bridge

| Item | Value |
|---|---|
| Canonical bridge UI | `https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum` (docs, chains.json) |
| Deposit time | "typically confirm within 10 minutes" (docs) |
| Withdrawal | 3-step, **7-day challenge period** (docs; L2BEAT: 6d 8h) via Outbox `0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9` |
| Programmatic deposits | Delayed Inbox `0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D` (ETH: `depositEth()`; ERC-20 via L1 Gateway Router `0x6a2E3a1e16FC29f27Ce61429746D558d656975bB`) |
| Bridged-token address rule | `L2GatewayRouter(0x1E324B9316138CA9a73F960213621AD1aaf01B89).calculateL2TokenAddress(l1Token)` (selector `0xa7e28d48`) — VERIFIED for USDC/USDT/WBTC |
| Third-party routes (docs) | LayerZero/Stargate, Chainlink CCIP (Transporter), Relay, Across (UniversalRouter is wired to the Across SpokePool), LI.FI, 0x — addresses UNVERIFIED |
| USDG on-ramp | Native Paxos issuance; also movable via LayerZero per docs |

ATRA v1 does **not** bridge autonomously (funding is an operator action). It only needs the withdrawal delay for the "finalized" semantics in §8.

---

## 12. Indexers / price data

| Provider | Chain slug | Endpoint examples (VERIFIED 2026-09-19) | Notes |
|---|---|---|---|
| **DexScreener** | `robinhood` | `GET https://api.dexscreener.com/latest/dex/search?q=AAPL` → pairs with `chainId:"robinhood"`; `GET https://api.dexscreener.com/tokens/v1/robinhood/0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9`; `GET https://api.dexscreener.com/token-pairs/v1/robinhood/{addr}` (HTTP 200) | Keyless. Rate limit per DexScreener docs (300 req/min for `/latest/dex/*`, UNVERIFIED current). Returns fake pools too — filter by address (§9). v4 pools use 32-byte pool IDs as `pairAddress`. |
| **GeckoTerminal** | `robinhood` (`coingecko_asset_platform_id: "robinhood"`) | `GET https://api.geckoterminal.com/api/v2/networks/robinhood/dexes`; `/networks/robinhood/tokens/{addr}`; `/networks/robinhood/tokens/{addr}/pools`; `/networks/robinhood/pools/{pool}/ohlcv/minute?aggregate=5&limit=3` (returned 5-min candles for SPY/WETH v3: e.g. `[1789832400, 763.52, 764.07, 761.80, 762.05, 33652.06]`) | Keyless, ~30 req/min public tier (UNVERIFIED). Best free OHLCV source on this chain. |
| **CoinGecko** | `robinhood` (`chain_identifier: 4663`, `native_coin_id: "ethereum"`) | `GET https://api.coingecko.com/api/v3/asset_platforms` → `{id:"robinhood", …}`; `GET https://api.coingecko.com/api/v3/coins/robinhood/contract/0xaF3D…93f9` → `id: "apple-robinhood-tokenized-stock"`, price 335.38 | Stock tokens are listed as coins (`<name>-robinhood-tokenized-stock`). USDG coin id `global-dollar`. |
| Robinhood RHJ REST | — | `https://api.robinhood.com/rhj/assets`, `/rhj/prices/{SYMBOL}`, `/rhj/corporate-actions` | No auth observed; 60 req/s documented; bid/ask are **un-multiplied** underlying equity quotes |
| Chainlink | — | on-chain feeds (Appendix B) + `https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json` (57 feeds) | authoritative address list is `https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood` |
| Bitquery | `robinhood` | GraphQL, BYOK | UNVERIFIED |

---

## 13. Security / governance facts a risk engine must encode

| Fact | Source | ATRA consequence |
|---|---|---|
| Not yet **Stage 0** on L2BEAT ("1 issue needs fixing"); TVS ≈ $2.95 B | L2BEAT 2026-09 | chain risk tier = `PERMISSIONED_L2` |
| Fraud proofs: **BoLD**, **permissioned** — 2 whitelisted validators (Offchain Labs, Alchemy); "anyone becomes proposer after 28 days of inactivity" | docs `/chain/governance`, L2BEAT | |
| Upgrades: Security Council **8 signers** (Robinhood ×2, BitGo, Chainlink Labs, Fireblocks Trust Co., Offchain Labs, Paxos, Talos); routine 6/8 + 7-day timelock, emergency 7/8 no timelock. L2BEAT: core upgrades are effectively **instant via Safe multisig, no exit window** | docs, L2BEAT | ATRA caps `robinhood` exposure by policy (default: ≤ 25 % of portfolio NAV, configurable) |
| Sequencer: centralised; force-inclusion via L1 Delayed Inbox exists but **transaction filtering can nullify force-inclusion** | L2BEAT | §6 filtered-tx handling |
| DA: Ethereum blobs/calldata (no DAC) | docs, L2BEAT | data-availability risk = Ethereum |
| Stock Tokens: single beacon, pausable, revocable per address, issuer is a Jersey SPV; **not for US/UK persons** | §9.3 | operator must attest jurisdiction in ATRA config (`ROBINHOOD_STOCK_TOKENS_ELIGIBLE=true`) before any stock-token trade (paper mode included, to keep behaviour identical) |
| Impersonation tokens with fake liquidity | §9.2 | address-only allowlist |
| Explorer API Cloudflare-gated | §3 | no explorer dependency |

---

## 14. ATRA integration contract

### 14.1 Config (`.env.example` additions — file owned by us)

```ini
# Robinhood Chain (Arbitrum Orbit L2, chain 4663) — MAINNET LIVE since 2026-07-01
ROBINHOOD_ENABLED=true
ROBINHOOD_NETWORK=mainnet                 # mainnet | testnet
ROBINHOOD_RPC_URL=                        # BYOK override (e.g. https://robinhood-mainnet.g.alchemy.com/v2/KEY); blank = keyless list
ROBINHOOD_WSS_URL=
ROBINHOOD_QUOTE_ASSET=USDG                # fixed; USDC is NOT liquid on this chain
ROBINHOOD_STOCK_TOKENS_ELIGIBLE=false     # operator attests they are not a US person / UK resident before enabling stock-token trades
ROBINHOOD_ALLOW_OFFHOURS=false            # allow stock-token trades when Chainlink feed is weekend-stale
ROBINHOOD_MAX_NAV_PCT=25
```

### 14.2 Chain status labelling (normative)

```text
robinhood:  MAINNET            # eth_chainId == 0x1237 on ≥1 endpoint, latest block age < 30 s
robinhood:  DEGRADED           # chain ID ok but latest age ≥ 30 s, or all quotes failing for 60 s
robinhood:  UNAVAILABLE        # no endpoint returns 0x1237 (never fall back to Arbitrum One / Base / any other chain)
robinhood-testnet: TESTNET     # 0xb626
```

`TESTNET_ONLY` is **not** applicable — mainnet is live. The label must be recomputed every 10 s and exposed on the dashboard API.

### 14.3 Startup sequence

1. Load pinned addresses (§9.1, §10.1) — fail closed if any is malformed.
2. `assertRobinhood()` on every endpoint; drop mismatches.
3. Fetch `GET /rhj/assets`; cache 1 h; build `symbol → {address, decimals:18, multiplier, isin, tradingCapabilities}`; reject entries whose `chainId ≠ 4663`.
4. For each allowlisted stock token: beacon check (§9.4) + `paused()`/`oraclePaused()`; on failure mark `SUSPENDED`.
5. Load Chainlink feed map (Appendix B or fetch `feeds-robinhood-mainnet.json`, cache 24 h); read `latestRoundData()` for ETH/USD, USDG/USD and each allowlisted stock feed.
6. Warm quotes: `QuoterV2` WETH→USDG (expect ≈ Chainlink ETH/USD ± 1.5 %).

### 14.4 Health checks (every 10 s)

* `latest` age < 30 s; `safe` lag < 30 min; `finalized` lag < 60 min (else `DEGRADED`).
* USDG/USD feed within $0.995–$1.005 and < 24 h old (else stop quoting in USDG, alert).
* `uiMultiplier()` unchanged vs cache for open positions; on change emit `CORPORATE_ACTION` event and revalue.

---

## 15. Test vectors (all VERIFIED live on 2026-09-19 unless marked)

| # | Input | Expected |
|---|---|---|
| T1 | `eth_chainId` on `https://rpc.mainnet.chain.robinhood.com` | `"0x1237"` |
| T2 | `eth_chainId` on `https://rpc.testnet.chain.robinhood.com` | `"0xb626"` |
| T3 | `eth_getCode(0xcA11bde05977b3631167028862bE2a173976CA11)` mainnet | non-empty, starts `0x6080604052600436106100f3…` |
| T4 | `eth_getCode(0x0000000000000000000000000000000000000064)` | `"0xfe"` (precompile sentinel) |
| T5 | `eth_call ArbSys.arbOSVersion()` (`0x051038f2`) | `116` ⇒ ArbOS 61 (may increase after upgrades) |
| T6 | `eth_call ArbGasInfo.getMinimumGasPrice()` (`0xf918379a`) | `20000000` (0.02 gwei) |
| T7 | `eth_maxPriorityFeePerGas` | `"0x0"` |
| T8 | `eth_estimateGas` {from `0x…01`, to `0x…02`, value `0x1`} | `0x52e9` (21,225) ± small drift; **> 21,000** |
| T9 | USDG `symbol()`/`decimals()` | `USDG` / `6` |
| T10 | WETH `symbol()`/`decimals()` | `WETH` / `18` |
| T11 | AAPL `symbol()`/`decimals()`/`name()` | `AAPL` / `18` / `Apple • Robinhood Token` |
| T12 | AAPL `uiMultiplier()` (`0xa60bf13d`) | `1000566080061092436` at probe (changes on corporate actions; must equal registry `currentMultiplier` × 1e18) |
| T13 | AAPL `paused()` (`0x5c975abb`), `oraclePaused()` (`0x7706ba52`) | `false`, `false` |
| T14 | `eth_getStorageAt(AAPL, 0xa3f0ad74…3d50)` | `0x…e10b6f6b275de231345c20d14ab812db62151b00` |
| T15 | `eth_getStorageAt(<fake USDG 0xeC90adc7157d68d9213a88627b66956950374a3e>, beacon slot)` | `0x000…000` (UNVERIFIED for this exact fake; verified pattern) |
| T16 | `L2GatewayRouter.calculateL2TokenAddress(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48)` | `0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8` |
| T17 | `UniswapV3Factory.getPool(SPY, USDG, 500)` | `0xa7bb1ac63bbab0c44316e6c8c455213441689167` |
| T18 | `UniswapV3Factory.getPool(WETH, USDG, 500)` | `0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a` |
| T19 | `QuoterV2.quoteExactInputSingle((WETH, USDG, 1e18, 500, 0))` | `amountOut` within ±3 % of Chainlink ETH/USD × 1e6 (was 2,642.519452 vs $2,639.89) |
| T20 | Chainlink `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0.description()` | `Robinhood AAPL / USD` |
| T21 | Chainlink `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2.latestRoundData().answer` | 99,000,000 – 101,000,000 (8 dec) |
| T22 | `GET https://api.dexscreener.com/tokens/v1/robinhood/0xaF3D…93f9` | array, every element `chainId == "robinhood"`, baseToken.address == AAPL |
| T23 | `GET https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/0x5fc5…d168` | `attributes.symbol == "USDG"`, `decimals == 6`, `coingecko_coin_id == "global-dollar"` |
| T24 | `GET https://api.coingecko.com/api/v3/asset_platforms` | contains `{id:"robinhood", chain_identifier:4663}` |
| T25 | `GET https://api.robinhood.com/rhj/assets` | `assets.length ≥ 150`, every `deployments[0].chainId == 4663`, `tokenDecimals == 18` |
| T26 | `GET https://api.robinhood.com/rhj/prices/AAPL` | `quotes[0].deployments[0].contractAddress == 0xaF3D…93f9`, `currency == "USD"` |
| T27 | `eth_getLogs` USDG Transfer over 100,000 blocks | JSON-RPC error containing `exceeds limit of 10000` |
| T28 | `GET https://robinhoodchain.blockscout.com/api/v2/stats` (headless) | HTTP 403 HTML challenge → ATRA treats as `EXPLORER_UNAVAILABLE`, not fatal |
| T29 | `eth_getBlockByNumber("safe")` vs `"latest"` | `latest.number − safe.number` ≈ 3,000–12,000 blocks (5–20 min) |

Function selectors used above (keccak-256, VERIFIED): `uiMultiplier()` `0xa60bf13d`, `balanceOfUI(address)` `0x437a9958`, `totalSupplyUI()` `0x9bea6429`, `newUIMultiplier()` `0xdc767007`, `effectiveAt()` `0x97a4064f`, `paused()` `0x5c975abb`, `oraclePaused()` `0x7706ba52`, `latestRoundData()` `0xfeaf968c`, `description()` `0x7284e416`, `calculateL2TokenAddress(address)` `0xa7e28d48`, `getPool(address,address,uint24)` `0x1698ee82`, `quoteExactInputSingle((address,address,uint256,uint24,uint160))` `0xc6a5026a`, `arbOSVersion()` `0x051038f2`, `arbBlockNumber()` `0xa3b1b31d`, `getPricesInWei()` `0x41b247a8`, `getL1BaseFeeEstimate()` `0xf5d6ded7`, `getMinimumGasPrice()` `0xf918379a`, `getAllChainOwners()` `0x516b4e0f`, `isTransactionFiltered(bytes32)` (computed at runtime; call on `0x…0074`).

---

## 16. Unknowns / UNVERIFIED items

1. Pleiades AMM: no public addresses; may be a permissioned prop venue.
2. UniswapX reactor addresses on 4663 (Uniswap blog says live; not in `4663.json`).
3. Sequencer feed (`wss://feed.mainnet.chain.robinhood.com`) protocol/format for third parties.
4. Whether `https://sequencer.mainnet.chain.robinhood.com` accepts direct `eth_sendRawTransaction`.
5. Per-transaction gas cap (Arbitrum One uses 32 M; not documented for Robinhood).
6. Exact rate limits of the official public RPC and of DexScreener/GeckoTerminal public tiers.
7. Chainlink L2 Sequencer Uptime Feed for Robinhood Chain (not listed in Chainlink docs at probe).
8. Stock-token blocklist registry address and role set (reported by dev.to/Beosin, not in official docs; `isBlocked` reverts on the token itself).
9. L2 addresses of cbBTC, LBTC, weETH, wstETH, USDe, USDS, EURC, LINK, ENA on this chain (feeds exist; tokens not resolved here).
10. Official testnet faucet (chains.json lists none; third-party faucets exist).
11. L1 data-fee behaviour under blob congestion (observed 0 at probe; may spike).
12. Whether `hoodscan.co` / `stonkscan.io` expose Etherscan-style APIs.

---

## 17. Sources

Official / primary
* Robinhood Chain docs — Connecting: https://docs.robinhood.com/chain/connecting
* Robinhood Chain docs — index: https://docs.robinhood.com/chain
* Robinhood Chain docs — Protocol contracts: https://docs.robinhood.com/chain/protocol-contracts
* Robinhood Chain docs — Token contracts: https://docs.robinhood.com/chain/contracts
* Robinhood Chain docs — Stock Tokens: https://docs.robinhood.com/chain/stock-tokens/
* Robinhood Chain docs — Building with Stock Tokens: https://docs.robinhood.com/chain/building-with-stock-tokens/
* Robinhood Chain docs — Stock Token APIs: https://docs.robinhood.com/chain/stock-token-apis/
* Robinhood Chain docs — Transaction finality: https://docs.robinhood.com/chain/transaction-finality
* Robinhood Chain docs — Gas and fees: https://docs.robinhood.com/chain/gas-and-fees
* Robinhood Chain docs — Bridging: https://docs.robinhood.com/chain/bridging
* Robinhood Chain docs — Oracles & price feeds: https://docs.robinhood.com/chain/oracles-and-price-feeds/
* Robinhood Chain docs — Differences from Ethereum: https://docs.robinhood.com/chain/differences-from-ethereum
* Robinhood Chain docs — Governance: https://docs.robinhood.com/chain/governance
* Robinhood newsroom — mainnet launch (2026-07-01): https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/
* Robinhood newsroom — public testnet (2026-02-10): https://robinhood.com/us/en/newsroom/robinhood-chain-launches-public-testnet
* Robinhood RHJ REST: https://api.robinhood.com/rhj/assets , https://api.robinhood.com/rhj/prices/AAPL
* ethereum-lists chains.json: https://chainid.network/chains.json (entries 4663, 46630)
* chainlist.org: https://chainlist.org/chain/4663 , https://chainlist.org/chain/46630
* Uniswap deployments JSON (chain 4663): https://raw.githubusercontent.com/Uniswap/contracts/main/deployments/json/4663.json
* Uniswap blog — live on Robinhood Chain: https://blog.uniswap.org/robinhood-chain-is-live
* Uniswap docs PR (Universal Router redeploy): https://github.com/Uniswap/docs/pull/1161
* Chainlink reference data directory (Robinhood mainnet feeds): https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
* Chainlink docs — Robinhood tokenized equity feeds: https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood
* Chainlink docs — feed addresses (network=robinhood): https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood
* Chainlink docs — L2 sequencer feeds: https://docs.chain.link/data-feeds/l2-sequencer-feeds
* Chainlink × Robinhood press release: https://www.prnewswire.com/news-releases/robinhood-chain-launches-and-adopts-chainlink-to-unlock-access-to-the-onchain-economy-for-millions-of-users-302816242.html
* Paxos / Global Dollar — USDG on Robinhood Chain: https://globaldollar.com/newsroom/usdg-is-now-available-on-robinhood-chain-as-the-lending-asset-in-robinhood-s-new-earn-product
* viem chain definitions (2.56.8): https://cdn.jsdelivr.net/npm/viem@latest/_esm/chains/definitions/robinhood.js , https://cdn.jsdelivr.net/npm/viem@latest/_esm/chains/definitions/robinhoodTestnet.js
* Arbitrum DAO factsheet: https://forum.arbitrum.foundation/t/arbitrumdao-factsheet-robinhood-chain-mainnet-launch/31041
* Arbitrum precompiles reference: https://docs.arbitrum.io/arbitrum-essentials/precompiles/reference

Indexers
* DexScreener API: https://api.dexscreener.com/latest/dex/search?q=AAPL , https://api.dexscreener.com/tokens/v1/robinhood/0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9
* GeckoTerminal API: https://api.geckoterminal.com/api/v2/networks/robinhood/dexes , https://www.geckoterminal.com/robinhood/pools
* CoinGecko API: https://api.coingecko.com/api/v3/asset_platforms , https://api.coingecko.com/api/v3/coins/robinhood/contract/0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9

Infrastructure providers
* Alchemy — Robinhood Chain mainnet live: https://www.alchemy.com/blog/robinhood-chain-mainnet-is-live-on-alchemy , https://www.alchemy.com/rpc/robinhood
* Chainstack Robinhood quickstart: https://docs.chainstack.com/reference/robinhood-getting-started
* Faucets: https://faucets.chain.link/robinhood-testnet , https://faucet.quicknode.com/robinhood/testnet , https://faucet.chainstack.com/robinhood-chain-testnet-faucet

Risk / third-party analysis
* L2BEAT — Robinhood Chain: https://l2beat.com/scaling/projects/robinhood
* Beosin — Stock token contract analysis: https://beosin.com/resources/robinhood-chain-stock-token-practice-code-analysis-on-token-contract-and-blockchain-protocol
* dev.to — "Robinhood Chain: Three Things the Docs Don't Say": https://dev.to/sulimanmukhtar/robinhood-chain-three-things-the-docs-dont-say-4olb
* Uniswap hooklist (Robinhood hooks): https://github.com/Uniswap/hooklist/pull/9625 , https://github.com/Uniswap/hooklist/pull/4696
* Blob-space crowding report (UNVERIFIED): https://bitcoinethereumnews.com/ethereum/a-base-traffic-spike-crowded-robinhood-chain-out-of-ethereums-blob-space/

---

## Appendix A — Robinhood Stock Token registry snapshot (194 tokens, `GET /rhj/assets`, 2026-09-19T15:40Z)

Columns: ticker | underlying | token address (chain 4663) | `currentMultiplier` (truncated) | ISIN | Chainlink USD feed proxy (8 dec) if published.

Refresh from the API at runtime; this snapshot is for tests and offline bootstrapping only.

| Ticker | Underlying | Token address | Multiplier | ISIN | Chainlink feed |
|---|---|---|---|---|---|
