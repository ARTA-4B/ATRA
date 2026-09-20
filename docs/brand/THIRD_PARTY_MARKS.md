# Third-party marks used in the interface

The frontend shows the logos of the four networks ATRA supports and of the
tokens in its registry, next to their names, so a user can tell at a glance
which chain a row belongs to. Nothing in this folder or in `public/logos/`
was drawn, traced or "generated" by us: every file is the mark as its owner
publishes it, copied byte for byte from the owner's own brand kit or site,
and the SHA-256 of each file is recorded below so anyone can check that.

These marks belong to their owners. They appear here to identify the
networks and tokens the software talks to (nominative use), not to suggest
that any of those organisations endorses, sponsors or is affiliated with
ATRA. If an owner asks for a different file, or for removal, replace or
remove the file and update this record.

| File | Identifies | Source (retrieved 2026-09-20) | Owner's terms | SHA-256 (first 16) |
|---|---|---|---|---|
| `public/logos/base.svg` | Base | `logo/TheSquare/Digital/Base_square_blue.svg` in <https://github.com/base/brand-kit> | Base brand guide, <https://base.org/brand> | `b4f2b487011713f9` |
| `public/logos/bnb.svg` | BNB Smart Chain, BNB | `assets/bnb.svg` served by <https://docs.bnbchain.org/> (the BNB Chain documentation site's own mark) | BNB Chain brand assets, <https://www.bnbchain.org/en/brand-assets> | `b8ff1ce0b5af2e2d` |
| `public/logos/solana.svg` | Solana, SOL | <https://solana.com/src/img/branding/solanaLogoMark.svg>, linked from <https://solana.com/branding> | Solana Foundation brand guidelines on that page | `3d3401109aa061de` |
| `public/logos/robinhood.svg` | Robinhood Chain (light theme) | `feather-dark.svg` used as the site logo of <https://docs.robinhood.com/chain/> (served from `cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/`) | Robinhood Markets, Inc.; press and brand enquiries via <https://robinhood.com/us/en/about/press/> | `82ef124f9e1446c4` |
| `public/logos/robinhood-white.svg` | Robinhood Chain (dark theme) | `feather-light.svg`, same site | same | `5b7506f11991ee9a` |
| `public/logos/eth.svg` | ETH, WETH | `public/images/assets/svgs/eth-diamond-purple.svg` in <https://github.com/ethereum/ethereum-org-website> | ethereum.org assets page, <https://ethereum.org/en/assets/> (CC BY 4.0 for the site's own assets; the diamond is the Ethereum Foundation's mark) | `7320e64e211db747` |
| `public/logos/usdc.svg` | USDC | `Token Logo/USDC Token.svg` from Circle's USDC logo pack, linked from <https://www.circle.com/brand> | Circle brand page terms | `fe4f9d5f34ef4ebe` |

Full hashes: `sha256sum public/logos/*.svg`.

## Rules for the interface

- A mark is always shown with the name it identifies next to it, at 19 px
  (chain badges) or inside a 29 px circle (token rows). It is never
  recoloured, cropped, rotated or combined with the ATRA mark, and it is
  never used as a button on its own.
- Robinhood's two official variants are both shipped; the stylesheet shows
  the black feather on the light theme and the white one on the dark theme.
  No other mark changes with the theme.
- A chain or token that has no entry here shows no image, only its name
  (`ChainMark` and `TokenMark` in `src/components.tsx`). Do not fill the
  gap with a lookalike.
- The ATRA identity itself (the heron engraving) is documented in
  `PROVENANCE.md`; it is public domain and is the only mark we alter (a
  CSS invert on the dark theme).
