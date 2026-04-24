# Store

The central class. Represents a single peer in a cluster.

## Import

```ts
import { Store } from "sql-git";
```

## `Store.open(opts)` → `Promise<Store>`

```ts
static async open(opts: {
  root: string;
  peerId: string;
  masterId: string;
  actions: ActionRegistry;
  debug?: { keepSquashedLog?: boolean };
}): Promise<Store>;
```

Opens (or initialises) a peer at `opts.root`. Safe to call on a fresh
directory. Side effects:

- Creates `<root>/peers/` if missing.
- Creates `<root>/peers/<peerId>.jsonl` as an empty file if missing.
- Loads `<root>/snapshot.db` if present; otherwise starts with an empty
  in-memory db.
- Replays the applicable log entries to rebuild the in-memory state:
  - **Master** replays its own log fully.
  - **Peer** replays the master log up to the seq it had last observed
    (from `baseMasterSeq` / `master_ack`), then replays its own
    pending actions.

Throws `FileSyncLagError` if the log references a snapshot head ahead
of what's on disk. Retry after the file syncer catches up.

## Instance properties

```ts
store.db               // live in-memory Db — swap-protected, see below
store.root             // configured root path
store.peerId           // this peer's id
store.masterId         // cluster master id
store.isMaster         // peerId === masterId
store.actions          // the ActionRegistry passed to open()
store.currentMasterSeq // highest master seq this peer has integrated
store.masterLog        // master-only: canonical log (empty on peers)
store.peerLog          // peer-only: local pending + acks
store.nextMasterSeq    // master-only: next free master seq
store.nextPeerSeq      // peer-only: next free peer seq
store.debug            // frozen { keepSquashedLog }
```

::: warning
`store.db` is reassigned by `sync()` — the old reference is closed. Do
not cache it across `sync()` calls; read `store.db` directly each time
you need to query.
:::

## `store.submit(name, params)` → `Promise<void>`

Apply a registered action and append it to this peer's log.

- Master: `nextMasterSeq++`, log entry's `source` is `{peer: masterId,
  seq: nextMasterSeq}`.
- Peer: `nextPeerSeq++`, log entry's `baseMasterSeq = currentMasterSeq`.

Throws if `name` isn't in the registry, or if the action throws on
apply. If the action throws, the log is *not* appended.

## `store.sync(opts?)` → `Promise<SyncReport>`

```ts
await store.sync({ onConflict?: Resolver });
```

Incorporate changes from the cluster.

Returns a `SyncReport`:

```ts
type SyncReport = {
  applied: number;
  skipped: number;
  dropped: number;
  forced: number;
  convergent?: number;  // peer-only: actions absorbed by the pre-check
  squashedTo?: number;  // master-only: new snapshot head if squashed
};
```

See [Concepts — Sync & rebase](/concepts/sync-and-rebase) for the full
behaviour.

## `store.close()` → `void`

Close the underlying SQLite connection. The log and snapshot on disk
are untouched. `store.db` is unusable after this; `sync` / `submit` will
throw.

## Lifecycle

```ts
const store = await Store.open({ ... });

try {
  await store.sync();
  for (const change of myChanges) {
    await store.submit(change.name, change.params);
  }
  await store.sync();
  for (const row of store.db.prepare("SELECT * FROM things").all()) {
    // ...
  }
} finally {
  store.close();
}
```

## Example: multi-stage sync loop

Not common, but worth showing — a daemon that syncs, applies queued
mutations, syncs again, and idles on a timer:

```ts
async function tick(store: Store, queue: Array<[string, unknown]>) {
  await store.sync();
  while (queue.length) {
    const [name, params] = queue.shift()!;
    await store.submit(name, params);
  }
  await store.sync();
}

setInterval(() => tick(store, pendingMutations).catch(console.error), 1000);
```

## See also

- [Actions](/concepts/actions)
- [Sync & rebase](/concepts/sync-and-rebase)
- [Types](/api/types)
