# Multi-tab + cross-tab sync

OPFS is per-origin, and `BroadcastChannel` lets tabs gossip within that
origin. Combined, they give you a cluster of "peers" that share a
single machine — same storage substrate, no network.

## The pattern

Every tab:

1. Calls `createOpfsFs()` + `init({ rootName: "my-app" })`.
2. Picks a `peerId` (from the URL, a cookie, a prompt — whatever fits).
3. Opens `Store.open({ root: '/' + peerId, peerId, masterId, actions })`.
4. Subscribes to `opfs.fs.watch("/")` to auto-sync on remote writes.

The trick is that the OPFS adapter's `BroadcastChannel` topic is keyed
by the `rootName` you passed to `init`. All tabs at the same origin,
same rootName, see each other's writes.

## Wiring auto-sync

```ts
const dispose = opfs.fs.watch!(`/${peerId}`, (ev, origin) => {
  // We don't care about our own writes — they fired the action that
  // caused them in the first place. Watching them would loop.
  if (origin !== "remote") return;

  // Skip our own log — `store.submit` writes it and the watcher fires
  // locally (origin "local" already filtered), but remote tabs may
  // still see writes to their own peer dir from file-sync UIs etc.
  const path = "path" in ev ? ev.path : ev.to;
  if (path.endsWith(`peers/${peerId}.jsonl`)) return;
  if (isMaster && path.endsWith("/snapshot.db")) return;

  scheduleSync();
});
```

`scheduleSync` should debounce so a burst of writes produces one sync,
not one-per-write:

```ts
let timer: number | null = null;
function scheduleSync() {
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(() => store.sync(), 250);
}
```

## What about file-sync between tabs?

Two tabs as different peers don't share their per-peer dirs without
help — each peer's tab writes only to `/<peerId>/`. To propagate
changes from `/alice/` to `/bob/` you need a "file-sync" step: copy the
relevant files across peer dirs.

[`demo-opfs2/`](https://github.com/WjcmeAFJb/sql-git/tree/master/demo-opfs2)
ships a UI for this — a "File-sync" menu that lists every peer's dir and
shows a bidirectional newest-wins diff between any two. The relevant
module is
[`src/lib/peer-dirs.ts`](https://github.com/WjcmeAFJb/sql-git/blob/master/demo-opfs2/src/lib/peer-dirs.ts).

The core logic is small enough to inline:

```ts
// Pseudo-code — see the demo for the version that handles ownership
// rules (never overwrite the master's snapshot.db with a cache).
async function sync(fromPeer: string, toPeer: string) {
  for (const rel of ["snapshot.db", `peers/${fromPeer}.jsonl`]) {
    const src = `/${fromPeer}/${rel}`;
    const dst = `/${toPeer}/${rel}`;
    if (!(await opfs.fs.exists(src))) continue;
    const bytes = await opfs.fs.readFile(src);
    await opfs.fs.mkdirp(opfs.path.dirname(dst));
    await opfs.fs.writeFile(dst, bytes);
  }
}
```

Order matters: always copy `snapshot.db` before the master log. If the
log arrives first, the peer may see a snapshot marker pointing past the
current `snapshot.db` head and throw `FileSyncLagError`.

## Production pattern: OPFS + Syncthing

A common setup:

- Web app uses OPFS + BroadcastChannel for cross-tab on one device.
- A thin Node companion mounts the same data via the Node FS adapter
  and a Syncthing-watched folder.
- Syncthing handles multi-device replication.

The browser app never talks to Syncthing directly — the Node companion
bridges the OPFS ↔ disk boundary. That gives you browser-native UX
and cross-device replication with no servers.

## Next

- [Peer-to-peer via Syncthing](/guide/syncthing)
- [Concepts — File-sync model](/concepts/file-sync)
