# FS adapter

sql-git's filesystem I/O is indirect — every Store routes through a
global adapter. You install one at boot; every subsequent `Store.open`
uses it.

## The interface

```ts
import type { FsAdapter, PathAdapter, FsEvent } from "sql-git";

export type FsEvent =
  | { type: "write"; path: string }
  | { type: "mkdir"; path: string }
  | { type: "rename"; from: string; to: string }
  | { type: "delete"; path: string };

export interface FsAdapter {
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  remove?(path: string): Promise<void>;
  watch?(
    path: string,
    cb: (e: FsEvent, origin: "local" | "remote") => void,
  ): () => void;
}

export interface PathAdapter {
  join(...parts: string[]): string;
  dirname(path: string): string;
}
```

**Must-haves for every adapter:**

- `writeFile` and `rename` are atomic (readers on other hosts see
  either the pre-write bytes or the post-write bytes).
- `mkdirp` is idempotent.
- `appendFile` should be serialised per-path under concurrent callers.
  sql-git's internal patterns (seeding, race-prone file-sync UIs) can
  yield mid-`await`, so non-atomic append-by-read-modify-write gets
  clobbered without a lock. See `src/fs-opfs.ts`'s `withLock` helper
  for the reference implementation.

**Optional:**

- `remove` — used by user-facing tools (file-sync UIs, test teardown).
  sql-git's core never deletes.
- `watch` — for auto-sync. If omitted, callers must trigger `sync()`
  explicitly.

## Installing

```ts
import { setFs, setPath } from "sql-git";

setFs(myAdapter);
setPath(myPathAdapter);
```

Subsequent `Store.open` calls use these.

## Ship-in-the-box adapters

### `sql-git/fs-node`

Self-registers on import:

```ts
import "sql-git/fs-node"; // installs nodeFsAdapter + nodePathAdapter
```

Uses `node:fs/promises` + `node:path`. Atomic writes via
tmp-then-rename (`<path>.tmp` → `<path>`).

### `sql-git/fs-opfs`

Must be installed manually; also provides a cross-tab watcher via
BroadcastChannel.

```ts
import { createOpfsFs } from "sql-git/fs-opfs";

const opfs = createOpfsFs();
await opfs.init({
  rootName: "my-app",                  // subdirectory of OPFS root
  channelName: "my-app-channel",       // optional — defaults to sql-git:opfs:<rootName>
});
opfs.install();                         // setFs + setPath
```

The adapter:

- Lives under the browser's OPFS origin-private filesystem.
- Routes every mutation through a BroadcastChannel so other tabs at the
  same origin (same `rootName`) see it as `origin: "remote"` in `watch`.
- Takes a per-path mutex on `writeFile` / `appendFile` to make
  concurrent writes safe.

## Writing a custom adapter

The easiest starting point is an in-memory adapter for tests:

```ts
function createMemFs(): FsAdapter {
  const files = new Map<string, Uint8Array>();
  const enc = new TextEncoder(), dec = new TextDecoder();
  return {
    async readFile(p) {
      const b = files.get(p); if (!b) throw new Error(`ENOENT: ${p}`);
      return b;
    },
    readTextFile: async (p) => dec.decode(await this.readFile(p)),
    writeFile: async (p, d) => { files.set(p, typeof d === "string" ? enc.encode(d) : d); },
    appendFile: async (p, d) => {
      const existing = files.get(p) ?? new Uint8Array();
      const add = enc.encode(d);
      const combined = new Uint8Array(existing.length + add.length);
      combined.set(existing); combined.set(add, existing.length);
      files.set(p, combined);
    },
    exists: async (p) => files.has(p),
    mkdirp: async () => {},
    rename: async (s, d) => {
      const v = files.get(s); if (v) { files.set(d, v); files.delete(s); }
    },
    readdir: async (p) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const out = new Set<string>();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        out.add(k.slice(prefix.length).split("/")[0]!);
      }
      return [...out];
    },
  };
}
```

`tests/setup.ts` uses something like this for all unit tests — you can
crib from there.

## See also

- [File-sync model](/concepts/file-sync)
- [Browser quickstart](/guide/browser-opfs)
