# Master & peers

sql-git has exactly two roles: **master** and **peer**. The split is
a single line of configuration; `Store.open` detects it by comparing
`peerId === masterId`.

## What master does

The master is the canonical ordering authority:

- **Its log is the linear history** that every peer rebases onto.
- **Only master writes** `snapshot.db` and `peers/<masterId>.jsonl`.
- **Master's `sync()`** walks every other peer's log, incorporates
  non-conflicting actions into its own log, and periodically squashes
  the acked prefix into `snapshot.db`.
- **Master never invokes** the conflict resolver. Actions it can't
  rebase from a specific peer are marked `skipped` — they stay in
  that peer's log until the peer's own sync resolves the conflict.

## What peers do

Every other peer:

- **Writes only to `peers/<peerId>.jsonl`**.
- **Submits actions** with a `baseMasterSeq` — the master seq it had
  observed when submitting. Master uses this for conflict detection on
  incorporation.
- **On `sync()`, rebuilds** the local in-memory db from `snapshot.db` +
  current master log, then rebases remaining local actions. Genuine
  conflicts invoke your `onConflict` resolver.

## Picking a master

For the demos, `masterId` is hard-coded to `"alice"`. In production:

- **One of the users / instances wins.** Usually whoever sets up the
  shared folder — a laptop, a small VPS, a phone that's always on.
- **It doesn't have to be always online.** If master is offline, peers
  can still submit locally — they just can't incorporate each other's
  actions until master comes back and syncs.
- **It can be any of them, at any time — as long as nobody else thinks
  they're master too.** sql-git assumes `masterId` is stable per cluster
  root. If you swap masters, do it by convention outside the library
  (e.g., a shared `host.json` in the root).

## Asymmetry summary

|                                  | master                      | peer                             |
| -------------------------------- | --------------------------- | -------------------------------- |
| Writes `snapshot.db`             | ✓                           | —                                |
| Writes `peers/<self>.jsonl`      | ✓ (master log)              | ✓ (pending actions + acks)       |
| Reads everyone's log             | ✓ (to incorporate)          | Only master's log (to rebase)    |
| Invokes conflict resolver        | —                           | ✓                                |
| Can squash                       | ✓                           | —                                |
| Submit local action              | ✓ (directly to master log)  | ✓ (pending; rebased on sync)     |

## What if master goes rogue?

Master doesn't have superpowers — it can't silently rewrite your
history, just its own (by definition, its log is the authoritative
ordering). If you care about this, treat master as a node running your
code and don't run arbitrary upstreams.

## Multi-cluster

Each `root` is independent. An app can open multiple stores at different
roots with different `masterId`s — maybe one cluster per "workspace."

## Next

- [Sync & rebase](/concepts/sync-and-rebase)
- [File-sync model](/concepts/file-sync)
