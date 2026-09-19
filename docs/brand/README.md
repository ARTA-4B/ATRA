# ATRA brand kit

Written for: whoever sets up ATRA's public profiles and whoever restyles the dashboard.

## The mark

A solid disc with a keyhole cut out of it: the vault. It says the one thing
ATRA promises before anything else — the keys stay with you. Navy on sky
white, or white on navy, one flat shape, no strokes, no gradients, no glow.
It reads at 24 px and at 800 px.

| File | Use |
|---|---|
| `atra-mark.svg` | navy mark on transparent (light backgrounds) |
| `atra-mark-light.svg` | white mark on transparent (dark backgrounds) |
| `pp-navy-800.png` | **profile picture** (X, GitHub, Telegram) — navy background; platforms crop it to a circle |
| `pp-sky-800.png` | profile picture, light variant |
| `logo-horizontal-light.png` | mark + wordmark for light backgrounds (transparent PNG) |
| `logo-horizontal-dark.png` | mark + wordmark for dark backgrounds (transparent PNG) |
| `x-banner-1500x500.png` | **X header**, dark. The avatar overlaps the lower-left corner on X; the chain line sits above that zone at 1500×500 but check after upload |
| `x-banner-light-1500x500.png` | X header, light variant |

Regenerate everything with `node docs/brand/render.mjs` from the repository
root (uses the repository's Playwright Chromium). Sources are in `src/`.

## Wordmark

"ATRA" set in **Sora** 700, uppercase, letter-spacing 0.14em. The descriptor
line under it ("SELF-HOSTED AUTONOMOUS CRYPTO AGENT") is Manrope 600, accent blue on light / sky on dark,
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

- Wordmark and page titles: **Sora** (Google Fonts), weights 600/700.
- UI: **Manrope**, weights 400/500/600.
- Numbers, hashes, addresses, code: **IBM Plex Mono**.

Google Fonts link:

```
https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Manrope:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap
```

## X profile

- **Name:** ATRA
- **Bio (156/160):** Open-source, self-hosted autonomous crypto agent for Base, BNB Smart Chain, Robinhood Chain & Solana. Your keys stay on your machine. Paper mode by default.
- **Bio, shorter (146):** Self-hosted, open-source crypto agent for Base, BSC, Robinhood Chain & Solana. Your keys never leave your machine. Paper mode by default. No hype.
- **Bio, Indonesian (154):** Agen kripto otonom open-source yang lo host sendiri untuk Base, BNB Smart Chain, Robinhood Chain & Solana. Kunci tetap di mesin lo. Paper mode by default.
- **Website:** https://github.com/lamaokamg-hub/ATRA
- **Location:** Self-hosted
- **Profile picture:** `pp-navy-800.png` · **Header:** `x-banner-1500x500.png`

Do not put performance, returns or "AI-powered profits" anywhere in the
profile. The product's claim is control, not yield.

## Applying the palette to the dashboard

See `UI_THEME.md`.
