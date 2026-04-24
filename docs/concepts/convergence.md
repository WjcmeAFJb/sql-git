# Convergence detection

sql-git tries hard to avoid bothering you. Before the resolver runs,
three gates silently absorb anything whose effect on the database is
equivalent across orderings.

## Gate 0: global pre-check

Before looking at individual actions, peer sync asks:

> If I apply *every* unincorporated peer action on a fresh base plus
> this peer's own prior incorporations, does the result equal the
> rebased master state?

If yes, the peer's entire pending suffix is effectively a no-op:
whatever net effect the actions were aiming at has already been
realized by master. Drop the whole batch, record `master_ack`, move
on.

Counted as `convergent` in the sync report.

## Gate 1: R/W-set cluster

Every action on sql-git runs under VDBE-level read/write tracking
(provided by [`sqlite3-read-tracking`](https://github.com/WjcmeAFJb/sql-read-tracking)).
After tracing the peer action and every master-suffix action on a
clone of `baseDb`, the detector computes:

- **Write–write overlap** on the same `(table, rowid[, column])`.
- **Read–write overlap** (one reads what another writes).
- **Phantom reads** (predicate ranges that would be broken by an insert).

If the peer action has **no overlap edges** with any suffix action,
the two branches are causally disjoint — they commute for free. We
still verify the peer action applies cleanly on the current rebased
state (an unrelated CHECK could fire) and accept.

Counted as `applied` / `reason: "disjoint"`.

## Gate 2: permutation-equal

When Gate 1 sees overlap, we fall back to the classic commutativity
test:

- Run `base + action + suffix`.
- Run `base + suffix + action`.
- Compare final db states. If equal, accept.

Counted as `applied` / `reason: "permutation-equal"`.

## What the detector can't catch

It's a sound *over-approximation* of "needs resolver" — false
positives happen. The documented limitation is **per-row net-effect
equivalence via deletion**: two peers independently `UPDATE` then
`DELETE` the same row. Both orderings end at "row gone", but the
mid-sequence UPDATE errors in one ordering because its target has
already been deleted. Recognizing that case requires semantic diffing
beyond R/W sets; the detector hands it to your resolver.

## Why three gates instead of one

- **Gate 0 is O(1)** per sync: one clone, one replay, one compare. In
  "peer reconnected after a long offline stretch and master already
  heard from everybody else" cases, this collapses minutes of pending
  work to nothing.
- **Gate 1 is cheap per action**: the overlap check is set algebra on
  the tracking log, which the VDBE already produced for free during
  replay.
- **Gate 2 is expensive per action**: two full replays + a structural
  compare. We only fall into it when Gate 1 found real overlap.

In practice, most real conflict-shaped events in a CRUD app hit Gate 0
or Gate 1; Gate 2 mostly matters for workflows with explicit
commutativity (e.g., two peers incrementing the same counter in
opposite directions).

## Inspecting what happened

The `SyncReport` tells you:

```ts
{ applied: 3, skipped: 0, dropped: 0, forced: 0, convergent: 7 }
```

- `applied` — actions that landed after rebase, including both
  "disjoint" and "permutation-equal" resolutions.
- `convergent` — actions absorbed by the global pre-check.
- `skipped` (master-only) — actions master chose not to process this
  round.
- `dropped` / `forced` — resolver-chosen paths.

## Reading the source

- [`src/conflict.ts`](https://github.com/WjcmeAFJb/sql-git/blob/master/src/conflict.ts)
  has the Gate 1 + Gate 2 logic.
- [`src/sync-peer.ts`](https://github.com/WjcmeAFJb/sql-git/blob/master/src/sync-peer.ts)
  has Gate 0 and the per-action loop.

## Next

- [File-sync model](/concepts/file-sync)
- [API — Store](/api/store)
