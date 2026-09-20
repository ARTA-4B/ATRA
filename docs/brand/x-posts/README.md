# ATRA — five X posts

Five English graphics, each exported as a 1600 × 900 PNG. Matching captions are in [captions.md](captions.md), each below 280 characters. [Preview all five](preview.png).

1. [Meet ATRA](01-kenalan-atra.png)
2. [Your keys, your control](02-kendali-wallet.png)
3. [Paper mode](03-paper-mode.png)
4. [Risk engine](04-risk-engine.png)
5. [Open source](05-open-source.png)

Rendered from editable HTML/CSS using the original heron engraving and existing brand palette. No AI image generation was used: preserving the established brand assets called for direct rendering. Libre Caslon Text is used for the wordmark, with locally available DM Sans for body/headline text and IBM Plex Mono for labels. All fonts and the engraving are embedded in the HTML files.

Copy and concepts live in `render.mjs`. To regenerate from the repository root:

```sh
node docs/brand/x-posts/render.mjs
```

Copy is based on the project README: local wallets, PAPER by default, explicit LIVE activation, deterministic risk checks, and the MIT license. The posts make no performance or return claims.
