# Applying the Sky / Navy theme to the dashboard

Written for: the frontend engineer (the root Vite app, `src/styles.css`, `src/components.tsx`, `index.html`).

The current dashboard is a dark green/lime theme with roughly 300 literal hex
values in `src/styles.css`. The new theme is light by default ("Sky": cool white
ground, navy ink, clear-blue accent), with a dark variant ("Navy") for
`prefers-color-scheme: dark` and `[data-theme="dark"]`. All colour must come from the tokens in
`docs/brand/tokens.css`; no literal hex should survive in component CSS
except the four chain marks.

## 1. Fonts (`index.html`)

Replace DM Sans / Inter with:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Manrope:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<meta name="theme-color" content="#F3F7FB" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0B1220" media="(prefers-color-scheme: dark)">
```

Replace `public/favicon.svg` with `docs/brand/atra-mark.svg` (navy) — or the
light one on a dark app icon.

## 2. Tokens (`src/styles.css`, the `:root` block)

Delete the existing `--bg … --warning` declarations and `color-scheme:dark`,
and paste the contents of `docs/brand/tokens.css` at the top of the file. Set
`font-family: var(--font-ui)` on `:root`, `font-size: 14px`, `color: var(--text)`,
`background: var(--bg)`.

## 3. Literal colours → tokens

Do this with find/replace; every entry is a class of values seen in the
current stylesheet.

| Old value(s) | New |
|---|---|
| `#101311`, `#111610`, `#111710`, `#121612`, `#10160d`, `#111a0d` | `var(--bg)` |
| `#161a17`, `#191f17`, `#171d14`, `#151c12`, `#141a11`, `#161d13` | `var(--panel)` |
| `#1c211c`, `#1b211b`, `#20261e`, `#252e22`, `#27331e`, `#26251c`, `#2c201d`, `#30211e`, `#2c3821`, `#30392a`, `#293025` | `var(--surface)` (badges/notices use the `*-soft` status token instead, see below) |
| `#2b312b`, `#2a3227`, `#363f33`, `#394036`, `#394034`, `#35422c`, `#46513e`, `#57634c`, `#3c4536`, `#343e2d` | `var(--border)`; hover/selected borders `var(--border-strong)` |
| `#eaede7`, `#edf0e7`, `#e3e9dc`, `#e4e9dc`, `#e2eadb`, `#d9e7c9`, `#dfead1`, `#c9cfc4`, `#c5d6bf`, `#bfc6b7` | `var(--text)` (body) or `var(--text-2)` (labels) |
| `#90998e`, `#7f897e`, `#aeb6a6`, `#a8b09f`, `#808b77`, `#87927d`, `#697461`, `#7e8b72` | `var(--muted)` |
| `#c0e985`, `#cff49d`, `#c4ef82`, `#bfed79` (the lime accent, incl. `src/components.tsx`) | `var(--accent)`; hover `var(--accent-hover)` |
| `.button.primary` text `#17200f`, toggle knob `#26341d` | `var(--on-accent)` |
| `#e49287`, `#e8a296`, `#e1aca0`, `#efb8aa`, `#ad4f42`, `#69453f`, `#674138`, `#684337` | `var(--negative)`; backgrounds `var(--negative-soft)`; borders `var(--negative)` at 40% (`color-mix(in srgb, var(--negative) 40%, transparent)`) |
| `#d7b87b`, `#c8bd9c`, `#494231`, `#342c1f`, `#514631`, `#bdb497` | `var(--warning)` / `var(--warning-soft)` |
| `.badge.lime` | rename to `.badge.accent`: `color: var(--accent); background: var(--accent-soft); border-color: transparent` |
| `.badge.paper` | `color: var(--text-2); background: var(--surface)` |
| `.status-dot` | `var(--accent)`; `.neutral` → `var(--border-strong)` |
| `.positive` | `var(--positive)`; `.negative` | `var(--negative)` |
| `.chain-mark.base` | `var(--chain-base)`; `.bnb` `var(--chain-bnb)`; `.solana` `var(--chain-solana)`; `.robinhood` `var(--chain-robinhood)` |
| `.portfolio-chart` stroke, `.sparkline` | `var(--accent)`; gridlines `var(--border)` |
| `.modal` shadow `#0008`, `.toast` shadow `#0006` | `var(--shadow)` |
| `.modal::backdrop` | `color-mix(in srgb, var(--text) 45%, transparent)` |
| `.toast` | `background: var(--panel); border: 1px solid var(--border); color: var(--text)` |

## 4. Shape and type

- Border radius: buttons/inputs `var(--radius-sm)`, panels `var(--radius)`, modals `var(--radius-lg)` (up from 3–6 px).
- Headings: `font-family: var(--font-display); font-weight: 600; letter-spacing: -0.01em` (drop the −0.035em).
- Numbers, hashes, addresses: `var(--font-mono)`.
- `.logo`: replace the SVG with `docs/brand/atra-mark.svg` (`var(--text)` for the disc, `var(--bg)` for the keyhole) and set the word in `var(--font-display)` 700, letter-spacing `.14em`, 18 px; drop `.logo-period`.
- Panels get `box-shadow: var(--shadow)` in light mode only (`@media (prefers-color-scheme: dark)` → none).

## 5. What not to change

- Layout, spacing, component structure, copy, tests.
- Status semantics: a `Blocked` badge stays negative, `Hold` stays warning, `Simulated` stays accent-soft, `Completed`/`Executed` positive.
- Accessibility: every text/background pair above is ≥ 4.5:1 in both themes (`--muted` `#64748B` on `--bg` `#F3F7FB` is 4.6:1; `#8A9BB5` on `#0B1220` is 6.3:1).

## 6. Acceptance

Take the same screenshots as `artifacts/desktop--app-*.png` and
`mobile--app-*.png` and check: no lime or green anywhere except the positive status; one accent; all badges read
in both themes; Playwright tests still pass.
