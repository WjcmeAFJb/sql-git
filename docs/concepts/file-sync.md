# File-sync model

sql-git never opens a socket. Replication is whatever transport drops
the right bytes at the right path.

## The on-disk layout

For a cluster rooted at `<root>`:

```
<root>/
  snapshot.db              (master-only)  JSON-serialized SQLite state
  peers/
    <masterId>.jsonl       (master-only)  canonical ordering
    <peerId>.jsonl         (peer X only)  pending actions + master_acks
    ...
  debug/
    <masterId>.squashed.jsonl  (master-only, optional)  archive of squashed entries
```

## The single-writer invariant

Every file in that tree has **one writer, known at compile time**:

| Path                        | Writer     |
| --------------------------- | ---------- |
| `snapshot.db`               | master     |
| `peers/<masterId>.jsonl`    | master     |
| `peers/<peerId>.jsonl`      | peer `X`   |
| `debug/...`                 | master     |

This is the rule that lets any atomic file syncer be a correct sync
transport — there are never two concurrent writers contending for the
same file.

## What transports must guarantee

1. **Atomic file writes.** A reader on another host must see either the
   pre-write bytes or the post-write bytes — never a partial. The Node
   and OPFS adapters both implement this (tmp-then-rename / OPFS
   createWritable → close).
2. **Eventual delivery** of all files in any order. sql-git handles
   partial ordering gracefully; `FileSyncLagError` is thrown when the
   master log's snapshot marker references a `snapshot.db` that hasn't
   arrived yet.
3. **No extra writes** — don't mint fake `peers/X.jsonl` entries as the
   syncer (Syncthing doesn't; Dropbox doesn't; conflict files from any
   of these are named differently and don't match the `peers/<id>.jsonl`
   pattern).

## What transports are fine

- **Syncthing / Dropbox / iCloud / Google Drive** — trivial: point two
  machines at the same shared folder.
- **`rsync` from a cron job** — also fine; it's atomic via `--delete
  --delay-updates` or tmp-then-rename.
- **`git push / git pull`** — the root is text-heavy JSONL + one JSON
  `snapshot.db`. `git commit -A && git pull --rebase` is a legitimate
  replication transport.
- **OPFS + BroadcastChannel** — same process group. Cross-tab sync
  comes free.
- **A network FS** (NFS, SMB) — if the client supports atomic renames
  (most do).
- **Manual `scp`** — fine for batch demos.

## What to watch out for

### Order of delivery during squash

Master squashes periodically — it writes a new `snapshot.db` and
trims `peers/<masterId>.jsonl`. The trimmed log starts with a
`snapshot` marker referencing the new snapshot head.

**If the log arrives before the snapshot**, a peer opening sees:

```json
{"kind":"snapshot","masterSeq":42}  ← log says head = 42
```

but `snapshot.db` still holds head = 30. The peer throws
`FileSyncLagError` and waits for the syncer to settle. Retrying in a
few seconds is almost always enough.

Your own file-sync UI should write **`snapshot.db` first, then
`peers/<masterId>.jsonl`** — `demo-opfs2`'s `applySyncPlan` does
exactly this.

### Conflict files from syncers

Syncthing names a Syncthing-detected conflict
`peers/alice.jsonl.sync-conflict-20250101-120000-<deviceid>.jsonl`,
which doesn't match sql-git's `peers/<name>.jsonl` pattern. Safe to
ignore; delete when convenient. If you see these consistently you
probably have two peers with the same `peerId` — fix the configuration.

### Stale caches overwriting authoritative files

In a bidirectional sync between two peer dirs that aren't the owner's,
naive newest-wins can clobber the owner's file. This isn't a concern
for Syncthing / Dropbox / `rsync` (they know which device "owns" a
change). It *is* a concern for hand-rolled UIs — see
[`demo-opfs2/src/lib/peer-dirs.ts`](https://github.com/WjcmeAFJb/sql-git/blob/master/demo-opfs2/src/lib/peer-dirs.ts)
for the ownership-rule logic that skips writes to the owner.

## The FS adapter

sql-git's I/O is factored behind `FsAdapter`:

```ts
interface FsAdapter {
  readFile(p): Promise<Uint8Array>;
  readTextFile(p): Promise<string>;
  writeFile(p, data): Promise<void>;   // atomic
  appendFile(p, data): Promise<void>;  // atomic; serialised per-path
  exists(p): Promise<boolean>;
  mkdirp(p): Promise<void>;
  rename(src, dst): Promise<void>;     // atomic
  readdir(p): Promise<string[]>;
  remove?(p): Promise<void>;
  watch?(p, cb): () => void;
}
```

Ship-in-the-box adapters:

- **`sql-git/fs-node`** — Node.js; wraps `node:fs/promises`.
- **`sql-git/fs-opfs`** — Browser; OPFS + BroadcastChannel; per-path
  write mutex.

Writing your own (e.g., memfs for tests, a WebDAV adapter for a
server sync target) is ~200 lines. Look at `src/fs-opfs.ts` for the
reference.

## Next

- [API — FS adapter](/api/fs-adapter)
- [API — Store](/api/store)
