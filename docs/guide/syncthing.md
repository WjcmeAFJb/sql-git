# Peer-to-peer via Syncthing

[Syncthing](https://syncthing.net) is a continuous file syncer with
single-writer semantics and atomic swap-in on delivery — exactly the
contract sql-git needs.

## Setup

1. On each machine, install Syncthing and share one folder across your
   devices. Let's say it's `/home/you/Sync/notes/`.
2. On each machine, run your sql-git app pointed at that folder, giving
   each a unique `peerId`.

Laptop A:

```bash
node --experimental-strip-types app.ts alice /home/alice/Sync/notes
```

Laptop B:

```bash
node --experimental-strip-types app.ts bob /home/bob/Sync/notes
```

Syncthing replicates the folder in the background; your apps see a
shared `/Sync/notes/` tree.

## Why this works

Syncthing's replication model:

- **Atomic.** The remote receives the file in a `.syncthing.<file>.tmp`,
  then renames. Readers never see a partial.
- **Single-writer per file.** Syncthing resolves concurrent writes by
  winning one and marking the other as conflicted. sql-git avoids
  conflicts entirely by design: master writes `snapshot.db` + its own
  log; peer `X` writes only `peers/X.jsonl`. No two peers ever write
  the same file.
- **Preserves mtime**, which your diff-based file-sync UIs (like
  `demo-opfs2`'s File-sync menu) can use for newest-wins.

## Bootstrap order

1. Start the master first, let it run `init` + bootstrap the schema.
2. Wait for Syncthing to replicate `peers/<masterId>.jsonl` to every
   peer.
3. Start peers.

Each peer's first `store.sync()` rebuilds the local in-memory db from
the master log + snapshot; submissions are batched until the next sync.

## Handling Syncthing conflicts

In practice you'll see Syncthing conflict files (e.g.
`peers/alice.jsonl.sync-conflict-20250101-120000-<deviceid>.jsonl`)
only if you accidentally run two peers with the same `peerId`. Don't
do that. If you need to, delete the conflicting file and let the real
writer regenerate its log on next submit.

## Alternatives

Any single-writer-per-file syncer works:

- Dropbox, iCloud Drive, Google Drive — all atomic-on-delivery.
- `rsync` from a cron job — fine for batch use cases.
- `git push/pull` — the name is not a coincidence. sql-git's file
  format is text-heavy (JSONL) and the only binary is
  `snapshot.db` (JSON-serialized). Committing the whole root works.

## Next

- [Concepts — File-sync model](/concepts/file-sync)
- [Concepts — Sync & rebase](/concepts/sync-and-rebase)
