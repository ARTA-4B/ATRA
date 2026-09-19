# ATRA Dashboard ↔ Runtime REST API Contract

**Date:** 2026-09-19 · **Topic:** codex-ui-contract · **Status:** DESIGN-TARGET (no runtime code exists yet; `C:\ATRA\runtime` is empty as of this analysis)

**Scope.** The Codex-owned frontend at `C:\ATRA` (React 19 + Vite 8, hash-routed SPA) currently runs on static fixtures and `localStorage`. This document (1) inventories every data shape, service seam, and label the UI renders today, and (2) defines the REST contract the TypeScript runtime in `C:\ATRA\runtime` must expose so the UI plugs in with the smallest possible frontend diff. Nothing under the repo root (`src/`, `vite.config.ts`, `tests/`, …) was modified; the two frontend changes this contract needs are listed in §9 as proposals for the Codex session.

**Hard rules carried into every route:** PAPER mode by default; the LLM never signs; private keys never leave the local vault (the only route that ever returns key material is `POST /api/v1/wallet/export`, gated by fresh re-authentication, loopback-only, `Cache-Control: no-store`); the runtime never fabricates values — unavailable data is `null` with a `source` label and a machine-readable `reason`.

---

## 0. Table of contents

1. Frontend inventory (what the UI renders today)
2. How the UI expects to talk to a backend
3. Transport conventions (base URL, port, headers, envelopes, errors, time/money)
4. Auth, session cookie, re-authentication, CSRF, DNS-rebinding
5. Shared TypeScript types (`api.types.ts`)
6. Routes (method, path, auth, request, response, JSON example)
7. Server-Sent Events stream
8. Gaps: UI fields with no defined data source, and what the runtime returns
9. Frontend integration notes (minimal Codex-side changes)
10. Test vectors
11. Appendix A — OpenAPI 3.1 skeleton (paths only)
12. Appendix B — Runtime environment variables
13. Sources

---

## 1. Frontend inventory

Files read (read-only): `package.json`, `vite.config.ts`, `playwright.config.ts`, `index.html`, `tsconfig.json`, `src/App.tsx`, `src/main.tsx`, `src/Dashboard.tsx`, `src/Public.tsx`, `src/Market.tsx`, `src/Flows.tsx`, `src/components.tsx`, `src/data/fixtures.ts`, `src/data/services.ts`, `tests/frontend.spec.ts`.

### 1.1 Stack and routing

| Item | Value (verified from source) |
|---|---|
| Framework | React `^19.3.0`, `react-dom ^19.3.0`, `lucide-react ^1.47.0`, `zod ^4.6.5` |
| Build | Vite `^8.3.0`, `@vitejs/plugin-react ^6.1.1`, TypeScript `^6.0.3`, ESM (`"type":"module"`) |
| Tests | `@playwright/test ^1.63.0`, `baseURL: http://127.0.0.1:5173`, `webServer: npm run dev -- --host 127.0.0.1` |
| Dev server | `vite.config.ts`: `server: { host: '127.0.0.1' }` — port defaults to **5173**; **no `server.proxy`**, no `import.meta.env` usage anywhere |
| Routing | Hash router in `App.tsx`. `#/app/<page>` → `<Dashboard page>`; anything else → `<PublicSite page>`. Dashboard pages: `overview`, `market`, `agents`, `auto-trade`, `auto-lp`, `wallet`, `risk`, `activity`, `telegram`, `settings`, `setup`. Public pages: `home`, `market`, `install`, `docs`, `docs/security`, `docs/status` |
| Network calls | **None.** No `fetch`, no `XMLHttpRequest`, no WebSocket. All data comes from `src/data/services.ts` (fixtures + `localStorage`) |
| Persistence | `localStorage` keys `atra.settings`, `atra.risk`, `atra.setup` (value `'complete'`) |
| Mode labels | Top bar `<Badge tone="paper">PAPER MODE</Badge>` (hard-coded); System health `Current mode: PAPER`; sidebar `Runtime disconnected` + `Frontend v0.1.0 DEMO`; footer `ATRA / FRONTEND PREVIEW`; `DataNotice` "Demo workspace — all market values, balances, positions, and activity are simulated. No runtime is connected." |

### 1.2 Service seam (`src/data/services.ts`) — the exact interfaces the adapter must satisfy

```ts
export const chains = ['Base', 'BNB Smart Chain', 'Robinhood Chain', 'Solana'] as const;
export type Chain = typeof chains[number];
type Market = { id: string; symbol: string; name: string; chain: Chain; price: number|null; change: number|null; volume: number|null; liquidity: number|null; pool: string; history: number[] };
export type DataState = 'ready' | 'loading' | 'empty' | 'stale' | 'error';
export type Research = { observed: string; interpretation: string; risks: string; missing: string; action: 'NO ACTION' };
export interface MarketService { list(state?: DataState): Promise<Market[]>; research(market: Market): Promise<Research> }
export const RiskSchema = z.object({ trade: 1..1_000_000, loss: 1..1_000_000, capital: 1..10_000_000, slippage: 0.01..5, fee: 0..1000, cooldown: int 1..1440, liquidity: >=1000, tokens: string, protocols: string }).refine(trade <= capital, 'Maximum trade size cannot exceed maximum deployed capital.');
export const defaultRisk = { trade: 500, loss: 100, capital: 5000, slippage: 0.5, fee: 5, cooldown: 15, liquidity: 100000, tokens: 'ETH, SOL, BNB, USDC', protocols: '' };
const SettingsSchema = z.object({ name: string 1..60, chains: Chain[] (min 1), provider: 'hosted'|'custom', endpoint: '' | /^https?:\/\//, model: 'atra'|'local'|'external', density: 'comfortable'|'compact' });
export const defaultSettings = { name: 'Local installation', chains: [...chains], provider: 'custom', endpoint: '', model: 'atra', density: 'comfortable' };
export interface WalletService { create(): Promise<never>; withdraw(): Promise<never>; export(): Promise<never>; status(): { connected: false; evmAddress: null; solanaAddress: null } }
export const agentService = { enableLive: unavailable, status: () => ({ source: 'demo', mode: 'PAPER', connected: false }) };
export const tradingService = { execute: unavailable };
export const liquidityService = { execute: unavailable };
export const telegramService = { pair: unavailable, unpair: unavailable, status: () => ({ paired: false, botUrl: null }) };
export const activityService = { list: () => activityFixtures };   // rows: { id, time:'HH:mm:ss', category, chain, action, result, detail }
```

Every `unavailable()` call throws `Error('A local ATRA runtime is required. This frontend preview cannot perform this action.')`; the Playwright suite asserts that text (`toContainText('local ATRA runtime')`) in the wallet, export, live-mode, and onboarding tests. **Once the adapter is switched to HTTP, those four assertions must be updated by Codex** (they encode the demo behaviour, not the contract).

### 1.3 Screens → data they render

| Screen (route) | Rendered data (label → shape) |
|---|---|
| **Top bar / sidebar** (all `#/app/*`) | `settings.name`; `PAPER MODE` badge; `{n} chains enabled` (= `settings.chains.length`); `Wallet not connected` button (opens `create` flow); Pause/Resume button (local state); sidebar `Runtime disconnected`, `Frontend v0.1.0 DEMO`; `agents` nav badge `3`; `risk` nav dot |
| **Overview** `#/app/overview` | Metrics: `Total Agent Wallet value` ($), `Available balance` ($ + `% of portfolio`), `Deployed capital` ($ + %), `Today's P&L` (+$ and `1.50%`). Portfolio chart with `1D|1W|1M` segmented control, y-axis labels, x-axis labels. System health: `Runtime` (Not connected), `Current mode` (PAPER), `Enabled chains` (4 networks), `Agent Wallet` (Not connected), `Gas status` (Not verified); risk meter `24 / 100%` + `Daily loss: $18 / $100`. Stats: `Open trades` (2, simulated positions), `Active LP positions` (1, in range), `Last agent action` (text · agent · `HH:mm:ss`). Agent strip: 3 × `{name, task}`. Recent activity: 4 rows (compact). `Review Live Mode` → `live` flow |
| **Market** `#/app/market` (also public `#/market`) | `Market[]` rows: Asset/Pair, Chain, Price, 24h change, (7D sparkline `history[]` in preview), Volume (24h), Liquidity, Pool, `Updated` badge (`Fixture`/`Stale`/`Unavailable`). Filters: search, chain, sort (`volume|price|change|name`), watchlist toggle (in-memory `string[]` of ids). Detail: price, sparkline, Liquidity, 24h volume, `Data source`, `Freshness`, `Supported execution`, `Agent exposure`, `Existing trade / LP`. `Research this market` → `Research` five sections. Footer: `{n} markets · Exactly 4 supported chains`, `Data environment` |
| **Agents** `#/app/agents` | 3 cards: `{name, task, result, schedule, lastRun, nextRun, enabled}` for `Research Agent`, `Trader Agent`, `Liquidity Manager`; toggle `Enable in demo` |
| **Auto Trade** `#/app/auto-trade` | Status strip: `PAPER` badge, `Paused|Demo enabled`, `Last sample cycle: 14:30 · Next: awaiting runtime`. Tabs: Positions table `[Asset, Chain, Exposure, Size, Entry, Current, P&L, Status]`; Strategy controls (= `RiskLimits` form: max position size, max deployed capital, allowed assets, max daily loss, min liquidity, max slippage, cooldown); Recent decisions `[Time, Market, Proposed action, Risk result, Final action, Reason]`. Pipeline `Observe market → Propose action → Check hard limits → Simulate execution` |
| **Auto LP** `#/app/auto-lp` | Metrics `Total LP value`, `Active positions`, `Unclaimed fees`, `Requires attention`. Positions `[Pool, Chain, Protocol, Value, Range / State, Fees, Last rebalance, Status]`; Automation rules (= `RiskLimits` LP variant: max capital per position, max deployed capital, allowed pools, allowed protocols, min liquidity, max slippage, rebalance cooldown, fee-collection threshold [disabled]); Recent actions: enum `HOLD|ADD|REMOVE|REBALANCE|COLLECT FEES|EXIT`, `{time, pool, action, note}` |
| **Wallet** `#/app/wallet` | Two panels `EVM Agent Wallet` (chains Base, BNB Smart Chain, Robinhood Chain) and `Solana Agent Wallet`: public address (or `Public address unavailable` + `Not connected`), per-chain native balances (EVM) / `SOL balance` + `Token balances` (Solana), buttons Deposit / Withdraw / Withdraw all; `Create Agent Wallets`; `Advanced wallet controls → Review wallet export` |
| **Flows** (`Flows.tsx` modal) | `deposit`: network select → address + QR placeholder, gas-asset warning (`SOL|BNB|ETH|the runtime-confirmed native gas asset`), ack checkbox. `withdraw`/`withdraw-all`: network, asset (`USDC` or native `SOL|BNB|ETH`), destination (EVM regex `^0x[a-fA-F0-9]{40}$` and not zero address; Solana `^[1-9A-HJ-NP-Za-km-z]{32,44}$`), amount (>0), `Available balance`, `Estimated network fee` → review `{Network, Destination, Amount, Network fee, Remaining balance}` → ack + typed `WITHDRAW` when `withdraw-all` or amount ≥ 1000 → `Check runtime & confirm`. `export`: `Local password`, ack, `Authenticate locally`. `live`: checklist `[Agent Wallet funded, Gas available, Risk limits reviewed, Supported protocols only]` each with `Not verified` badge, ack, `Local re-authentication` password, `Check live eligibility`. `emergency`: ack → `Confirm Emergency Stop`. `create`: `Create with local runtime` |
| **Risk** `#/app/risk` | Full `RiskLimits` form (trade, loss, capital, slippage, fee, cooldown, liquidity, tokens, protocols) with zod messages joined by space; `Example risk usage` (`Daily loss $18 / $limit`); `Global controls`: Pause automation, Emergency Stop; recovery modal `Clear demo stop and stay paused` |
| **Activity** `#/app/activity` | Filter `all|research|trade|liquidity|wallet|risk|system`; table `[Timestamp, Category, Chain, Action, Result, Reference(id)]` + expand row: `Reasoning summary` (detail), `Input snapshot`, `Simulation: PAPER`, `Risk decision`, `Transaction hash` |
| **Telegram** `#/app/telegram` | `NOT PAIRED|PAIRED`; steps (Generate code → open bot (`Bot URL not configured`) → `/pair CODE` → confirm); pairing code `/pair DEMO-ONLY` with `expires in 5:00`/`Expired`; paired state `{Account, Installation, Connection}`; notification toggles `Risk rejections, Trade decisions, Liquidity updates, Runtime alerts`; `Unpair`; command reference `/status /portfolio /positions /trades /lp /risk /pause /resume /emergency` |
| **Settings** `#/app/settings` | `Installation name`, `Runtime connection` (read-only), `Enabled chains` (checkboxes), `Provider` (`custom|hosted`), `Public endpoint URL`, `Provider API secret` (password, disabled: "Configure secrets in your local runtime"), `No provider connected` badge; `Preferred model` (`atra|local|external`) + status warning; `Content density` (client-only); `Export configuration` (downloads `{schemaVersion:1, environment:'frontend-preview', settings, risk}` as `atra-preview-config.json`); `Reset preview data` (typed `RESET`) |
| **Setup** `#/app/setup` | 6 steps: `Welcome` → `Choose chains` → `Agent Wallets` (`Create Agent Wallets`, shows `EVM Agent Wallet: Not created`, `Solana Agent Wallet: Not created`) → `Risk baseline` (trade 1..5000, loss 1..5000; capital fixed 5000) → `Telegram` (skip) → `Paper Mode` (ack). Finish saves `settings.chains`, risk defaults, `atra.setup='complete'`, navigates to `#/app/overview` |
| **Public `#/docs/status`** | Integration status list: Public website, Dashboard & paper UI, Local agent runtime, Market data provider, Wallet vault & transaction signing, Telegram bot, ATRA-4B (`Trained weights not installed`) |

### 1.4 Auth/login in the UI

There is **no login screen**. Two places collect a "local password": the `export` flow and the `live` flow (both inputs are `disabled` today). The contract therefore introduces a session (§4) that the UI obtains through one new small "Unlock runtime" dialog (§9), and a re-auth token for the two existing password fields.

---

## 2. How the UI expects to talk to a backend

- **Base URL:** nothing is configured. The UI is served from `http://127.0.0.1:5173` in dev and as static `dist/` in prod. The lowest-friction integration is **same-origin relative paths** (`/api/v1/...`) so no CORS, no absolute URLs, and cookies just work.
- **Dev:** Vite `server.proxy` forwards `/api` and `/health` from `:5173` to the runtime on `:3000` (Vite `server.proxy` shape verified against the Vite docs; example in §9).
- **Prod / Docker:** the runtime serves the built frontend (`dist/`) at `/` and the API at `/api/v1` on the same port. Hash routing means no SPA rewrite rules are needed beyond serving `index.html` at `/`.
- **Auth mechanism:** cookie session (HttpOnly) + custom header CSRF guard + short-lived re-auth token for sensitive operations. No bearer tokens in the browser.
- **Mode/labels:** the UI hard-codes `PAPER MODE`; the contract exposes `mode: 'PAPER' | 'LIVE'` on `/api/v1/meta`, `/api/v1/status`, and in every response `meta`, plus the `X-ATRA-Mode` response header, so the badge can become data-driven.

### 2.1 Recommended runtime port: **3000** (configurable)

- The UI assumes nothing. Vite owns 5173. The existing action plan (`docs/research/blockers-action-plan-2026-09-19.md`) already pins `curl http://localhost:3000/health` in the CI smoke job and `forwardPorts:[3000]` for Codespaces. Keep **3000** for consistency: `ATRA_PORT=3000`, `ATRA_HOST=127.0.0.1` (never `0.0.0.0` outside Docker; in `docker-compose.yml` publish as `127.0.0.1:3000:3000`).
- 3000 collides with many dev servers (Next.js, Rails). The runtime must fail fast with `EADDRINUSE` (no auto-increment) and print the fix (`ATRA_PORT=3100`), because the Vite proxy target is fixed.

---

## 3. Transport conventions

| Convention | Rule |
|---|---|
| Prefix | `/api/v1`. Breaking changes → `/api/v2`. `/health` and `/ready` live outside the prefix for Docker/CI |
| Content type | Requests: `Content-Type: application/json; charset=utf-8`. Responses: `application/json` (success) or `application/problem+json` (errors, RFC 9457) |
| Caching | Every `/api/*` response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` |
| Request id | Runtime sets `X-Request-Id` (ULID) on every response; echoes a client-supplied one if present (≤ 64 chars, `[A-Za-z0-9_-]`) |
| Mode header | `X-ATRA-Mode: PAPER` or `LIVE` on every response |
| Success envelope | `{ "data": <T>, "meta": Meta }` where `Meta = { source, asOf, stale, mode, requestId }` (see §5). Lists add `meta.nextCursor` |
| Error envelope | RFC 9457 object + extensions `code` (stable machine string) and `errors[]` (field issues). See §3.1 |
| Time | ISO 8601 UTC with milliseconds, e.g. `2026-09-19T14:32:08.120Z`. The UI formats to local `HH:mm:ss` |
| USD | JSON number, ≤ 6 decimals, or `null` when unknown. Never `NaN`/`Infinity` |
| Token amounts | `TokenAmount { raw: string (integer base units), decimals: number, formatted: string, symbol: string }` — never floats for on-chain quantities |
| Percent | JSON number in percent units (`2.34` = +2.34 %), or `null` |
| Chain ids | Slugs `base | bsc | robinhood | solana`; display names exactly `Base`, `BNB Smart Chain`, `Robinhood Chain`, `Solana` (the UI's `Chain` union) |
| Pagination | Cursor: `?limit=50&cursor=<opaque>` → `meta.nextCursor: string|null`. Max `limit` 200 |
| Idempotency | `Idempotency-Key: <uuid>` header honoured for 24 h on `POST /wallet/withdraw`, `POST /control/emergency-stop`, `POST /mode/live` |
| Rate limits | `429` + `Retry-After` seconds. Login: 5 failures / 60 s per IP, then lock 60 s (doubling, max 15 min) |
| Body limit | 64 KiB for JSON bodies; `413` above |
| Provenance | Any value the runtime cannot verify is `null` and the enclosing object carries `source: 'none'` and `reason` (§8). No placeholder numbers, ever |

### 3.1 Error envelope (RFC 9457 + extensions)

```ts
interface Problem {
  type: string;        // URI; 'about:blank' or 'https://atra.local/problems/<code>'
  title: string;       // short, stable per type
  status: number;      // HTTP status
  detail?: string;     // human-readable, safe to show in the UI's <div role="alert">
  instance?: string;   // '/api/v1/wallet/withdraw' + '#' + requestId
  code: ErrorCode;     // extension — stable machine string
  errors?: { path: (string|number)[]; message: string }[]; // extension — zod-style field issues (422)
  retryAfterSec?: number; // extension — on 429/503
  requestId: string;   // extension
}
type ErrorCode =
  | 'VALIDATION_FAILED' | 'UNAUTHENTICATED' | 'SETUP_REQUIRED' | 'REAUTH_REQUIRED' | 'REAUTH_INVALID'
  | 'FORBIDDEN_ORIGIN' | 'FORBIDDEN_HOST' | 'LOOPBACK_ONLY' | 'RATE_LIMITED'
  | 'WALLET_NOT_CREATED' | 'WALLET_LOCKED' | 'WALLET_ALREADY_EXISTS' | 'INSUFFICIENT_BALANCE' | 'INVALID_ADDRESS' | 'QUOTE_EXPIRED'
  | 'RISK_REJECTED' | 'EMERGENCY_STOP_ACTIVE' | 'PAUSED' | 'LIVE_NOT_ELIGIBLE' | 'CONFIRMATION_REQUIRED'
  | 'PROVIDER_UNAVAILABLE' | 'RPC_UNAVAILABLE' | 'MODEL_UNAVAILABLE' | 'TELEGRAM_NOT_CONFIGURED' | 'PAIR_CODE_EXPIRED'
  | 'NOT_FOUND' | 'CONFLICT' | 'IDEMPOTENCY_MISMATCH' | 'INTERNAL';
```

Example (`422`):

```json
{
  "type": "https://atra.local/problems/VALIDATION_FAILED",
  "title": "Validation failed",
  "status": 422,
  "detail": "Maximum trade size cannot exceed maximum deployed capital.",
  "instance": "/api/v1/risk#01J8ZK7Q4W6X1R9V2M3N4P5S6T",
  "code": "VALIDATION_FAILED",
  "errors": [{ "path": ["trade"], "message": "Maximum trade size cannot exceed maximum deployed capital." }],
  "requestId": "01J8ZK7Q4W6X1R9V2M3N4P5S6T"
}
```

The UI already renders `result.error.issues.map(i => i.message).join(' ')`; the adapter maps `errors[].message` the same way, and `detail` for non-field errors. Status mapping: `400` malformed JSON · `401 UNAUTHENTICATED` · `403` origin/host/loopback/`REAUTH_REQUIRED` · `404` · `409` state conflicts (`WALLET_ALREADY_EXISTS`, `EMERGENCY_STOP_ACTIVE`, `LIVE_NOT_ELIGIBLE`, `TELEGRAM_NOT_CONFIGURED`) · `422` validation · `429` · `503 PROVIDER_UNAVAILABLE|RPC_UNAVAILABLE|MODEL_UNAVAILABLE` · `500 INTERNAL` (never leaks stack traces; logged with `requestId`).

---

## 4. Auth, session cookie, re-authentication, CSRF, DNS rebinding

### 4.1 Model

- Single local **operator password** set at first run (`POST /api/v1/auth/setup`). No user accounts, no OAuth. Password hash: `node:crypto` `scrypt` (N = 2^17, r = 8, p = 1, 32-byte salt, 64-byte key) — built-in, no native dependency. Argon2id is acceptable if the team accepts a native module.
- **Login unlocks the vault**: the password also derives (separate salt, same KDF) the key-encryption key that unwraps the wallet DEK, held in runtime memory until logout / idle expiry / process exit. This is why wallet *creation* and PAPER-mode operations need no extra prompt, matching the current UI.
- **Re-authentication** (`POST /api/v1/auth/reauth`) issues a 5-minute, single-use token bound to the session. Required (header `X-ATRA-Reauth`) by: `POST /wallet/export`, `POST /mode/live`, `POST /wallet/withdraw`, `PUT /settings/provider-secret`, `POST /auth/password`. This is what the UI's two existing `Local password` / `Local re-authentication` fields feed.

### 4.2 Session cookie

| Attribute | Value |
|---|---|
| Name | `atra_session` |
| Value | 32 random bytes, base64url (43 chars). Server stores only `sha256(value)` with `createdAt, lastSeenAt, expiresAt, ip, userAgent` in the runtime SQLite DB |
| Attributes | `HttpOnly; SameSite=Strict; Path=/` + `Secure` when the request arrived over TLS (`ATRA_TLS=1`, or `X-Forwarded-Proto: https` **only** when `ATRA_TRUST_PROXY=1`) |
| Lifetime | Idle 12 h (sliding, refreshed at most once per 5 min), absolute 7 d. `Max-Age` mirrors idle timeout |
| Prefix | Not `__Host-`. Chrome and Firefox treat `http://127.0.0.1` / `http://localhost` as potentially trustworthy, so `Secure` cookies *should* be accepted there, but prefix-cookie support on loopback is reported as inconsistent across engines (httpwg/http-extensions#2605). **UNVERIFIED on this machine's browsers** — use the plain name; revisit when TLS is the default |
| Logout | `POST /auth/logout` deletes the row and sends `Max-Age=0` |

### 4.3 CSRF and cross-origin guards (defence in depth)

1. `SameSite=Strict` cookie.
2. Every non-`GET`/`HEAD` request must carry `X-ATRA-Client: dashboard` (any value; the point is a custom header that a cross-site form cannot send). Missing → `403 FORBIDDEN_ORIGIN`.
3. `Origin` (or `Referer` fallback) must match the runtime's own origin or one of `ATRA_CORS_ORIGINS`. `Sec-Fetch-Site: cross-site` → `403`.
4. **Host allowlist** (DNS-rebinding guard): `Host` must be `localhost[:port]`, `127.0.0.1[:port]`, `[::1][:port]`, or an entry in `ATRA_HOST_ALLOWLIST`. Otherwise `403 FORBIDDEN_HOST` — applies to `/health` as well.
5. `LOOPBACK_ONLY` routes (`/auth/setup`, `/wallet/export`) additionally require the TCP peer address to be loopback (`req.socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}`); behind a reverse proxy they are unavailable by design.

### 4.4 CORS

Not enabled by default (same-origin via proxy or static serving). If `ATRA_CORS_ORIGINS=http://127.0.0.1:5173` is set, respond with `Access-Control-Allow-Origin: <matched origin>`, `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Headers: Content-Type, X-ATRA-Client, X-ATRA-Reauth, Idempotency-Key, X-Request-Id`, `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE`, `Vary: Origin`. Never `*`.

### 4.5 Sequence (first run)

```
GET  /api/v1/meta            -> { setupRequired: true }            (no cookie)
POST /api/v1/auth/setup      { password }  (loopback only)         -> 201 + Set-Cookie atra_session
GET  /api/v1/setup           -> { completed: false, steps: {...} }
POST /api/v1/wallet/create   {}                                    -> 201 { evm: { address }, solana: { address } }
POST /api/v1/setup/complete  { chains, risk: { trade, loss }, paperAck: true } -> 200
GET  /api/v1/overview        -> real (empty) portfolio, mode PAPER
```

Subsequent runs: `GET /auth/session` → `401 UNAUTHENTICATED` → UI shows the unlock dialog → `POST /auth/login`.

---

## 5. Shared TypeScript types (`api.types.ts`)

Copy-pasteable. Field names match the UI's existing types wherever one exists (`Market`, `Research`, `RiskLimits` numerics, `Settings` enums).

```ts
// ---------- primitives ----------
export type ChainId = 'base' | 'bsc' | 'robinhood' | 'solana';
export type ChainName = 'Base' | 'BNB Smart Chain' | 'Robinhood Chain' | 'Solana';
export type Mode = 'PAPER' | 'LIVE';
export type Source = 'runtime' | 'paper-sim' | 'chain-rpc' | `provider:${string}` | `model:${string}` | 'none';
export type IsoDate = string;               // 2026-09-19T14:32:08.120Z
export type Usd = number | null;            // null = unknown, never fabricated

export interface Meta {
  source: Source;
  asOf: IsoDate | null;
  stale: boolean;                            // true when asOf older than the route's freshness budget
  mode: Mode;
  requestId: string;
  reason?: UnavailableReason;                // set when source === 'none'
  nextCursor?: string | null;                // lists only
}
export type UnavailableReason =
  | 'NO_PROVIDER' | 'PROVIDER_ERROR' | 'RPC_ERROR' | 'WALLET_NOT_CREATED' | 'NO_HISTORY'
  | 'NOT_SUPPORTED_ON_CHAIN' | 'MODEL_NOT_LOADED' | 'NOT_CONFIGURED' | 'PAPER_ONLY';
export interface Envelope<T> { data: T; meta: Meta }

export interface TokenAmount { raw: string; decimals: number; formatted: string; symbol: string }
export interface UsdValue { usd: Usd; source: Source; asOf: IsoDate | null }

export interface ChainInfo {
  id: ChainId; name: ChainName; family: 'evm' | 'solana';
  chainId: number | null;                    // 8453 | 56 | 4663 | null (Solana has no numeric id)
  nativeSymbol: 'ETH' | 'BNB' | 'SOL';
  explorer: string;                          // base URL
  enabled: boolean;                          // from settings.chains
  rpc: { configured: boolean; reachable: boolean | null; latencyMs: number | null; checkedAt: IsoDate | null };
}

// ---------- meta / status ----------
export interface RuntimeMeta {
  name: 'atra-runtime'; version: string; apiVersion: 1; mode: Mode; ci: boolean;
  setupRequired: boolean; authenticated: boolean;
  chains: ChainInfo[];
  features: {
    telegram: 'configured' | 'not_configured';
    marketData: 'configured' | 'not_configured';
    model: { preferred: 'atra' | 'local' | 'external'; status: 'available' | 'unavailable' | 'untrained'; detail: string };
    liveExecution: 'available' | 'blocked';
    lpProtocols: string[];                   // [] at launch
  };
}
export interface ControlState {
  paused: boolean; pausedAt: IsoDate | null; pausedBy: 'user' | 'telegram' | 'runtime' | null;
  emergencyStop: { active: boolean; since: IsoDate | null; reason: string | null; clearedAt: IsoDate | null };
}
export interface RuntimeStatus {
  connected: true; version: string; startedAt: IsoDate; uptimeSec: number; mode: Mode; ci: boolean;
  control: ControlState;
  wallet: { evm: WalletSlotStatus; solana: WalletSlotStatus; vaultUnlocked: boolean };
  gas: Record<ChainId, GasStatus>;
  chainsEnabled: ChainId[];
  agents: AgentSummary[];
  providers: { rpc: Record<ChainId, ProviderHealth>; marketData: ProviderHealth; model: ProviderHealth };
  telegram: { configured: boolean; paired: boolean };
  lastAgentAction: { agent: AgentId; summary: string; at: IsoDate } | null;
}
export interface WalletSlotStatus { created: boolean; address: string | null; createdAt: IsoDate | null }
export type GasStatus = 'ok' | 'low' | 'empty' | 'unverified';   // thresholds in §8
export interface ProviderHealth { kind: string; configured: boolean; reachable: boolean | null; latencyMs: number | null; checkedAt: IsoDate | null; detail: string | null }

// ---------- overview ----------
export interface Overview {
  portfolio: {
    totalUsd: Usd; availableUsd: Usd; deployedUsd: Usd; availablePct: number | null; deployedPct: number | null;
    todayPnlUsd: Usd; todayPnlPct: number | null;
    source: Source; asOf: IsoDate | null; simulated: boolean;    // simulated === (mode === 'PAPER')
  };
  riskUsage: { dailyLossUsd: Usd; dailyLossLimitUsd: number; deployedUsd: Usd; deployedLimitUsd: number; utilizationPct: number | null };
  openTrades: number; activeLpPositions: number; lpInRange: number;
  lastAgentAction: { agent: AgentId; agentName: string; summary: string; at: IsoDate } | null;
  agents: AgentSummary[];
  control: ControlState;
}
export interface HistoryPoint { t: IsoDate; valueUsd: number }
export interface PortfolioHistory { range: '1D' | '1W' | '1M'; points: HistoryPoint[]; source: Source; firstSnapshotAt: IsoDate | null }

// ---------- agents ----------
export type AgentId = 'research' | 'trader' | 'liquidity';
export type AgentState = 'idle' | 'running' | 'paused' | 'disabled' | 'stopped' | 'error';
export interface AgentSummary { id: AgentId; name: 'Research Agent' | 'Trader Agent' | 'Liquidity Manager'; enabled: boolean; state: AgentState; task: string }
export interface Agent extends AgentSummary {
  schedule: { everySec: number; human: string };                // { 300, 'Every 5 minutes' }
  lastRun: { at: IsoDate; summary: string; outcome: 'completed' | 'no_action' | 'blocked' | 'error' } | null;
  nextRunAt: IsoDate | null;                                     // null when disabled/paused/stopped
}

// ---------- market ----------
export interface Market {                                        // identical to src/data/services.ts Market + provenance
  id: string;                                                    // `${symbol.toLowerCase()}-${chainId}` e.g. 'eth-base'
  symbol: string; name: string; chain: ChainName;
  price: number | null; change: number | null; volume: number | null; liquidity: number | null;
  pool: string;                                                  // 'ETH / USDC' or 'Not configured'
  history: number[];                                             // normalised 0..100 sparkline, [] when unavailable
  // additions (ignored by current UI)
  chainId: ChainId; address: string | null; decimals: number | null;
  updatedAt: IsoDate | null; source: Source; reason?: UnavailableReason;
}
export interface MarketDetail extends Market {
  exposure: { agentUsd: Usd; openPositions: number; lpPositions: number; source: Source };
  execution: { supported: boolean; reason: string | null };
}
export interface Research {                                      // identical shape to the UI
  observed: string; interpretation: string; risks: string; missing: string;
  action: 'NO ACTION' | 'PROPOSE_TRADE' | 'PROPOSE_LP';        // research never executes; proposals go to the risk engine
  model: string; generatedAt: IsoDate; source: Source; inputSnapshotId: string;
}

// ---------- trading ----------
export interface Position {
  id: string; asset: string; chain: ChainName; chainId: ChainId; side: 'LONG';
  size: TokenAmount; entryUsd: number; currentUsd: Usd; pnlUsd: Usd; pnlPct: number | null;
  status: 'SIMULATED' | 'OPEN' | 'CLOSING' | 'CLOSED'; openedAt: IsoDate; source: Source;
}
export interface Decision {
  id: string; at: IsoDate; market: string;                       // 'SOL / USDC'
  proposed: 'OPEN' | 'CLOSE' | 'NO ACTION';
  riskResult: 'passed' | 'rejected' | 'not_evaluated'; riskRule: string | null;
  finalAction: 'SIMULATED' | 'EXECUTED' | 'NO ACTION' | 'FAILED'; reason: string; activityId: string;
}
export interface TradingView {
  status: { enabled: boolean; paused: boolean; lastCycleAt: IsoDate | null; nextCycleAt: IsoDate | null };
  positions: Position[]; decisions: Decision[];
}

// ---------- liquidity ----------
export type LpAction = 'HOLD' | 'ADD' | 'REMOVE' | 'REBALANCE' | 'COLLECT FEES' | 'EXIT';
export interface LpPosition {
  id: string; pool: string; chain: ChainName; chainId: ChainId; protocol: string;
  valueUsd: Usd; range: { lowerUsd: number; upperUsd: number; inRange: boolean } | null; feesUsd: Usd;
  lastRebalanceAt: IsoDate | null; status: 'SIMULATED' | 'ACTIVE' | 'OUT_OF_RANGE' | 'CLOSED'; source: Source;
}
export interface LiquidityView {
  summary: { totalValueUsd: Usd; activePositions: number; unclaimedFeesUsd: Usd; requiresAttention: number };
  positions: LpPosition[];
  actions: { id: string; at: IsoDate; pool: string; action: LpAction; note: string; activityId: string }[];
  supportedProtocols: { id: string; name: string; chains: ChainId[] }[];   // [] at launch
}

// ---------- wallet ----------
export interface ChainBalance {
  chainId: ChainId; chain: ChainName;
  native: { symbol: string; amount: TokenAmount | null; value: UsdValue };
  tokens: { symbol: string; address: string; amount: TokenAmount; value: UsdValue }[];
  gas: GasStatus; source: Source; asOf: IsoDate | null; reason?: UnavailableReason;
}
export interface WalletView {
  evm: { created: boolean; address: string | null; chains: ChainBalance[] };
  solana: { created: boolean; address: string | null; balance: ChainBalance | null };
  totalUsd: Usd; vaultUnlocked: boolean;
}
export interface DepositAddress { chainId: ChainId; chain: ChainName; address: string; nativeGasSymbol: string; qrSvg: string | null; warnings: string[] }
export type WithdrawAsset = 'USDC' | 'ETH' | 'BNB' | 'SOL';
export interface WithdrawQuoteRequest { chainId: ChainId; asset: WithdrawAsset; destination: string; amount: string | 'all' }
export interface WithdrawQuote {
  quoteId: string; expiresAt: IsoDate; chainId: ChainId; asset: WithdrawAsset; destination: string;
  amount: TokenAmount; availableBalance: TokenAmount | null; fee: { native: TokenAmount | null; usd: Usd; source: Source };
  remainingBalance: TokenAmount | null; requiresTypedConfirmation: boolean;   // true when 'all' or usd >= 1000
  warnings: string[]; mode: Mode;
}
export interface WithdrawRequest { quoteId: string; ack: true; confirmation?: 'WITHDRAW' }
export interface WithdrawResult { txId: string; txHash: string | null; status: 'submitted' | 'confirmed' | 'failed'; explorerUrl: string | null; activityId: string }
export interface WalletExportRequest { ack: 'I UNDERSTAND AN EXPORTED KEY GRANTS FULL ACCESS TO MY FUNDS'; format?: 'keystore' | 'raw' }
export interface WalletExport {
  format: 'keystore' | 'raw'; exportedAt: IsoDate; activityId: string;
  evm: { address: string; keystoreV3?: object; privateKeyHex?: string };
  solana: { address: string; secretKeyBase58?: string; keypairJson?: number[] };
}

// ---------- risk ----------
export interface RiskLimits {                                     // numerics identical to UI RiskSchema; lists are arrays
  trade: number; loss: number; capital: number; slippage: number; fee: number; cooldown: number; liquidity: number;
  tokens: string[]; protocols: string[];
}
export interface RiskView {
  limits: RiskLimits; updatedAt: IsoDate | null;
  usage: { dailyLossUsd: Usd; dailyLossLimitUsd: number; deployedUsd: Usd; cooldownRemainingSec: number; lastActionAt: IsoDate | null; source: Source };
  control: ControlState;
}
export interface LiveEligibility {
  eligible: boolean;
  checks: { id: 'wallet_funded' | 'gas_available' | 'risk_reviewed' | 'protocols_supported'; label: string; status: 'verified' | 'failed' | 'unverified'; detail: string }[];
  checkedAt: IsoDate;
}

// ---------- activity ----------
export type ActivityCategory = 'research' | 'trade' | 'liquidity' | 'wallet' | 'risk' | 'system';
export type ActivityResult = 'Completed' | 'Blocked' | 'Hold' | 'Simulated' | 'Executed' | 'Failed' | 'Info';
export interface ActivityEvent {
  id: string;                                                    // ULID; UI shows it in the Reference column
  at: IsoDate; category: ActivityCategory; chain: ChainName | null; agent: AgentId | null;
  action: string; result: ActivityResult; detail: string;
  audit: { inputSnapshotId: string | null; mode: Mode; riskDecision: { status: 'passed' | 'rejected' | 'not_evaluated'; rule: string | null; detail: string | null } | null; txHash: string | null; explorerUrl: string | null };
}

// ---------- telegram ----------
export interface TelegramView {
  configured: boolean; paired: boolean; botUrl: string | null; botUsername: string | null;
  account: { displayName: string; userIdMasked: string; pairedAt: IsoDate } | null;
  installation: string;                                          // settings.name
  notifications: { riskRejections: boolean; tradeDecisions: boolean; liquidityUpdates: boolean; runtimeAlerts: boolean };
}
export interface PairCode { code: string; command: string; expiresAt: IsoDate; botUrl: string | null }

// ---------- settings / setup ----------
export interface RuntimeSettings {
  name: string; chains: ChainId[];
  provider: { kind: 'custom' | 'hosted'; endpoint: string; hasSecret: boolean; status: 'connected' | 'not_connected' | 'error'; detail: string | null };
  model: { preferred: 'atra' | 'local' | 'external'; endpoint: string | null; status: 'available' | 'unavailable' | 'untrained'; detail: string };
  updatedAt: IsoDate | null;
}
export interface SettingsUpdate { name: string; chains: ChainId[]; provider: { kind: 'custom' | 'hosted'; endpoint: string }; model: { preferred: 'atra' | 'local' | 'external'; endpoint?: string | null } }
export interface SetupState { completed: boolean; completedAt: IsoDate | null; steps: { password: boolean; chains: boolean; wallets: boolean; risk: boolean; telegram: boolean; paperAck: boolean } }
export interface SetupComplete { chains: ChainId[]; risk: { trade: number; loss: number }; paperAck: true }

// ---------- auth ----------
export interface SessionInfo { authenticated: boolean; setupRequired: boolean; expiresAt: IsoDate | null; vaultUnlocked: boolean }
export interface ReauthToken { token: string; expiresAt: IsoDate }
```

---

## 6. Routes

Legend — **Auth:** `none` · `session` (cookie) · `session+reauth` (cookie + `X-ATRA-Reauth`) · `loopback` (TCP peer must be loopback). All non-GET routes also require `X-ATRA-Client: dashboard` and pass the Origin/Host guards (§4.3). Every success body is `{ data, meta }` unless stated.

### 6.1 System

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness for Docker `HEALTHCHECK` / CI. Body is **not** enveloped |
| GET | `/ready` | none | Readiness: DB open, config loaded. `503` until ready |
| GET | `/api/v1/meta` | none | Runtime identity, mode, chains, features, `setupRequired` |

`GET /health` → `200`
```json
{ "status": "ok", "version": "0.1.0", "mode": "PAPER", "ci": false, "uptimeSec": 4021 }
```

`GET /api/v1/meta` → `200 Envelope<RuntimeMeta>`
```json
{ "data": { "name": "atra-runtime", "version": "0.1.0", "apiVersion": 1, "mode": "PAPER", "ci": false, "setupRequired": false, "authenticated": true,
  "chains": [
    { "id": "base", "name": "Base", "family": "evm", "chainId": 8453, "nativeSymbol": "ETH", "explorer": "https://basescan.org", "enabled": true, "rpc": { "configured": true, "reachable": true, "latencyMs": 84, "checkedAt": "2026-09-19T14:30:00.000Z" } },
    { "id": "bsc", "name": "BNB Smart Chain", "family": "evm", "chainId": 56, "nativeSymbol": "BNB", "explorer": "https://bscscan.com", "enabled": true, "rpc": { "configured": true, "reachable": true, "latencyMs": 120, "checkedAt": "2026-09-19T14:30:00.000Z" } },
    { "id": "robinhood", "name": "Robinhood Chain", "family": "evm", "chainId": 4663, "nativeSymbol": "ETH", "explorer": "https://robinhoodchain.blockscout.com", "enabled": true, "rpc": { "configured": true, "reachable": null, "latencyMs": null, "checkedAt": null } },
    { "id": "solana", "name": "Solana", "family": "solana", "chainId": null, "nativeSymbol": "SOL", "explorer": "https://explorer.solana.com", "enabled": true, "rpc": { "configured": true, "reachable": true, "latencyMs": 210, "checkedAt": "2026-09-19T14:30:00.000Z" } }
  ],
  "features": { "telegram": "not_configured", "marketData": "not_configured", "model": { "preferred": "atra", "status": "untrained", "detail": "UNTRAINED — no fine-tuning run has been performed" }, "liveExecution": "blocked", "lpProtocols": [] } },
  "meta": { "source": "runtime", "asOf": "2026-09-19T14:32:08.120Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK7Q4W6X1R9V2M3N4P5S6T" } }
```

### 6.2 Auth

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/v1/auth/session` | none | — | `200 Envelope<SessionInfo>`; `401 UNAUTHENTICATED` when no/expired cookie (body still includes `setupRequired`) |
| POST | `/api/v1/auth/setup` | loopback | `{ password: string }` (12–256 chars) | `201 Envelope<SessionInfo>` + `Set-Cookie`. `409 CONFLICT` if a password already exists |
| POST | `/api/v1/auth/login` | none | `{ password: string }` | `200 Envelope<SessionInfo>` + `Set-Cookie`; `401`; `429 RATE_LIMITED` |
| POST | `/api/v1/auth/logout` | session | — | `204` + cookie cleared; vault key wiped from memory |
| POST | `/api/v1/auth/reauth` | session | `{ password: string }` | `200 Envelope<ReauthToken>` (5 min, single use); `401 REAUTH_INVALID` |
| POST | `/api/v1/auth/password` | session+reauth | `{ newPassword: string }` | `204`; re-wraps the vault DEK; all other sessions revoked |

```json
{ "data": { "authenticated": true, "setupRequired": false, "expiresAt": "2026-09-20T02:32:08.120Z", "vaultUnlocked": true }, "meta": { "source": "runtime", "asOf": "2026-09-19T14:32:08.120Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8A…" } }
```

### 6.3 Status, overview, history

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/api/v1/status` | session | `Envelope<RuntimeStatus>` — feeds top bar, sidebar, System health panel |
| GET | `/api/v1/overview` | session | `Envelope<Overview>` — feeds the four metric cards, stats row, agent strip |
| GET | `/api/v1/overview/history?range=1D\|1W\|1M` | session | `Envelope<PortfolioHistory>` — feeds `PortfolioChart` |

`GET /api/v1/overview` → `200` (fresh PAPER install: honest zeros and nulls)
```json
{ "data": {
  "portfolio": { "totalUsd": 0, "availableUsd": 0, "deployedUsd": 0, "availablePct": null, "deployedPct": null, "todayPnlUsd": null, "todayPnlPct": null, "source": "chain-rpc", "asOf": "2026-09-19T14:31:50.000Z", "simulated": true },
  "riskUsage": { "dailyLossUsd": 0, "dailyLossLimitUsd": 100, "deployedUsd": 0, "deployedLimitUsd": 5000, "utilizationPct": 0 },
  "openTrades": 0, "activeLpPositions": 0, "lpInRange": 0,
  "lastAgentAction": null,
  "agents": [
    { "id": "research", "name": "Research Agent", "enabled": true, "state": "idle", "task": "Monitoring markets" },
    { "id": "trader", "name": "Trader Agent", "enabled": true, "state": "idle", "task": "Awaiting signal" },
    { "id": "liquidity", "name": "Liquidity Manager", "enabled": true, "state": "idle", "task": "Monitoring range" } ],
  "control": { "paused": false, "pausedAt": null, "pausedBy": null, "emergencyStop": { "active": false, "since": null, "reason": null, "clearedAt": null } } },
  "meta": { "source": "runtime", "asOf": "2026-09-19T14:32:08.120Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8B…" } }
```

`GET /api/v1/overview/history?range=1W` with no snapshots yet → `200`
```json
{ "data": { "range": "1W", "points": [], "source": "none", "firstSnapshotAt": null }, "meta": { "source": "none", "reason": "NO_HISTORY", "asOf": null, "stale": false, "mode": "PAPER", "requestId": "01J8ZK8C…" } }
```
Point density: `1D` → 5-min snapshots (≤ 288), `1W` → 1-h (≤ 168), `1M` → 6-h (≤ 124). The runtime records a portfolio snapshot every 5 min while running.

### 6.4 Controls and mode

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/api/v1/control/pause` | session | `{ reason?: string }` | `200 Envelope<ControlState>` |
| POST | `/api/v1/control/resume` | session | — | `200 Envelope<ControlState>`; `409 EMERGENCY_STOP_ACTIVE` while stopped |
| POST | `/api/v1/control/emergency-stop` | session | `{ ack: true, reason?: string }` (+ `Idempotency-Key`) | `200 Envelope<ControlState>` with `emergencyStop.active=true`, `paused=true`. Cancels scheduled agent runs; in-flight signed txs are **not** reversible |
| POST | `/api/v1/control/emergency-stop/clear` | session | `{ ack: true }` | `200 Envelope<ControlState>` — stop cleared, **stays paused** (mirrors the UI's "Clear … and stay paused") |
| GET | `/api/v1/mode` | session | — | `200 Envelope<{ mode: Mode; live: LiveEligibility }>` |
| POST | `/api/v1/mode/live` | session+reauth | `{ ack: true }` | `200 Envelope<{ mode: 'LIVE' }>`; `409 LIVE_NOT_ELIGIBLE` with `live: LiveEligibility` in the problem body's extension `live` |
| POST | `/api/v1/mode/paper` | session | `{ ack: true }` | `200 Envelope<{ mode: 'PAPER' }>` — always allowed; open LIVE positions are left untouched and flagged |

Control state and mode persist in SQLite across restarts; an emergency stop survives a restart until explicitly cleared. Telegram `/pause`, `/resume`, `/emergency` map to the same handlers with `pausedBy: 'telegram'`.

`GET /api/v1/mode` → `200`
```json
{ "data": { "mode": "PAPER", "live": { "eligible": false, "checkedAt": "2026-09-19T14:32:08.120Z", "checks": [
  { "id": "wallet_funded", "label": "Agent Wallet funded", "status": "failed", "detail": "No balance above $1.00 on any enabled chain." },
  { "id": "gas_available", "label": "Gas available", "status": "failed", "detail": "base: 0 ETH; bsc: 0 BNB; robinhood: unverified (RPC unreachable); solana: 0 SOL" },
  { "id": "risk_reviewed", "label": "Risk limits reviewed", "status": "verified", "detail": "Saved 2026-09-19T14:10:02Z" },
  { "id": "protocols_supported", "label": "Supported protocols only", "status": "failed", "detail": "No execution adapters registered in this build." } ] } },
  "meta": { "source": "runtime", "asOf": "2026-09-19T14:32:08.120Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8D…" } }
```

### 6.5 Agents

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/v1/agents` | session | — | `Envelope<Agent[]>` (always exactly the three ids) |
| GET | `/api/v1/agents/{id}` | session | — | `Envelope<Agent>` |
| PATCH | `/api/v1/agents/{id}` | session | `{ enabled: boolean }` | `Envelope<Agent>` |
| POST | `/api/v1/agents/{id}/run` | session | — | `202 Envelope<{ queued: true; runId: string }>`; `409 PAUSED` / `EMERGENCY_STOP_ACTIVE` |

```json
{ "data": [ { "id": "research", "name": "Research Agent", "enabled": true, "state": "idle", "task": "Analyzing market observations", "schedule": { "everySec": 300, "human": "Every 5 minutes" }, "lastRun": { "at": "2026-09-19T14:30:00.000Z", "summary": "Research completed. No action proposed.", "outcome": "no_action" }, "nextRunAt": "2026-09-19T14:35:00.000Z" },
  { "id": "trader", "name": "Trader Agent", "enabled": true, "state": "idle", "task": "Waiting for an eligible proposal", "schedule": { "everySec": 900, "human": "Every 15 minutes" }, "lastRun": null, "nextRunAt": "2026-09-19T14:45:00.000Z" },
  { "id": "liquidity", "name": "Liquidity Manager", "enabled": true, "state": "idle", "task": "Monitoring liquidity ranges", "schedule": { "everySec": 1800, "human": "Every 30 minutes" }, "lastRun": null, "nextRunAt": "2026-09-19T15:00:00.000Z" } ],
  "meta": { "source": "runtime", "asOf": "2026-09-19T14:32:08.120Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8E…" } }
```

### 6.6 Market

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/v1/market?chain=base&q=sol&sort=volume\|price\|change\|name&limit=&cursor=` | session | — | `Envelope<Market[]>`; `meta.stale=true` if provider snapshot > 5 min old; `503 PROVIDER_UNAVAILABLE` only when **no** cached snapshot exists (else serve stale) |
| GET | `/api/v1/market/{id}` | session | — | `Envelope<MarketDetail>`; `404` |
| POST | `/api/v1/market/{id}/research` | session | `{}` | `200 Envelope<Research>`; `503 MODEL_UNAVAILABLE`; `409 PAUSED`? **No** — research is read-only and allowed while paused; blocked only by emergency stop (`409 EMERGENCY_STOP_ACTIVE`) |
| GET | `/api/v1/watchlist` | session | — | `Envelope<{ ids: string[] }>` |
| PUT | `/api/v1/watchlist` | session | `{ ids: string[] }` | `Envelope<{ ids: string[] }>` |

`GET /api/v1/market` → `200` (one row with a provider, one chain with none — note no fabricated numbers)
```json
{ "data": [
  { "id": "eth-base", "symbol": "ETH", "name": "Ethereum", "chain": "Base", "chainId": "base", "address": null, "decimals": 18, "price": 2842.65, "change": 2.34, "volume": 18420000, "liquidity": 12650000, "pool": "ETH / USDC", "history": [34,30,37,33,45,40,51,48,54,49,63,60,68,64,78], "updatedAt": "2026-09-19T14:30:00.000Z", "source": "provider:example" },
  { "id": "eth-robinhood", "symbol": "ETH", "name": "Ethereum", "chain": "Robinhood Chain", "chainId": "robinhood", "address": null, "decimals": 18, "price": null, "change": null, "volume": null, "liquidity": null, "pool": "Not configured", "history": [], "updatedAt": null, "source": "none", "reason": "NO_PROVIDER" } ],
  "meta": { "source": "provider:example", "asOf": "2026-09-19T14:30:00.000Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8F…", "nextCursor": null } }
```
(The numbers above are the UI's own fixture values reused purely as a shape example; a real response carries only provider data.)

`POST /api/v1/market/eth-base/research` → `200`
```json
{ "data": { "observed": "ETH on Base. Price 2,842.65 USD, 24h change +2.34 %, liquidity 12.65M USD (provider:example, 14:30:00Z).", "interpretation": "…", "risks": "…", "missing": "Verified contract metadata for the quoted pool.", "action": "NO ACTION", "model": "local:qwen3-4b-q4_k_m (UNTRAINED)", "generatedAt": "2026-09-19T14:32:40.000Z", "source": "model:local", "inputSnapshotId": "01J8ZK8G…" }, "meta": { "source": "model:local", "asOf": "2026-09-19T14:32:40.000Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8G…" } }
```
The Playwright market test asserts the literal text `NO ACTION` after research; the enum keeps that spelling.

### 6.7 Trading

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/api/v1/trading` | session | `Envelope<TradingView>` (positions + last 50 decisions + cycle status) |
| GET | `/api/v1/trading/positions` | session | `Envelope<Position[]>` |
| GET | `/api/v1/trading/decisions?limit=&cursor=` | session | `Envelope<Decision[]>` |

There is **no** "execute trade" route for the dashboard. Trades are proposed by agents and gated by the risk engine; the UI only observes. (`tradingService.execute` in the UI throws today and should keep throwing — see §9.)

```json
{ "data": { "status": { "enabled": true, "paused": false, "lastCycleAt": "2026-09-19T14:30:00.000Z", "nextCycleAt": "2026-09-19T14:45:00.000Z" },
  "positions": [ { "id": "01J8ZK…", "asset": "ETH", "chain": "Base", "chainId": "base", "side": "LONG", "size": { "raw": "800000000000000000", "decimals": 18, "formatted": "0.80", "symbol": "ETH" }, "entryUsd": 2790, "currentUsd": 2842.65, "pnlUsd": 42.12, "pnlPct": 1.89, "status": "SIMULATED", "openedAt": "2026-09-19T14:25:03.000Z", "source": "paper-sim" } ],
  "decisions": [ { "id": "01J8ZK…", "at": "2026-09-19T14:30:42.000Z", "market": "SOL / USDC", "proposed": "OPEN", "riskResult": "rejected", "riskRule": "max_trade_usd", "finalAction": "NO ACTION", "reason": "$600 exceeds $500 trade limit", "activityId": "01J8ZK…" } ] },
  "meta": { "source": "paper-sim", "asOf": "2026-09-19T14:32:08.120Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8H…" } }
```

### 6.8 Liquidity

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/api/v1/liquidity` | session | `Envelope<LiquidityView>` |

At launch `supportedProtocols: []`, `positions: []`, `summary` zeros with `source: 'runtime'` (zero is a real count, not a placeholder). The UI's disabled "Fee collection threshold" stays disabled until `supportedProtocols.length > 0`.

### 6.9 Wallet

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/v1/wallet` | session | — | `Envelope<WalletView>` |
| POST | `/api/v1/wallet/create` | session | `{}` | `201 Envelope<{ evm: WalletSlotStatus; solana: WalletSlotStatus }>`; `409 WALLET_ALREADY_EXISTS`; `423 WALLET_LOCKED` if the vault key is not in memory |
| GET | `/api/v1/wallet/deposit-address?chain=base` | session | — | `Envelope<DepositAddress>`; `409 WALLET_NOT_CREATED` |
| POST | `/api/v1/wallet/withdraw/quote` | session | `WithdrawQuoteRequest` | `200 Envelope<WithdrawQuote>`; `422 INVALID_ADDRESS`; `409 INSUFFICIENT_BALANCE`; `503 RPC_UNAVAILABLE` (fee unknown → quote is still returned with `fee.native=null`, `fee.source='none'` and the client must not proceed to submit; submit rejects `409 QUOTE_EXPIRED\|CONFLICT` when fee is unknown) |
| POST | `/api/v1/wallet/withdraw` | session+reauth | `WithdrawRequest` (+ `Idempotency-Key`) | `202 Envelope<WithdrawResult>`; `409 QUOTE_EXPIRED`; `422 CONFIRMATION_REQUIRED` when `requiresTypedConfirmation` and `confirmation !== 'WITHDRAW'` |
| GET | `/api/v1/wallet/transactions?limit=&cursor=` | session | — | `Envelope<WithdrawResult[]>` (user-initiated transfers only; agent txs are in Activity) |
| POST | `/api/v1/wallet/export` | session+reauth+loopback | `WalletExportRequest` | `200 Envelope<WalletExport>` with `Cache-Control: no-store`; writes a `wallet` activity event; `403 LOOPBACK_ONLY` |

Withdrawals are **user-initiated transfers of the user's own funds** and are permitted in PAPER mode (PAPER blocks *agent* signing, not the owner's withdrawals). They always require a fresh re-auth token. Quote validity: 90 s. Address validation on the server must be at least as strict as the UI (§10) and must additionally EIP-55-checksum-validate mixed-case EVM addresses and reject the zero address.

`GET /api/v1/wallet` (created, unfunded, one RPC down) → `200`
```json
{ "data": { "vaultUnlocked": true, "totalUsd": 0,
  "evm": { "created": true, "address": "0x1111111111111111111111111111111111111111", "chains": [
    { "chainId": "base", "chain": "Base", "native": { "symbol": "ETH", "amount": { "raw": "0", "decimals": 18, "formatted": "0", "symbol": "ETH" }, "value": { "usd": 0, "source": "provider:example", "asOf": "2026-09-19T14:30:00.000Z" } }, "tokens": [], "gas": "empty", "source": "chain-rpc", "asOf": "2026-09-19T14:31:50.000Z" },
    { "chainId": "bsc", "chain": "BNB Smart Chain", "native": { "symbol": "BNB", "amount": { "raw": "0", "decimals": 18, "formatted": "0", "symbol": "BNB" }, "value": { "usd": 0, "source": "provider:example", "asOf": "2026-09-19T14:30:00.000Z" } }, "tokens": [], "gas": "empty", "source": "chain-rpc", "asOf": "2026-09-19T14:31:50.000Z" },
    { "chainId": "robinhood", "chain": "Robinhood Chain", "native": { "symbol": "ETH", "amount": null, "value": { "usd": null, "source": "none", "asOf": null } }, "tokens": [], "gas": "unverified", "source": "none", "asOf": null, "reason": "RPC_ERROR" } ] },
  "solana": { "created": true, "address": "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV", "balance": { "chainId": "solana", "chain": "Solana", "native": { "symbol": "SOL", "amount": { "raw": "0", "decimals": 9, "formatted": "0", "symbol": "SOL" }, "value": { "usd": 0, "source": "provider:example", "asOf": "2026-09-19T14:30:00.000Z" } }, "tokens": [], "gas": "empty", "source": "chain-rpc", "asOf": "2026-09-19T14:31:50.000Z" } } },
  "meta": { "source": "chain-rpc", "asOf": "2026-09-19T14:31:50.000Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8J…" } }
```
(Addresses above are syntactic placeholders for the example only; the runtime returns the vault's real public keys.)

`POST /api/v1/wallet/withdraw/quote`
```json
{ "chainId": "base", "asset": "USDC", "destination": "0x1111111111111111111111111111111111111111", "amount": "25" }
```
→ `200`
```json
{ "data": { "quoteId": "01J8ZK8K…", "expiresAt": "2026-09-19T14:33:38.000Z", "chainId": "base", "asset": "USDC", "destination": "0x1111111111111111111111111111111111111111",
  "amount": { "raw": "25000000", "decimals": 6, "formatted": "25.00", "symbol": "USDC" },
  "availableBalance": { "raw": "0", "decimals": 6, "formatted": "0.00", "symbol": "USDC" },
  "fee": { "native": { "raw": "21000000000000", "decimals": 18, "formatted": "0.000021", "symbol": "ETH" }, "usd": 0.06, "source": "chain-rpc" },
  "remainingBalance": null, "requiresTypedConfirmation": false, "warnings": ["Insufficient USDC balance: 0.00 available."], "mode": "PAPER" },
  "meta": { "source": "chain-rpc", "asOf": "2026-09-19T14:32:08.120Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8K…" } }
```

### 6.10 Risk

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/v1/risk` | session | — | `Envelope<RiskView>` |
| PUT | `/api/v1/risk` | session | `RiskLimits` | `200 Envelope<RiskView>`; `422 VALIDATION_FAILED` with `errors[]` using the UI's messages |

Server-side bounds are the single source of truth and must equal the UI's zod schema: `trade 1..1e6`, `loss 1..1e6`, `capital 1..1e7`, `slippage 0.01..5`, `fee 0..1000`, `cooldown int 1..1440`, `liquidity ≥ 1000`, `trade ≤ capital` (message `Maximum trade size cannot exceed maximum deployed capital.`, path `['trade']`). `tokens` entries: uppercase symbols `^[A-Z0-9]{2,12}$`, deduplicated; `protocols` must be ⊆ `supportedProtocols` ids (empty allowed). Changing limits writes a `risk` activity event and bumps `updatedAt` (feeds the `risk_reviewed` live check).

```json
{ "data": { "limits": { "trade": 500, "loss": 100, "capital": 5000, "slippage": 0.5, "fee": 5, "cooldown": 15, "liquidity": 100000, "tokens": ["ETH","SOL","BNB","USDC"], "protocols": [] }, "updatedAt": "2026-09-19T14:10:02.000Z",
  "usage": { "dailyLossUsd": 0, "dailyLossLimitUsd": 100, "deployedUsd": 0, "cooldownRemainingSec": 0, "lastActionAt": null, "source": "runtime" },
  "control": { "paused": false, "pausedAt": null, "pausedBy": null, "emergencyStop": { "active": false, "since": null, "reason": null, "clearedAt": null } } },
  "meta": { "source": "runtime", "asOf": "2026-09-19T14:32:08.120Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8L…" } }
```

### 6.11 Activity (audit log)

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/api/v1/activity?category=all\|research\|trade\|liquidity\|wallet\|risk\|system&chain=&limit=50&cursor=` | session | `Envelope<ActivityEvent[]>` newest first |
| GET | `/api/v1/activity/{id}` | session | `Envelope<ActivityEvent & { inputSnapshot: object \| null }>` |
| GET | `/api/v1/activity/export?format=jsonl\|csv` | session | file download (`Content-Disposition: attachment`), secrets-free by construction |

```json
{ "data": [ { "id": "01J8ZK7Q4W6X1R9V2M3N4P5S6T", "at": "2026-09-19T14:30:42.000Z", "category": "risk", "chain": "Solana", "agent": "trader", "action": "Position size limit checked", "result": "Blocked", "detail": "A simulated $600 position exceeded the $500 maximum trade size. The deterministic check rejected the proposal.",
  "audit": { "inputSnapshotId": "01J8ZK7P…", "mode": "PAPER", "riskDecision": { "status": "rejected", "rule": "max_trade_usd", "detail": "600 > 500" }, "txHash": null, "explorerUrl": null } } ],
  "meta": { "source": "runtime", "asOf": "2026-09-19T14:32:08.120Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8M…", "nextCursor": "01J8ZK7Q4W6X1R9V2M3N4P5S6T" } }
```
Activity rows are append-only; the runtime never stores private keys, provider secrets, or the session cookie in them (enforced by a redaction pass on `detail` and `inputSnapshot`).

### 6.12 Telegram

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/v1/telegram` | session | — | `Envelope<TelegramView>` |
| POST | `/api/v1/telegram/pair` | session | `{}` | `201 Envelope<PairCode>` (code `^[A-Z2-9]{4}-[A-Z2-9]{4}$`, 5-min TTL, single use); `409 TELEGRAM_NOT_CONFIGURED` |
| GET | `/api/v1/telegram/pair/{code}` | session | — | `Envelope<{ status: 'pending' \| 'confirmed' \| 'expired' }>` (UI polls every 3 s or listens on SSE `telegram`) |
| POST | `/api/v1/telegram/unpair` | session | `{}` | `Envelope<TelegramView>` |
| PATCH | `/api/v1/telegram/notifications` | session | `Partial<TelegramView['notifications']>` | `Envelope<TelegramView>` |

```json
{ "data": { "code": "K7ZQ-4MWD", "command": "/pair K7ZQ-4MWD", "expiresAt": "2026-09-19T14:37:08.000Z", "botUrl": "https://t.me/<bot-username>" }, "meta": { "source": "runtime", "asOf": "2026-09-19T14:32:08.120Z", "stale": false, "mode": "PAPER", "requestId": "01J8ZK8N…" } }
```
`botUrl` is derived from the configured bot username (`ATRA_TELEGRAM_BOT_USERNAME`); `null` when not configured, which the UI renders as `Bot URL not configured`.

### 6.13 Settings, secrets, export, reset

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/v1/settings` | session | — | `Envelope<RuntimeSettings>` |
| PUT | `/api/v1/settings` | session | `SettingsUpdate` | `Envelope<RuntimeSettings>`; `422` (`name` 1..60 trimmed, `chains` ≥ 1, `endpoint` `''` or `^https?://`, no credentials in URL userinfo/query) |
| PUT | `/api/v1/settings/provider-secret` | session+reauth | `{ secret: string }` | `204` (stored encrypted in the vault; never returned) |
| DELETE | `/api/v1/settings/provider-secret` | session+reauth | — | `204` |
| GET | `/api/v1/settings/export` | session | — | `application/json` download `atra-config.json`: `{ "schemaVersion": 1, "environment": "runtime", "exportedAt", "settings": RuntimeSettings (without `hasSecret`), "risk": RiskLimits }` — never wallets or secrets |
| POST | `/api/v1/settings/reset` | session+reauth | `{ confirmation: 'RESET' }` | `204` — resets settings, risk, watchlist, setup flag. **Never** touches the vault |

`density` is intentionally absent: it is a per-browser preference and stays in `localStorage`.

### 6.14 Setup wizard

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/v1/setup` | session | — | `Envelope<SetupState>` |
| POST | `/api/v1/setup/complete` | session | `SetupComplete` | `200 Envelope<SetupState>`; `422` (`trade`/`loss` 1..5000 as in the wizard); applies `chains`, writes risk = `{...defaultRisk, trade, loss}` |

Step 3 of the wizard calls `POST /wallet/create`; the wizard may finish without wallets (`steps.wallets=false`).

---

## 7. Server-Sent Events stream

`GET /api/v1/events` (session; `Accept: text/event-stream`). Vite's proxy streams SSE without special configuration; the runtime must flush per event and disable compression on this route.

| `event:` | `data:` payload | When |
|---|---|---|
| `hello` | `{ mode, version, control: ControlState }` | on connect |
| `status` | `RuntimeStatus` (partial allowed: `{ patch: true, ...fields }`) | every 15 s heartbeat and on change |
| `control` | `ControlState` | pause / resume / stop / clear |
| `mode` | `{ mode }` | mode switch |
| `activity` | `ActivityEvent` | each new audit row |
| `agent` | `Agent` | state or schedule change |
| `wallet` | `WalletView` | balance refresh (≤ 1 per 30 s) |
| `telegram` | `TelegramView` | pairing confirmed / unpaired |

```
event: activity
id: 01J8ZK7Q4W6X1R9V2M3N4P5S6T
data: {"id":"01J8ZK7Q4W6X1R9V2M3N4P5S6T","at":"2026-09-19T14:30:42.000Z","category":"risk","chain":"Solana","agent":"trader","action":"Position size limit checked","result":"Blocked","detail":"…","audit":{"inputSnapshotId":"01J8ZK7P…","mode":"PAPER","riskDecision":{"status":"rejected","rule":"max_trade_usd","detail":"600 > 500"},"txHash":null,"explorerUrl":null}}

```
`Last-Event-ID` is honoured for `activity` replay (up to 500 events). Polling fallback: the UI may simply re-fetch `/status` every 15 s.

---

## 8. Gaps — UI fields without a defined data source, and what the runtime returns

| UI element | Gap | Runtime behaviour (never fabricate) |
|---|---|---|
| Portfolio chart 1D/1W/1M, y-axis labels | No history exists on a fresh install | `points: []`, `source:'none'`, `reason:'NO_HISTORY'` until ≥ 2 snapshots. UI shows the empty state, not the fixture curve. Snapshot every 5 min |
| `Today's P&L` `+$184.26 · 1.50%` | Needs a day-start baseline | `todayPnlUsd: null` until the first snapshot after 00:00 UTC exists; then `total_now − total_at_day_start`. Label carries `simulated: true` in PAPER |
| `Available balance 58.0% of portfolio` / `Deployed 42.0%` | Derived | `availablePct = availableUsd/totalUsd·100`, `null` when `totalUsd` is `0` or `null` |
| System health `Gas status` | No definition | `GasStatus` per chain: `ok` ≥ 3× estimated fee of a native transfer at current gas; `low` > 0 but below; `empty` = 0; `unverified` when RPC unreachable or wallet not created. The panel shows the worst enabled chain |
| Risk meter `24 / 100%` | No formula | `utilizationPct = max(dailyLossUsd/dailyLossLimitUsd, deployedUsd/deployedLimitUsd)·100`, rounded to integer; `null` if inputs null |
| `Open trades` / `Active LP positions (in range)` | Counts | Real counts from PAPER/LIVE position tables; `0` on a fresh install (a real zero) |
| `Last agent action · Research Agent · 14:32:08` | — | `lastAgentAction` from the newest activity row whose `agent != null`; `null` if none → UI shows "No agent action yet" |
| Agent `Last run · Sample cycle · 14:30`, `Next scheduled run` | Scheduler | `lastRun` / `nextRunAt` from the scheduler; `null` when disabled, paused, or stopped |
| Market `Pool`, `Liquidity`, `history[]` sparkline | Depends on market-data provider (none chosen; keyless/BYOK) | Provider adapter returns the primary pool on that chain or `pool:'Not configured'`; `history: []` if no 7-day series. Robinhood Chain: `price:null`, `source:'none'`, `reason:'NO_PROVIDER'` until a provider lists it |
| Market `Updated` badge `Fixture`/`Stale` | — | Badge text from `source` (`provider:x` → `Live`, `none` → `Unavailable`) and `meta.stale` |
| Market detail `Supported execution` | No adapters yet | `execution.supported:false, reason:'No execution adapter registered for <chain>'` |
| Market detail `Agent exposure`, `Existing trade / LP` | — | From positions tables; `agentUsd: 0` real zero |
| LP `Protocol`, `Fee collection threshold`, `Allowed pools/protocols` | No supported protocols at launch | `supportedProtocols: []`; `protocols` allowlist accepts only `[]`; UI field stays disabled |
| Wallet USD values | Needs price feed | `value.usd: null, source:'none'` when no provider price for that asset |
| Wallet `Token balances` (Solana) / ERC-20 list | Which tokens to scan | Only the risk `tokens` allowlist mapped to verified mints/contracts (USDC Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, USDC Solana `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; BSC USDC is a Binance-bridged token at `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` — **UNVERIFIED**: confirm `symbol()`/`decimals()` on-chain before listing; Robinhood Chain USDC — **UNVERIFIED / unknown**, not listed until verified). Unverified tokens are omitted, not zeroed |
| Deposit QR code | UI has no QR lib | `qrSvg` string from the runtime (optional; `null` allowed, UI falls back to text + copy button) |
| Withdraw `Estimated network fee`, `Remaining balance` | Live quote | `/wallet/withdraw/quote`; `fee.native:null, source:'none'` when RPC down, and submit is refused |
| Live checklist `Not verified` ×4 | Definitions | `wallet_funded`: any enabled chain with `value.usd ≥ 1` (or native > 0 if no price); `gas_available`: every enabled chain `gas ∈ {ok}`; `risk_reviewed`: `risk.updatedAt` not null and newer than last mode switch; `protocols_supported`: `supportedProtocols.length > 0` and `risk.protocols ⊆ supported`. Any `unverified` input → check `unverified`, `eligible:false` |
| Settings `Runtime connection` (read-only) | — | UI shows `Connected · v{meta.version} · {mode}` from `/meta` |
| Settings `Provider API secret` | Write-only | `PUT /settings/provider-secret`; `hasSecret` boolean only |
| Settings model status | — | `atra` → `untrained` with the release label from the action plan; `local` → probe `ATRA_MODEL_LOCAL_URL` (default `http://127.0.0.1:11434`, Ollama) → `available|unavailable`; `external` → `available` only if `endpoint` set and a `GET /v1/models` (OpenAI-compatible) succeeds — **UNVERIFIED** which external APIs the runtime will support |
| Telegram `Account` display | Privacy | `displayName` = Telegram first name/username from the pairing update; `userIdMasked` like `12****89`; never phone numbers |
| Telegram `Installation` | — | `settings.name` |
| Activity `Reference` `DEMO-0081` | Id format | ULID (26 chars). UI may show the last 8 chars |
| Activity expand `Input snapshot: static fixture` | — | `audit.inputSnapshotId` → `GET /activity/{id}` returns the redacted snapshot object |
| Sidebar `Frontend v0.1.0 DEMO` | — | `DEMO` → `PAPER`/`LIVE` from `meta.mode`; version from `/meta.version` next to the frontend's own |
| Public `#/docs/status` list | — | Map from `/meta.features` (public site may call `/meta` unauthenticated) |
| `#/market` on the **public** site | Unauthenticated | Stays on fixtures when served statically without a runtime; when served by the runtime, `GET /api/v1/market` still requires a session (local data policy). Optional `ATRA_PUBLIC_MARKET=1` lifts that for read-only market rows |

---

## 9. Frontend integration notes (proposed Codex-side changes, not made here)

1. **`vite.config.ts` — add the dev proxy** (shape per Vite docs `server.proxy`):
   ```ts
   import { defineConfig } from 'vite';
   import react from '@vitejs/plugin-react';
   export default defineConfig({
     plugins: [react()],
     server: {
       host: '127.0.0.1',
       proxy: {
         '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
         '/health': { target: 'http://127.0.0.1:3000', changeOrigin: false },
       },
     },
   });
   ```
   `changeOrigin: false` keeps `Host: 127.0.0.1:5173`, which the runtime's host allowlist accepts (loopback). Optional `VITE_ATRA_API_BASE` env for non-proxied setups (`''` default → relative paths).
2. **`src/data/api.ts` (new) — HTTP adapter** implementing the same exported names as `services.ts` (`marketService`, `riskService`, `settingsService`, `walletService`, `agentService`, `telegramService`, `activityService`). Common `request()` helper: `credentials: 'same-origin'`, headers `Content-Type`, `X-ATRA-Client: dashboard`, optional `X-ATRA-Reauth`; on `401` dispatch an "unlock" event; on `application/problem+json` throw `Error(detail ?? errors.map(e=>e.message).join(' '))` so existing `<div role="alert">` rendering works unchanged. Map `tokens`/`protocols` arrays ↔ the UI's comma strings, ISO `at` → local `HH:mm:ss`, `Market` passes through untouched.
3. **Unlock dialog** — one `Modal` with a password field; shown when `/auth/session` is `401`. `setupRequired: true` routes to a "Set operator password" variant (`POST /auth/setup`).
4. **Wire the two existing password fields** (`export`, `live`) to `POST /auth/reauth`, then send `X-ATRA-Reauth` on the sensitive call. Enable those inputs when `agentService.status().connected === true`.
5. **Labels from data**: `PAPER MODE` badge ← `meta.mode`; `Runtime disconnected` ← `/status` reachability; `{n} chains enabled` ← `settings.chains.length` from the runtime; `DataNotice` only when `source` is `paper-sim`/`none`.
6. **Keep local-only**: `settings.density`, watchlist fallback when offline, `atra.setup` mirror.
7. **Tests**: the four `toContainText('local ATRA runtime')` assertions in `tests/frontend.spec.ts` describe demo behaviour; with a runtime they become `toContainText('Insufficient')`, `toBeEnabled()` for the password fields, etc. Suggest a Playwright project that runs against the demo adapter (`VITE_ATRA_DEMO=1`) to keep the current suite green.
8. **No execute routes** for trade/LP from the dashboard: `tradingService.execute` / `liquidityService.execute` should remain "not available" (they are agent-only paths).

---

## 10. Test vectors

**Address validation (must match the UI regexes, then be stricter):**

| Input | chain | Expected |
|---|---|---|
| `0x1111111111111111111111111111111111111111` | base | valid (all-lowercase hex → no checksum check) |
| `0x0000000000000000000000000000000000000000` | base | `422 INVALID_ADDRESS` (zero address) |
| `0xAbC1111111111111111111111111111111111111` | base | `422 INVALID_ADDRESS` (mixed case, EIP-55 checksum fails) |
| `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | base | valid (EIP-55 checksum of USDC-on-Base contract; withdrawing to a contract is allowed but returns a `warnings[]` entry) |
| `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | solana | valid base58, 44 chars |
| `0x1111111111111111111111111111111111111111` | solana | `422 INVALID_ADDRESS` |
| `7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV0` | solana | `422 INVALID_ADDRESS` (`0` is not in the base58 alphabet) |

**Risk validation (`PUT /api/v1/risk`):**

| Body delta | Expected |
|---|---|
| `trade: 7000, capital: 5000` | `422`, `errors[0] = { path:['trade'], message:'Maximum trade size cannot exceed maximum deployed capital.' }` (the Playwright test asserts `cannot exceed`) |
| `slippage: 0` | `422`, path `['slippage']` |
| `cooldown: 15.5` | `422`, path `['cooldown']` (integer) |
| `liquidity: 999` | `422`, path `['liquidity']` |
| `tokens: ['eth']` | `422` (uppercase symbols) — or normalise to `'ETH'` and return `200`; **pick one and document** (recommended: normalise) |
| `protocols: ['uniswap-v3']` while `supportedProtocols=[]` | `422`, path `['protocols']` |

**Withdraw confirmation:**

| Quote | `confirmation` | Expected |
|---|---|---|
| `amount:'25'` USDC (usd 25) | omitted | `202` |
| `amount:'1000'` USDC | omitted | `422 CONFIRMATION_REQUIRED` |
| `amount:'1000'` USDC | `'WITHDRAW'` | `202` |
| `amount:'all'` | `'withdraw'` | `422 CONFIRMATION_REQUIRED` (case-sensitive) |
| any, no `X-ATRA-Reauth` | — | `403 REAUTH_REQUIRED` |
| any, quote older than 90 s | — | `409 QUOTE_EXPIRED` |

**Auth/CSRF:**

| Request | Expected |
|---|---|
| `POST /api/v1/control/pause` with cookie, without `X-ATRA-Client` | `403 FORBIDDEN_ORIGIN` |
| any request with `Host: evil.example` | `403 FORBIDDEN_HOST` |
| `POST /api/v1/auth/setup` from non-loopback peer | `403 LOOPBACK_ONLY` |
| 6th failed login within 60 s | `429 RATE_LIMITED`, `Retry-After: 60` |
| `POST /api/v1/wallet/export` behind a reverse proxy (peer not loopback) | `403 LOOPBACK_ONLY` even with valid reauth |

**curl smoke (dev, via Vite proxy on 5173 or direct on 3000):**

```sh
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/api/v1/meta | jq .data.setupRequired
curl -s -c cj.txt -H 'Content-Type: application/json' -H 'X-ATRA-Client: dashboard' \
  -d '{"password":"correct horse battery staple"}' http://127.0.0.1:3000/api/v1/auth/setup
curl -s -b cj.txt http://127.0.0.1:3000/api/v1/overview | jq .data.portfolio
curl -s -b cj.txt -H 'X-ATRA-Client: dashboard' -H 'Content-Type: application/json' \
  -d '{"trade":7000,"loss":100,"capital":5000,"slippage":0.5,"fee":5,"cooldown":15,"liquidity":100000,"tokens":["ETH"],"protocols":[]}' \
  -X PUT http://127.0.0.1:3000/api/v1/risk   # -> 422 problem+json
curl -s -N -b cj.txt http://127.0.0.1:3000/api/v1/events   # SSE
```

**Chain constants the runtime ships (verified 2026-09-19):**

| ChainId | name | chainId | native | public RPC (keyless default) | explorer |
|---|---|---|---|---|---|
| `base` | Base | 8453 | ETH | `https://mainnet.base.org` | `https://basescan.org` |
| `bsc` | BNB Smart Chain | 56 | BNB | `https://bsc-dataseed.bnbchain.org` | `https://bscscan.com` |
| `robinhood` | Robinhood Chain | 4663 (`0x1237`) | ETH | `https://rpc.mainnet.chain.robinhood.com` (Arbitrum Nitro chain; Alchemy BYOK `https://robinhood-mainnet.g.alchemy.com/v2/{key}`) | `https://robinhoodchain.blockscout.com` |
| `solana` | Solana | — | SOL (9 dec) | `https://api.mainnet.solana.com` (docs) / `https://api.mainnet-beta.solana.com` (legacy host, still resolves); public limits 100 req/10 s/IP, not for production | `https://explorer.solana.com` |

---

## 11. Appendix A — OpenAPI 3.1 skeleton (paths only)

```yaml
openapi: 3.1.0
info: { title: ATRA Runtime API, version: 1.0.0 }
servers: [{ url: http://127.0.0.1:3000 }]
components:
  securitySchemes:
    session: { type: apiKey, in: cookie, name: atra_session }
    reauth:  { type: apiKey, in: header, name: X-ATRA-Reauth }
paths:
  /health:                          { get: { security: [] } }
  /ready:                           { get: { security: [] } }
  /api/v1/meta:                     { get: { security: [] } }
  /api/v1/auth/session:             { get: { security: [] } }
  /api/v1/auth/setup:               { post: { security: [] } }
  /api/v1/auth/login:               { post: { security: [] } }
  /api/v1/auth/logout:              { post: {} }
  /api/v1/auth/reauth:              { post: {} }
  /api/v1/auth/password:            { post: { security: [{ session: [], reauth: [] }] } }
  /api/v1/status:                   { get: {} }
  /api/v1/overview:                 { get: {} }
  /api/v1/overview/history:         { get: { parameters: [{ name: range, in: query, schema: { enum: [1D, 1W, 1M] } }] } }
  /api/v1/control/pause:            { post: {} }
  /api/v1/control/resume:           { post: {} }
  /api/v1/control/emergency-stop:   { post: {} }
  /api/v1/control/emergency-stop/clear: { post: {} }
  /api/v1/mode:                     { get: {} }
  /api/v1/mode/live:                { post: { security: [{ session: [], reauth: [] }] } }
  /api/v1/mode/paper:               { post: {} }
  /api/v1/agents:                   { get: {} }
  /api/v1/agents/{id}:              { get: {}, patch: {} }
  /api/v1/agents/{id}/run:          { post: {} }
  /api/v1/market:                   { get: {} }
  /api/v1/market/{id}:              { get: {} }
  /api/v1/market/{id}/research:     { post: {} }
  /api/v1/watchlist:                { get: {}, put: {} }
  /api/v1/trading:                  { get: {} }
  /api/v1/trading/positions:        { get: {} }
  /api/v1/trading/decisions:        { get: {} }
  /api/v1/liquidity:                { get: {} }
  /api/v1/wallet:                   { get: {} }
  /api/v1/wallet/create:            { post: {} }
  /api/v1/wallet/deposit-address:   { get: { parameters: [{ name: chain, in: query, required: true, schema: { enum: [base, bsc, robinhood, solana] } }] } }
  /api/v1/wallet/withdraw/quote:    { post: {} }
  /api/v1/wallet/withdraw:          { post: { security: [{ session: [], reauth: [] }] } }
  /api/v1/wallet/transactions:      { get: {} }
  /api/v1/wallet/export:            { post: { security: [{ session: [], reauth: [] }] } }
  /api/v1/risk:                     { get: {}, put: {} }
  /api/v1/activity:                 { get: {} }
  /api/v1/activity/{id}:            { get: {} }
  /api/v1/activity/export:          { get: {} }
  /api/v1/telegram:                 { get: {} }
  /api/v1/telegram/pair:            { post: {} }
  /api/v1/telegram/pair/{code}:     { get: {} }
  /api/v1/telegram/unpair:          { post: {} }
  /api/v1/telegram/notifications:   { patch: {} }
  /api/v1/settings:                 { get: {}, put: {} }
  /api/v1/settings/provider-secret: { put: { security: [{ session: [], reauth: [] }] }, delete: { security: [{ session: [], reauth: [] }] } }
  /api/v1/settings/export:          { get: {} }
  /api/v1/settings/reset:           { post: { security: [{ session: [], reauth: [] }] } }
  /api/v1/setup:                    { get: {} }
  /api/v1/setup/complete:           { post: {} }
  /api/v1/events:                   { get: { responses: { '200': { content: { text/event-stream: {} } } } } }
security: [{ session: [] }]
```

---

## 12. Appendix B — Runtime environment variables (for `.env.example`)

| Var | Default | Notes |
|---|---|---|
| `ATRA_PORT` | `3000` | fail fast on `EADDRINUSE` |
| `ATRA_HOST` | `127.0.0.1` | `0.0.0.0` only inside Docker (compose publishes `127.0.0.1:3000:3000`) |
| `ATRA_MODE` | `paper` | `paper` \| `ci` (offline boot, no providers, `/health.ci=true`). `live` is never set by env — only via `POST /mode/live` |
| `ATRA_DATA_DIR` | `./data` | SQLite DB, vault file, snapshots |
| `ATRA_HOST_ALLOWLIST` | `` | extra `Host` values (comma-separated) |
| `ATRA_CORS_ORIGINS` | `` | only when the UI is served from another origin |
| `ATRA_TLS` / `ATRA_TRUST_PROXY` | `0` / `0` | controls `Secure` cookie |
| `ATRA_SESSION_IDLE_HOURS` / `ATRA_SESSION_MAX_DAYS` | `12` / `7` | |
| `ATRA_STATIC_DIR` | `` | when set, serve the built frontend at `/` |
| `ATRA_RPC_BASE` / `ATRA_RPC_BSC` / `ATRA_RPC_ROBINHOOD` / `ATRA_RPC_SOLANA` | public URLs from §10 | BYOK overrides |
| `ATRA_MARKET_PROVIDER` | `none` | adapter id; `none` yields `source:'none'` rows |
| `ATRA_MODEL_LOCAL_URL` | `http://127.0.0.1:11434` | Ollama probe for `model.preferred='local'` |
| `ATRA_TELEGRAM_BOT_TOKEN` / `ATRA_TELEGRAM_BOT_USERNAME` | `` | unset → `TELEGRAM_NOT_CONFIGURED` |
| `ATRA_PUBLIC_MARKET` | `0` | `1` lifts auth on `GET /api/v1/market` (read-only) |

Suggested runtime stack (versions from `npm view` on 2026-09-19, not installed): `hono@4.13.8` + `@hono/node-server@2.1.1` (or `fastify@5.12.5`), `zod@4.6.5` (same major as the UI so schemas can be shared), `viem@2.56.8`, `@solana/kit@8.3.0`, `pino@10.3.1`, `typescript@7.0.2`, `tsx@4.23.13`, `vitest@5.0.1`. Node `24.17.0`, pnpm `11.9.0` confirmed locally.

---

## 13. Sources

Local files (read 2026-09-19): `C:\ATRA\package.json`, `C:\ATRA\vite.config.ts`, `C:\ATRA\playwright.config.ts`, `C:\ATRA\index.html`, `C:\ATRA\tsconfig.json`, `C:\ATRA\src\App.tsx`, `C:\ATRA\src\main.tsx`, `C:\ATRA\src\Dashboard.tsx`, `C:\ATRA\src\Public.tsx`, `C:\ATRA\src\Market.tsx`, `C:\ATRA\src\Flows.tsx`, `C:\ATRA\src\components.tsx`, `C:\ATRA\src\data\fixtures.ts`, `C:\ATRA\src\data\services.ts`, `C:\ATRA\tests\frontend.spec.ts`, `C:\ATRA\docs\research\blockers-action-plan-2026-09-19.md` (port 3000 precedent).

- Vite server options (`server.host`, `server.port` default 5173, `server.proxy` shape): https://vite.dev/config/server-options
- Robinhood Chain mainnet network details (chain ID 4663, RPC, ETH, Blockscout): https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/
- Robinhood Chain node docs (Arbitrum Nitro, public RPC, Alchemy endpoint, feed URLs): https://docs.robinhood.com/chain/run-a-full-node/
- Chainlist entry for Robinhood Chain (4663 / 0x1237, explorers): https://chainlist.org/chain/4663
- Chainlist RPC dataset (Base 8453 `https://mainnet.base.org`, BSC 56 `https://bsc-dataseed.bnbchain.org`): https://chainlist.org/rpcs.json
- Solana clusters and public RPC rate limits: https://solana.com/docs/references/clusters
- Circle USDC contract addresses (Base, Solana): https://developers.circle.com/stablecoins/usdc-contract-addresses
- RFC 9457 Problem Details for HTTP APIs: https://www.rfc-editor.org/rfc/rfc9457.html
- W3C Secure Contexts (loopback is potentially trustworthy): https://www.w3.org/TR/secure-contexts/
- Firefox: allow `Secure` cookies from localhost: https://bugzilla.mozilla.org/show_bug.cgi?id=1618113
- Inconsistent `__Host-`/`__Secure-` cookie behaviour on localhost across browsers: https://github.com/httpwg/http-extensions/issues/2605
- Package versions: `npm view <pkg> version` run locally on 2026-09-19 (hono 4.13.8, @hono/node-server 2.1.1, fastify 5.12.5, zod 4.6.5, viem 2.56.8, @solana/kit 8.3.0, pino 10.3.1, typescript 7.0.2, tsx 4.23.13, vitest 5.0.1)
- Endpoint reachability: `curl -s -o /dev/null -w '%{http_code}'` GET probes on 2026-09-19 — `api.mainnet-beta.solana.com` 200, `api.mainnet.solana.com` 200, `mainnet.base.org` 405 (GET not allowed, host up), `bsc-dataseed.bnbchain.org` 404 (GET, host up), `rpc.mainnet.chain.robinhood.com` 400 (GET, host up)

**UNVERIFIED items (explicitly):** BSC USDC token contract/decimals (BscScan returned 403 to automated fetch); Robinhood Chain USDC existence/address; `__Host-` cookie prefix behaviour on `http://127.0.0.1` in the user's installed Chrome/Firefox builds; which OpenAI-compatible external model endpoints the runtime will accept; whether any keyless market-data provider covers Robinhood Chain assets.
