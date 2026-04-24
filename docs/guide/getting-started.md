# Getting started

sql-git is a small TypeScript library that lets several peers converge on
a shared SQLite database by exchanging small JSONL log files. You write
"actions" — deterministic `(db, params) → void` functions — and the
library handles replication, rebase, and conflict resolution.

## Install

sql-git isn't on npm yet. Install the release tarball straight from a
GitHub release:

```bash
pnpm add 'https://github.com/WjcmeAFJb/sql-git/releases/download/v0.4.0/sql-git-0.4.0.tgz'
```

Or pin to a tag in git:

```bash
pnpm add 'github:WjcmeAFJb/sql-git#v0.4.0'
```

sql-git is shipped as TypeScript source (the entry point is
`src/index.ts`). Any bundler or Node loader that handles `.ts` works —
Vite, esbuild, Bun, `node --experimental-strip-types` (Node ≥ 22.6), or
`tsx`.

You also need the read-tracking SQLite build:

```bash
pnpm add 'https://github.com/WjcmeAFJb/sql-read-tracking/releases/download/v0.2.1/sqlite3-read-tracking-0.2.1.tgz'
```

## Pick your environment

- [**Node**](/guide/node) — simplest way to try the library. Shared
  folder on disk, file syncer of your choice (Syncthing / Dropbox /
  manual `rsync`).
- [**Browser (OPFS)**](/guide/browser-opfs) — the storage layer is
  OPFS; cross-tab sync is automatic via BroadcastChannel.

## Vocabulary

A few terms show up everywhere in the docs:

| Term | Meaning |
| ---- | ------- |
| **Peer** | Any instance of your app running a `Store`. Has a unique `peerId`. |
| **Master** | The peer whose `peerId` equals `masterId`. Its log is canonical. |
| **Action** | A deterministic `(db, params)` function registered by name. The *only* write primitive. |
| **Log** | A JSONL file under `<root>/peers/<peerId>.jsonl` — each peer writes its own. |
| **Snapshot** | `<root>/snapshot.db` — the squashed state, written only by master. |
| **Sync** | `await store.sync()` — pulls in everyone else's changes; rebases your own on master. |
| **Conflict** | An action that can't be rebased onto the current master head. Calls your resolver. |

## The shape of an app

Nearly every app using sql-git boils down to the same skeleton:

1. Define an `ActionRegistry` — your write vocabulary.
2. Open a `Store` per peer, pointed at a shared `root`.
3. Call `store.submit(name, params)` to mutate.
4. Query `store.db` directly — it's a normal in-memory SQLite.
5. Call `store.sync()` periodically (or react to file-watcher events).

Everything else — conflict resolution, convergence, squashing — is
library detail.

## Next

- [Node quickstart](/guide/node)
- [Browser (OPFS) quickstart](/guide/browser-opfs)
- [Concepts — Actions](/concepts/actions)
