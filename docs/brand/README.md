# ATRA brand kit

Written for: whoever sets up ATRA's public profiles and whoever restyles the dashboard.

## The mark

A grey heron, cut from a wood engraving in *Nordisk familjebok* volume 12
(1910). It is a real engraving, not a drawing made to look like one:
nothing was redrawn, and `PROVENANCE.md` records the scan, the page and the
licence (public domain). The heron stands still for hours and strikes once;
ATRA's default answer is `NO_ACTION`, and the risk engine exists so that
acting is rare and deliberate. The bird is the behaviour.

| File | Use |
|---|---|
| `heron-engraving.png` | the engraving, 1080×1556, black ink on transparency — the master |
| `pp-800.png` | **profile picture** (X, GitHub, Telegram): the heron on plain white, nothing else |
| `x-banner-1500x500.png` | **X header**: white card with the heron on the sky ground, serif wordmark |
| `logo-horizontal.png` | lockup, transparent |
| `../../public/brand/heron.png` | the same engraving at 320 px for the web app's logo |
| `../../public/favicon.png`, `apple-touch-icon.png`, `brand/icon-512.png` | the heron on white at icon sizes |

The network and token logos in the interface (`public/logos/`) are not ours:
`THIRD_PARTY_MARKS.md` records where each file came from and the terms.

Regenerate the rendered files with `node docs/brand/render.mjs` from the
repository root (uses the repository's Playwright Chromium). Sources are in
`src/`.

## Wordmark

"ATRA" set in **Libre Caslon Text** 700, uppercase, letter-spacing 0.10em,
in navy. A transitional serif next to a 1910 engraving; the rest of the
interface stays in Manrope and Sora. The descriptor line under the wordmark
("SELF-HOSTED AUTONOMOUS CRYPTO AGENT") is Manrope 600, accent blue,
letter-spacing 0.34em. Nothing else is added to the lockup.

## Colour

Tokens in `tokens.css`. Blue-first, deliberately quiet:

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#F3F7FB` | `#0B1220` | page ground (cool white / navy) |
| `--panel` | `#FFFFFF` | `#111A2C` | cards |
| `--surface` | `#E9F0F7` | `#172238` | inputs, table headers |
| `--border` | `#D3DEEA` | `#253553` | hairlines |
| `--text` | `#14213D` | `#E6EDF7` | navy ink |
| `--muted` | `#64748B` | `#8A9BB5` | secondary text (>= 4.5:1 on ground) |
| `--accent` | `#2F6FE4` | `#6FA8FF` | the one interactive colour (clear blue) |
| `--sky` | `#8EC5FF` | `#9CCBFF` | highlight: descriptor lines, selected states, the mark on dark |
| `--positive` | `#2E8B6A` | `#5FC29A` | gains, confirmed |
| `--negative` | `#C24E4E` | `#E07A7A` | losses, failed, emergency |
| `--warning` | `#C08A2E` | `#E0B05A` | stale data, low gas |

Rules: one accent per screen; status colours only on status; never colour a
number by sign alone without the sign itself; no lime, no neon, no gradients.

## Type

- Wordmark: **Libre Caslon Text** 700 (self-hosted in the app via `@fontsource/libre-caslon-text`).
- Page titles: **Sora** 600/700. UI: **Manrope** 400/500/600.
- Numbers, hashes, addresses, code: **IBM Plex Mono**.

Google Fonts link:

```
https://fonts.googleapis.com/css2?family=Libre+Caslon+Text:wght@700&family=Sora:wght@600;700&family=Manrope:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap
```

## X profile

- **Name:** ATRA
- **Bio (156/160):** Open-source, self-hosted autonomous crypto agent for Base, BNB Smart Chain, Robinhood Chain & Solana. Your keys stay on your machine. Paper mode by default.
- **Bio, shorter (146):** Self-hosted, open-source crypto agent for Base, BSC, Robinhood Chain & Solana. Your keys never leave your machine. Paper mode by default. No hype.
- **Bio, Indonesian (154):** Agen kripto otonom open-source yang lo host sendiri untuk Base, BNB Smart Chain, Robinhood Chain & Solana. Kunci tetap di mesin lo. Paper mode by default.
- **Website:** https://github.com/lamaokamg-hub/ATRA
- **Location:** Self-hosted
- **Profile picture:** `pp-800.png` · **Header:** `x-banner-1500x500.png`

Do not put performance, returns or "AI-powered profits" anywhere in the
profile. The product's claim is control, not yield.

## Applying the palette to the dashboard

See `UI_THEME.md`.
