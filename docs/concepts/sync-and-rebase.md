# Sync & rebase

`await store.sync()` is the single method that makes sql-git
distributed. It does two different things depending on role.

## On master: incorporate

```ts
// runs runMasterSync internally
const report = await store.sync();
```

1. List every `peers/*.jsonl` file in the root that isn't master's own.
2. For each peer, in sorted id order:
    - Walk the peer's log.
    - Any `master_ack` entry updates master's `peer_ack` tracking.
    - Any `action` not yet incorporated: run it through the conflict
      detector.
      - If clean → append to master log with `source: {peer, seq}`.
      - If conflicting → stop processing that peer's later actions
        (`report.skipped++`).
3. Call `attemptSquash`: if every non-master peer has acked past the
   current snapshot head, write a new `snapshot.db` and trim the log.

Returns a `SyncReport`:

```ts
type SyncReport = {
  applied: number;      // actions landed in master log
  skipped: number;      // actions stopped at (first-conflict + cascade)
  dropped: 0;           // master never drops — peers might
  forced: number;       // forced actions accepted this round
  squashedTo?: number;  // new snapshot head if squashed
};
```

## On peer: rebase

```ts
const report = await store.sync({ onConflict: myResolver });
```

1. Read master log from disk (`peers/<masterId>.jsonl`).
2. Reconcile: find master entries whose `source.peer === this.peerId` —
   those are our actions master already incorporated; drop them from
   our local log.
3. Rebuild the in-memory db from `snapshot.db` + master log up to
   `newMasterHead`.
4. Run the **convergence gates** on the set of our unincorporated
   actions. Anything that converges silently is dropped from our log
   and recorded as `convergent`.
5. For each remaining action:
    - Replay it onto the rebased db.
    - If it applies cleanly (disjoint or permutation-equal with the
      master suffix) → apply and append to `kept`.
    - Otherwise → call `onConflict(ctx)`.
6. Rewrite our peer log as `[...kept, master_ack(newMasterHead)]`.
7. Swap `store.db = rebasedDb`.

Returns a `SyncReport` with `applied / skipped / dropped / forced /
convergent`.

## When to call sync()

Three patterns:

### 1. Manual / on-demand

Simplest. Call `await store.sync()` after a batch of local submits,
or when the user clicks "Refresh". Works for read-heavy apps where
stale-by-a-few-seconds is fine.

### 2. On file changes

Watch the root directory; debounce; sync:

```ts
// Node
import chokidar from "chokidar";
const watcher = chokidar.watch(root, { ignoreInitial: true });
watcher.on("all", () => scheduleSync());

// Browser / OPFS
opfs.fs.watch!(`/${peerId}`, (e, origin) => {
  if (origin !== "remote") return;
  scheduleSync();
});
```

### 3. Periodic

```ts
setInterval(() => void store.sync(), 30_000);
```

For always-on background processes.

All three compose — the pattern in real apps is "on file changes AND
every N seconds AND on explicit user action".

## Filtering self-writes

Master writes `snapshot.db` + its own log; peer X writes
`peers/X.jsonl`. Any auto-sync trigger that observes those as a
"remote write" will create an infinite feedback loop — every sync
writes to disk, which triggers sync, which writes to disk, ...

Filter by path suffix before dispatching:

```ts
if (path.endsWith(`peers/${peerId}.jsonl`)) return;
if (isMaster && path.endsWith("/snapshot.db")) return;
if (isMaster && path.endsWith(`peers/${masterId}.jsonl`)) return;
```

## Debouncing

Real file syncers batch writes. A burst of 10 writes in 50ms should
result in one sync, not ten:

```ts
let timer: number | null = null;
function scheduleSync() {
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(() => {
    if (modeRef.current === "idle") store.sync();
  }, 250);
}
```

The reference React hook
([`demo-opfs2/src/hooks/use-watcher.ts`](https://github.com/WjcmeAFJb/sql-git/blob/master/demo-opfs2/src/hooks/use-watcher.ts))
shows the idiomatic version.

## Transient errors

- **`FileSyncLagError`** — the master log references a snapshot head that
  `snapshot.db` hasn't caught up to. Usually means your file syncer
  delivered the log before the snapshot. Safe to retry after a short
  delay.
- **Conflict without resolver** — `sync()` throws if a peer action
  conflicts and no `onConflict` was passed. Pass one.

## Next

- [Conflict resolution](/concepts/conflicts)
- [Convergence detection](/concepts/convergence)
