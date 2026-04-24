# Node quickstart

The shortest path from zero to a two-peer replicated app on Node.

## Project setup

```bash
mkdir notes-demo && cd notes-demo
pnpm init
pnpm add 'https://github.com/WjcmeAFJb/sql-git/releases/download/v0.1.0/sql-git-0.1.0.tgz' \
        'https://github.com/WjcmeAFJb/sql-read-tracking/releases/download/v0.2.0/sqlite3-read-tracking-0.2.0.tgz'
```

Node ≥ 22.6 runs TypeScript directly via `--experimental-strip-types`.
Older Nodes can use `tsx` / `ts-node`.

## actions.ts — your write vocabulary

```ts
// actions.ts
import type { ActionRegistry } from "sql-git";

export const actions: ActionRegistry = {
  init: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id    TEXT PRIMARY KEY,
        body  TEXT NOT NULL,
        ts    TEXT NOT NULL
      );
    `);
  },
  append: (db, p) => {
    const { id, body, ts } = p as { id: string; body: string; ts: string };
    db.prepare("INSERT INTO notes (id, body, ts) VALUES (?, ?, ?)").run(id, body, ts);
  },
  delete: (db, p) => {
    const { id } = p as { id: string };
    const r = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    if (r.changes === 0) throw new Error(`delete: no note ${id}`);
  },
};
```

## app.ts — open, submit, sync

```ts
// app.ts
import "sql-git/fs-node"; // self-registers the Node FS adapter
import { Store } from "sql-git";
import { actions } from "./actions.ts";

const [, , peerId, rootArg] = process.argv;
if (!peerId) throw new Error("usage: node --experimental-strip-types app.ts <peerId> [root]");
const root = rootArg ?? "/tmp/notes";

const store = await Store.open({
  root,
  peerId,
  masterId: "alice",
  actions,
});

// Master bootstraps the schema once. Every peer replays it.
if (store.isMaster && !store.db.prepare(
  "SELECT name FROM sqlite_master WHERE name = 'notes'"
).get()) {
  await store.submit("init", {});
}

// Submit a note for every command-line arg past the first two.
for (const body of process.argv.slice(4)) {
  await store.submit("append", {
    id: `n-${Date.now().toString(36)}`,
    body,
    ts: new Date().toISOString(),
  });
}

// Pull in everyone else's changes; rebase our own on master.
const report = await store.sync();
console.log("sync report:", report);

// Read.
for (const row of store.db.prepare("SELECT * FROM notes ORDER BY ts").all()) {
  console.log(row);
}

store.close();
```

## Run two peers

Create a shared root (a folder that a file syncer is watching — for the
demo just a regular directory works; the two peers in the same process
tree race-free because only one peer writes each file):

```bash
# Terminal 1 — master
node --experimental-strip-types app.ts alice /tmp/notes "hello from alice"

# Terminal 2 — peer bob
node --experimental-strip-types app.ts bob /tmp/notes "hello from bob"
```

Both invocations print a sync report with non-zero `applied` after the
second run. The log files at `/tmp/notes/peers/` show what each peer
submitted.

## What happened on disk

```
/tmp/notes/
  snapshot.db                 JSON-serialized squashed state (master-only)
  peers/
    alice.jsonl               master's canonical log
    bob.jsonl                 bob's proposed actions + master_ack entries
```

The full file format is in [Concepts — File-sync model](/concepts/file-sync).

## Multi-peer: add a third peer

Add `charlie`:

```bash
node --experimental-strip-types app.ts charlie /tmp/notes "first charlie note"
```

On `charlie`'s next sync, master incorporates charlie's action; a
subsequent sync on alice or bob applies the new master entry.

## Adding a conflict resolver

If you submit something that doesn't rebase cleanly — e.g., `delete` a
note master has already deleted — sync on the peer will invoke the
resolver you pass:

```ts
const report = await store.sync({
  onConflict: async (ctx) => {
    console.error("conflict on", ctx.action.name, ctx.action.params);
    if (ctx.kind === "error") return "drop";   // action errored on current state
    return "force";                             // master's suffix won't reorder cleanly
  },
});
```

See [Concepts — Conflicts](/concepts/conflicts) for the full resolver
contract and the `submit` escape hatch for queuing mitigations.

## Hooking up file watches

For an always-on daemon:

```ts
import chokidar from "chokidar";

let syncing: Promise<unknown> | null = null;
const debounce = 200;
let timer: NodeJS.Timeout | null = null;

const watcher = chokidar.watch(root, { ignoreInitial: true, depth: 3 });
watcher.on("all", (_evt, path) => {
  // Ignore our own writes, else we loop.
  if (path.endsWith(`peers/${peerId}.jsonl`)) return;
  if (store.isMaster && path.endsWith("/snapshot.db")) return;

  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (syncing) return;
    syncing = store.sync().finally(() => (syncing = null));
  }, debounce);
});
```

The [TUI money tracker](https://github.com/WjcmeAFJb/sql-git/tree/master/demo)
under `demo/` is a complete application this size — it wires up chokidar
to a React ink interface.

## Next

- [Browser (OPFS) quickstart](/guide/browser-opfs)
- [Multi-tab + cross-tab sync](/guide/cross-tab)
- [Concepts — Sync & rebase](/concepts/sync-and-rebase)
