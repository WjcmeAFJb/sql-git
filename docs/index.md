---
layout: home
hero:
  name: sql-git
  text: Distributed SQLite with per-peer action logs
  tagline: Git's shape, SQLite's storage, any file syncer's transport. Offline-first apps that converge on every device.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Live demo
      link: /sql-git/demo/
    - theme: alt
      text: GitHub
      link: https://github.com/WjcmeAFJb/sql-git

features:
  - title: Per-peer action logs
    details: Every mutation is a deterministic `(db, params)` function appended to the peer's own JSONL log. No one else writes to your log.
  - title: Rebase-style sync
    details: Master is upstream. Peers rebase local actions onto master on sync, with three convergence gates absorbing everything that commutes silently.
  - title: No network layer
    details: sql-git drops a snapshot + per-peer logs into a folder. Replicate by Syncthing, Dropbox, rsync, OPFS + BroadcastChannel — anything that preserves atomic file writes.
  - title: Conflict resolution with escape hatches
    details: When rebase genuinely breaks, your resolver sees the peer's action, master's suffix, and gets a `submit` hook to queue mitigations before retrying.
  - title: Browser-ready
    details: An OPFS adapter ships in the box. Multiple tabs at the same origin converge via BroadcastChannel without any extra plumbing.
  - title: Tiny surface
    details: ~1 kLOC TypeScript. Read the source.
---

## At a glance

```ts
import "sql-git/fs-node";
import { Store } from "sql-git";

const store = await Store.open({
  root: "/tmp/notes",
  peerId: "alice",
  masterId: "alice",
  actions: {
    init: (db) => db.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)"),
    append: (db, { id, body }) =>
      db.prepare("INSERT INTO notes VALUES (?, ?)").run(id, body),
  },
});

if (store.isMaster) await store.submit("init", {});
await store.submit("append", { id: "n-1", body: "hello" });
await store.sync();

store.db.prepare("SELECT * FROM notes").all();
```

See the [Node quickstart](/guide/node) for a complete working example, or
jump straight to the [browser (OPFS) quickstart](/guide/browser-opfs) to
build the same app with cross-tab sync.
