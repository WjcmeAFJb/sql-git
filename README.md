# sql-git

**Distributed SQLite storage with per-peer action logs, master squashing,
and rebase-style conflict resolution.** The shape is `git`'s — every peer
writes its own log, one peer is upstream ("master"), and other peers
rebase on sync. The storage is SQLite — actions are deterministic
`(db, params) → void` functions replayed verbatim on every peer, so local
reads are plain SQL against an in-memory database.

sql-git does **not** ship its own network layer. It drops a small set of
JSONL logs and a single `snapshot.db` into a directory that you replicate
by any means you like — Syncthing, Dropbox, `rsync`, a shared SMB mount,
or, in the browser, OPFS + BroadcastChannel. The library's job is to make
every peer's in-memory state converge, given only atomic file I/O.

- 📚 **Docs:** https://WjcmeAFJb.github.io/sql-git/
- 🕹️ **Live demo (OPFS + React):** https://WjcmeAFJb.github.io/sql-git/demo/
- 💾 **Companion ORM:** [`sql-reactive-orm`](https://github.com/WjcmeAFJb/sql-reactive-orm)
- 🧪 **SQLite WASM with read tracking:** [`sqlite3-read-tracking`](https://github.com/WjcmeAFJb/sql-read-tracking)

---

## Why

Offline-first apps want one of three things:

1. **Every peer has the whole database locally**, and edits work without a
   server.
2. **Conflicts that can be resolved are resolved silently**; the ones that
   truly can't are surfaced for review — not silently dropped, not
   merged into surprise last-write-wins soup.
3. **No custom sync infrastructure** — reuse a file syncer the user
   already trusts with their laptop.

sql-git is the smallest primitive that gets you all three. The whole
library is ~1 KLOC; the hard parts (VDBE-level read tracking,
permutation-equivalent convergence, squashing) are factored into small
composable modules.

## Install

sql-git isn't on npm yet. Install the release tarball straight from a
GitHub release:

```bash
pnpm add 'https://github.com/WjcmeAFJb/sql-git/releases/download/v0.1.0/sql-git-0.1.0.tgz'
```

Or pin to a tag in git:

```bash
pnpm add 'github:WjcmeAFJb/sql-git#v0.1.0'
```

sql-git is shipped as TypeScript source (the exported entry is
`src/index.ts`). Any bundler or Node loader that handles `.ts` works
(Vite, esbuild, Bun, `node --experimental-strip-types ≥ 22.6`, `tsx`).

You also need the SQLite build with read tracking installed alongside:

```bash
pnpm add 'https://github.com/WjcmeAFJb/sql-read-tracking/releases/download/v0.2.0/sqlite3-read-tracking-0.2.0.tgz'
```

## Quickstart (Node)

```ts
import "sql-git/fs-node"; // auto-installs the Node FS adapter
import { Store, type ActionRegistry } from "sql-git";

// Actions are the only way state ever changes. They're deterministic
// functions of (db, params); the library replays them verbatim on every
// peer, so whatever you write here becomes the shared schema.
const actions: ActionRegistry = {
  init: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id    TEXT PRIMARY KEY,
        body  TEXT NOT NULL,
        ts    TEXT NOT NULL
      );
    `);
  },
  append_note: (db, p) => {
    const { id, body, ts } = p as { id: string; body: string; ts: string };
    db.prepare("INSERT INTO notes (id, body, ts) VALUES (?, ?, ?)").run(id, body, ts);
  },
};

const store = await Store.open({
  root: "/tmp/notes",           // shared folder (Syncthing, Dropbox, …)
  peerId: "alice",
  masterId: "alice",            // alice is upstream; any other peerId joins as a peer
  actions,
});

// Master bootstraps the schema once.
if (store.isMaster) await store.submit("init", {});

// Submit an action — applies locally *and* appends to the peer's log.
await store.submit("append_note", {
  id: "n-1",
  body: "hello from node",
  ts: new Date().toISOString(),
});

// Reads are straight SQLite against an in-memory db.
const rows = store.db.prepare("SELECT * FROM notes").all();

// Pull in everyone else's changes. On a peer, this also rebases local
// pending actions onto master; on master, it incorporates peers' logs.
await store.sync();

store.close();
```

## Quickstart (Browser / OPFS)

```ts
import { setSqliteInitConfig } from "sql-git";
import { createOpfsFs } from "sql-git/fs-opfs";
import wasmUrl from "sqlite3-read-tracking/wasm?url";

// 1) Point the SQLite WASM factory at a bundler-resolved URL.
setSqliteInitConfig({ locateFile: () => wasmUrl });

// 2) Mount OPFS as the global FS + path adapter for sql-git. Every
//    Store in this tab will read/write files under this OPFS subdir.
const opfs = createOpfsFs();
await opfs.init({ rootName: "my-app" }); // /my-app/ inside the browser's OPFS
opfs.install();

// 3) Open a Store. Its `root` is a path *inside* the OPFS subdir above.
import { Store } from "sql-git";
import { actions } from "./my-actions"; // same ActionRegistry shape as Node

const store = await Store.open({
  root: "/alice",
  peerId: "alice",
  masterId: "alice",
  actions,
});

// 4) Other tabs (same origin, same rootName) automatically see every
//    write via BroadcastChannel. Hook up a debounced auto-sync:
opfs.fs.watch!("/alice", (e, origin) => {
  if (origin !== "remote") return;          // skip our own writes
  if (e.path.endsWith("/peers/alice.jsonl")) return; // skip our own log
  store.sync();                              // debounce in practice
});
```

A working end-to-end React app is under [`demo-opfs2/`](./demo-opfs2/) —
full peer picker, file-sync UI, SQL console, conflict bar, action log
sidebar. Run `pnpm --filter sql-git-opfs-demo2 dev` and open two tabs as
different peers to watch cross-tab replication.

## Core concepts

### Actions

```ts
export type ActionFn = (db: Db, params: unknown) => void;
```

An action is a **pure function of `(db, params)`** that mutates `db`.
Determinism is critical: `params` is persisted in the log as JSON and
replayed on every peer; any non-determinism (wall-clock reads, `RANDOM()`,
external I/O) causes divergence. Pass time + random IDs as params if you
need them.

Every mutation in your app is one of these, looked up by name:

```ts
const actions: ActionRegistry = {
  create_account: (db, { id, name }) => { /* INSERT */ },
  rename_account: (db, { id, name }) => { /* UPDATE */ },
  delete_account: (db, { id })        => { /* DELETE */ },
};
```

`store.submit(name, params)` is the only write primitive.

### Files on disk

For a cluster root `/root/`:

```
/root/
  snapshot.db                  master-only: the squashed state
  peers/
    <masterId>.jsonl           master log: canonical ordering
    <peerId>.jsonl             peer log: proposed + acked entries
    debug/                     optional: keep-squashed-log traces
```

Every file has **a single writer** — master writes `snapshot.db` and its
own log; peer `X` writes only `peers/X.jsonl`. This is the invariant that
makes the external sync layer simple: any newest-wins file syncer between
peers is correct as long as it preserves the single-writer rule.

### Roles: master vs peer

- The peer whose id equals `masterId` is the upstream. Its log is the
  canonical ordering; sync on the master incorporates other peers'
  actions.
- Every other peer records its own proposals; sync on a peer rebases
  those proposals onto the current master head (with conflict resolution
  when rebasing would change their effect).

This is the only asymmetry. There is no election, no quorum, no Paxos —
`masterId` is a demo-time constant. For production you pick it once per
cluster root.

### Sync

`await store.sync({ onConflict })` does different things depending on
role:

- **Master** — walks each peer's log and incorporates non-conflicting
  actions, stopping at the first conflict per peer. After all peers are
  processed, attempts to squash the acked log prefix into `snapshot.db`.
- **Peer** — drops own actions that master has already incorporated,
  rebuilds the local db from `snapshot.db` + master log, then rebases
  remaining own actions. Genuine conflicts invoke `onConflict`.

### Conflict resolution

Peer sync invokes your resolver when one of your actions can't be
rebased:

```ts
type Resolver = (ctx: ConflictContext) => Resolution | Promise<Resolution>;
type Resolution = "drop" | "force" | "retry";
```

```ts
type ConflictContext = {
  action: PeerActionEntry;       // the action in conflict
  kind: "error" | "non_commutative";
  error?: Error;                 // present for "error"
  masterSuffix: MasterActionEntry[]; // actions after action.baseMasterSeq
  baseDb: Db;                    // read-only db at action.baseMasterSeq
  rebasedDb: Db;                 // read-only db at new master head
  submit(name: string, params: unknown): void;  // queue a mitigation
};
```

`ctx.submit(...)` queues a **mitigation** (a new peer action) that will
be committed to your log whether you pick `drop`, `force`, or `retry`.
Combined with `retry`, this lets you unblock an action automatically —
e.g. prepend a top-up transfer before retrying an overdrafting expense.

See the demo's `ConflictBar` for a live example: the conflict is shown
as a non-modal dock, the tabs stay interactive, and any action you
submit during the conflict flows through `ctx.submit`.

### Convergence detector

Before invoking the resolver, peer sync runs three gates that silently
absorb most of what looks like a conflict on paper:

1. **Global pre-check.** If applying *every* unincorporated peer action
   reaches the same final state as the rebased master, drop them all
   silently — the peer's intent has already been realized.
2. **Tier 1 (read/write-set cluster).** Uses VDBE-level read/write
   tracking from [sqlite3-read-tracking](https://github.com/WjcmeAFJb/sql-read-tracking)
   to detect causally disjoint actions. Disjoint actions commute for
   free.
3. **Tier 2 (permutation).** Run `base + action + suffix` and
   `base + suffix + action`; if both succeed and reach the same state,
   the action is convergent.

Only actions that fail all three gates reach your resolver.

### File sync is external

sql-git never watches files or opens sockets. Any file syncer that
preserves **atomic file writes** and **single-writer-per-file** is a
correct transport:

- **Syncthing / Dropbox / iCloud / rsync** on disk.
- **OPFS + BroadcastChannel** in the browser (see `src/fs-opfs.ts`).
- **Git** — it's in the name for a reason: `git push/pull` of the root
  directory is a legitimate transport as long as you commit the logs.
- An in-memory adapter for tests.

The on-disk format is deliberately small enough that you can `tail -F
peers/<peerId>.jsonl` during development and see actions land in real
time.

## Demos

### `demo/` — TUI money tracker (Node)

Ink-based. Run `tracker <root> --peer-id alice` and `tracker <root>
--peer-id bob` in two terminals pointed at a Syncthing-shared folder.
Full accounts + categories + transactions model with balance triggers
and conflict handling. See [`demo/walkthrough.sh`](./demo/walkthrough.sh).

### `demo-opfs2/` — OPFS + Vite + React bank demo

The flagship browser demo: per-tab peer picker, file-sync UI between
arbitrary peers, SQL console (mutations go through an `exec_sql`
action), conflict bar docked at the bottom, action log sidebar, stats +
per-category breakdown via the reactive ORM.

Run locally:

```bash
pnpm install
pnpm --filter sql-git-opfs-demo2 dev
```

Open http://localhost:5173/ in two tabs — pick `alice` in one and `bob`
in the other. Everything replicates.

## Development

```bash
pnpm install
pnpm test              # Node unit tests
pnpm test:e2e          # tmux-driven TUI integration tests
pnpm typecheck         # tsc --noEmit

# Browser demo
pnpm --filter sql-git-opfs-demo2 dev
pnpm --filter sql-git-opfs-demo2 test:e2e   # 47 Playwright specs
```

## License

LGPL-3.0-or-later — see [`LICENSE`](./LICENSE) for the project notice,
[`COPYING.LESSER`](./COPYING.LESSER) for the full LGPL text, and
[`COPYING`](./COPYING) for the GPL text it extends.
