# Browser quickstart (OPFS)

sql-git runs unchanged in the browser. Storage lives in
[OPFS](https://developer.mozilla.org/docs/Web/API/File_System_Access_API/Origin_private_file_system);
cross-tab sync happens through a
[BroadcastChannel](https://developer.mozilla.org/docs/Web/API/BroadcastChannel).

## Install

In a Vite project:

```bash
pnpm add 'https://github.com/WjcmeAFJb/sql-git/releases/download/v0.1.0/sql-git-0.1.0.tgz' \
        'https://github.com/WjcmeAFJb/sql-read-tracking/releases/download/v0.2.0/sqlite3-read-tracking-0.2.0.tgz'
```

## Bootstrap the SQLite WASM

The read-tracking SQLite build is emscripten-produced. In a bundler,
hand it a URL to the `.wasm`:

```ts
// src/sqlite-init.ts
import { setSqliteInitConfig } from "sql-git";
import wasmUrl from "sqlite3-read-tracking/wasm?url";

setSqliteInitConfig({ locateFile: () => wasmUrl });
```

In Vite, `?url` imports are resolved to a hashed static asset URL at
build time — no config needed. Other bundlers have equivalents
(`new URL('./path/to.wasm', import.meta.url)`, webpack's asset module
type).

## Mount OPFS as the FS adapter

sql-git's FS layer is pluggable. The OPFS adapter lives in
`sql-git/fs-opfs`:

```ts
// src/opfs.ts
import { createOpfsFs, type OpfsFs } from "sql-git/fs-opfs";

const opfs = createOpfsFs();
await opfs.init({ rootName: "my-app" }); // /my-app/ in this origin's OPFS
opfs.install();                           // makes it the global sql-git adapter

export { opfs };
```

Every `Store.open` after this point reads and writes under `/my-app/` in
the browser's OPFS — other tabs at the same origin share it.

## Open a Store

```ts
// src/store.ts
import { Store } from "sql-git";
import { actions } from "./actions";

export async function openStore(peerId: string) {
  return Store.open({
    root: `/${peerId}`,   // a sub-path *inside* the mounted OPFS root
    peerId,
    masterId: "alice",
    actions,
  });
}
```

Each peer lives in its own OPFS directory — `/alice/`, `/bob/`, etc.
Multiple tabs as different peers can co-exist in the same origin.

## Cross-tab auto-sync

The OPFS adapter fans every mutation out via BroadcastChannel. A tab
subscribing to `/alice` sees every write to `/alice/...` from other
tabs with `origin: "remote"`:

```ts
import { opfs } from "./opfs";

const unsub = opfs.fs.watch!(`/${peerId}`, (ev, origin) => {
  if (origin !== "remote") return;                       // our own writes
  if ("path" in ev && ev.path.endsWith(`peers/${peerId}.jsonl`)) return; // own log
  if (isMaster && ev.path === `/${peerId}/snapshot.db`) return;

  // Debounce in real code.
  store.sync();
});
```

The [`demo-opfs2/`](https://github.com/WjcmeAFJb/sql-git/tree/master/demo-opfs2)
reference implementation has a complete `useWatcher` React hook that
wraps this pattern.

## A minimal React integration

```tsx
// src/App.tsx
import { useEffect, useState } from "react";
import { opfs } from "./opfs";
import { openStore } from "./store";
import type { Store } from "sql-git";

export function App() {
  const [store, setStore] = useState<Store | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await openStore("alice");
      if (cancelled) s.close();
      else setStore(s);
    })();
    return () => {
      cancelled = true;
      store?.close();
    };
  }, []);

  if (!store) return <p>opening…</p>;
  return <NotesView store={store} />;
}
```

The companion [`sql-reactive-orm`](https://github.com/WjcmeAFJb/sql-reactive-orm)
library plugs straight into `store.db` and gives you `findAll` +
`sqlQuery` with MobX-driven invalidation on every action. See the full
demo at
[`demo-opfs2/`](https://github.com/WjcmeAFJb/sql-git/tree/master/demo-opfs2).

## Gotchas

- **OPFS is origin-scoped.** Two tabs at the same URL share OPFS; two
  tabs at different ports don't.
- **The `init_bank`-style bootstrap submit must run atomically.** Concurrent
  submits on the same log file used to clobber each other via OPFS's
  read-modify-write pattern. sql-git's OPFS adapter now takes a per-path
  write lock — as long as you stay on a recent version you're safe.
- **Service workers complicate OPFS timing.** If you have a SW caching
  the tab, make sure it doesn't intercept the WASM loader fetch.

## Next

- [Multi-tab + cross-tab sync](/guide/cross-tab)
- [Peer-to-peer via Syncthing](/guide/syncthing)
- [Concepts — File-sync model](/concepts/file-sync)
