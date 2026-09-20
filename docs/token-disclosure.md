# $ATRA token disclosure

Written for: anyone who has seen a token with this project's name and wants
to know what it has to do with the software. State on 2026-09-20.

## The baseline statement

$ATRA is an optional community support token. Holding $ATRA is not required
to download, run, modify, or use ATRA. Project infrastructure may be
voluntarily funded by the creator, including with creator-fee revenue
received from third-party launch platforms.

## What that means, concretely

- **Nothing in this repository checks for the token.** There is no wallet
  gate, no balance check, no allowlist keyed on holding it, and no plan to
  add one. Auto-trade and auto-LP do not and will not require holding it.
  The hosted gateway, when it exists, authenticates installations with a
  token minted by the project, which is an unrelated string, not a crypto
  asset.
- **The software is MIT-licensed.** Anyone can download, run, modify,
  redistribute and sell it, with or without $ATRA, now and later.
- **The project treasury and user funds never mix.** The treasury agent in
  Phase 5 is watch-only by construction and has no access to any user's
  agent wallet ([architecture.md](architecture.md), [treasury.md](treasury.md)).
  Whether the treasury is ever funded, and from what, is the creator's
  voluntary decision; it is not a promise to holders.

## What $ATRA is not

- It is **not equity** and does not represent ownership of the project,
  the code, the creator's company (if any) or anything else.
- It carries **no guaranteed yield**.
- It carries **no guaranteed revenue share**.
- It carries **no guaranteed infrastructure funding**. "May be voluntarily
  funded" means exactly that: may, voluntarily, by the creator, and it can
  stop.
- It carries **no expectation of appreciation**. Its price is whatever a
  market says at the moment, which may be zero.
- It gives **no governance rights**, no vote and no say over the roadmap.
- It is **not required** for any feature, and no feature will be moved
  behind it.

## Where the software's numbers come from

None of the phase reports, the README or the dashboard contains a
performance figure, a profit figure, a user count or a volume, because none
exist. ATRA has never executed a live trade. If a page somewhere claims
otherwise in connection with the token, that page is not this project.

## If you hold $ATRA and want something from the project

Open an issue or a pull request like anyone else
([CONTRIBUTING.md](../CONTRIBUTING.md)). Holding the token changes nothing
about how it is handled.
