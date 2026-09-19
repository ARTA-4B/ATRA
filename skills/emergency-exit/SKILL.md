---
name: emergency-exit
description: How to stop ATRA immediately, what each control does, and why stopping never depends on the model, the network or the scheduler.
phase: 1
---

# Emergency exit

## The guarantee

**Stopping works when everything else is broken.**

The emergency stop writes one row in the local database. Every execution path
reads that row before acting. It does not call a model, does not touch the
network, does not wait for a scheduler tick and does not depend on any agent
being responsive. If the reasoning model is offline, hallucinating or looping,
the stop still takes effect.

It also survives a restart. A stop that forgot itself on reboot would not be an
emergency stop.

## The three controls

| Control | Effect | Positions | Reversal |
|---|---|---|---|
| **Pause** | No new actions | Left open | Resume |
| **Emergency stop** | No actions at all, LIVE revoked | Left open | Re-authentication |
| **Revert to PAPER** | Execution becomes simulated | Left open | Full LIVE checklist |

### Pause

For ordinary caution: a market you want to sit out, a maintenance window, a
change you are making to the policy. Agents keep researching; nothing executes.

### Emergency stop

For "something is wrong and I want it to stop now". In addition to blocking
every action it **revokes LIVE mode**. Recovering means walking the whole
activation checklist again rather than clicking resume — deliberately, because
whatever caused the emergency deserves a deliberate decision before real money
moves again.

Clearing it requires re-authentication. Engaging it does not: stopping is
always safe, so it is never gated behind a password prompt the operator might
not get through in time.

Resume will **not** clear an emergency stop. They are different controls with
different intent, and conflating them would let a routine resume undo a
deliberate halt.

## How to stop

**Dashboard** — the stop control is on every page.

**API** (from the machine running ATRA):

```bash
curl -X POST http://127.0.0.1:3000/api/v1/control/emergency-stop \
  -H 'content-type: application/json' \
  -H 'x-atra-client: atra-dashboard' \
  -H "cookie: atra_session=$SESSION" \
  -d '{"reason":"stopping while I investigate"}'
```

**Container** — `docker compose stop atra`. The runtime handles SIGTERM: it
stops accepting requests, locks the vault and checkpoints the database. Nothing
in flight is abandoned silently; anything unfinished is reconciled on the next
start.

**Last resort** — kill the process. The vault key is memory-only, so it is gone
the moment the process is. Open positions stay on-chain and are reconciled when
ATRA next starts.

## What stopping does not do

It does **not** close positions, sell holdings or move funds. It prevents new
actions. Exiting positions is a separate, deliberate operation, because an
automatic market-sell of everything at the worst possible moment is its own
category of disaster.

To exit positions, use the dashboard's reduce-only exit path once you have
decided that is what you want. Reduce-only actions are exempt from the
exposure-capping limits precisely so a breached limit cannot trap you.

## Withdrawing funds

The emergency stop does not block the operator from withdrawing their own
money. Withdrawal is an operator action, not an agent action: it requires a
session, a fresh re-authentication and a typed confirmation, and it works
whether or not the stop is engaged.

## Restoring normal operation

1. Find out what happened. The Activity page shows every decision, including
   every rejection and its reason.
2. Fix the cause — a bad limit, an unreachable RPC, a token that should not
   have been allowlisted.
3. Re-authenticate and clear the stop.
4. If you want LIVE again, walk the activation checklist: acknowledgement,
   re-authentication, risk settings reviewed, wallet funded, gas present,
   adapter available.

## For operators reading this in a hurry

- The stop button is always on screen.
- It works even if the model is broken.
- It does not sell anything.
- It survives a restart.
- Your keys are unaffected; they never left the machine.

## Related

- `skills/risk-management/SKILL.md` — the limits that apply when running
- `skills/wallet/SKILL.md` — withdrawal and export
