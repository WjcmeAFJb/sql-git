import type { FsAdapter, PathAdapter } from "../../../src/fs";

/**
 * Helpers that work across all peer directories inside the demo's OPFS root.
 * The OPFS adapter is scoped to `demo-opfs2`; each peer owns a sub-dir of
 * that root (`/alice/`, `/bob/`, …) containing `snapshot.db` and
 * `peers/*.jsonl`. These helpers don't bind to a single peer — they reach
 * across the whole root, so the file-sync menu can compare arbitrary dirs.
 */

export type FileEntry = {
  /** Path relative to the OPFS-adapter root (e.g. `/alice/snapshot.db`). */
  abs: string;
  /** Path relative to the peer dir (e.g. `snapshot.db` or `peers/alice.jsonl`). */
  rel: string;
  size: number;
  /** Last-modified epoch ms. OPFS `File` objects expose it via `.lastModified`. */
  mtimeMs: number;
};

/** The set of files we treat as sync payloads per peer. Matches the TUI syncer. */
const SYNCABLE_DIRS = ["", "peers"] as const;

/**
 * Scan a peer's subdirectory and return every file under it. Walks the tree;
 * sql-git only writes one layer deep (`snapshot.db`, `peers/<id>.jsonl`, and
 * optionally `debug/*.jsonl`), so the walk is shallow in practice.
 */
export async function listPeerFiles(
  fs: FsAdapter,
  path: PathAdapter,
  peerDir: string,
): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  if (!(await fs.exists(peerDir))) return out;
  for (const sub of SYNCABLE_DIRS) {
    const dir = sub ? path.join(peerDir, sub) : peerDir;
    if (!(await fs.exists(dir))) continue;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      // If it's a directory we skip — at one level deep we only expect files.
      try {
        await fs.readdir(abs);
        continue; // a directory
      } catch {
        /* it's a file */
      }
      try {
        const bytes = await fs.readFile(abs);
        const rel = sub ? `${sub}/${name}` : name;
        out.push({
          abs,
          rel,
          size: bytes.byteLength,
          // OPFS doesn't give us an mtime through our adapter surface, so fall
          // back to reading the raw handle. The adapter ignores this on read,
          // so we peek at the raw OPFS directory from outside.
          mtimeMs: await readMtime(abs),
        });
      } catch {
        continue;
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/** Discover every peer subdirectory inside a root (immediate children that
 *  contain either `snapshot.db` or a `peers/` subfolder). */
export async function listPeerDirs(
  fs: FsAdapter,
  path: PathAdapter,
  root: string,
): Promise<string[]> {
  if (!(await fs.exists(root))) return [];
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      await fs.readdir(dir);
    } catch {
      continue; // not a dir
    }
    // Consider a subdir a "peer dir" if it has snapshot.db or peers/.
    const hasSnap = await fs.exists(path.join(dir, "snapshot.db"));
    const hasPeers = await fs.exists(path.join(dir, "peers"));
    if (hasSnap || hasPeers) hits.push(name);
  }
  hits.sort();
  return hits;
}

/**
 * Peek at the underlying OPFS `File` object for its mtime. Falls back to
 * `Date.now()` if the navigator API isn't reachable (shouldn't happen in a
 * browser where the OPFS adapter is already initialised). We purposefully go
 * around the adapter here because `FsAdapter` has no mtime primitive — this
 * is demo-only tooling for the sync menu, not core logic.
 */
async function readMtime(absPath: string): Promise<number> {
  try {
    const root = await navigator.storage.getDirectory();
    const demoRoot = await root.getDirectoryHandle("demo-opfs2", { create: false });
    const segs = absPath.split("/").filter(Boolean);
    let dir = demoRoot;
    for (let i = 0; i < segs.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segs[i], { create: false });
    }
    const leaf = segs[segs.length - 1];
    const fh = await dir.getFileHandle(leaf, { create: false });
    const file = await fh.getFile();
    return file.lastModified;
  } catch {
    return Date.now();
  }
}

export type SyncPlan = {
  /** Files that would move from A → B (newer or missing on B). */
  aToB: Array<{ rel: string; reason: "new" | "newer"; size: number }>;
  /** Files that would move from B → A. */
  bToA: Array<{ rel: string; reason: "new" | "newer"; size: number }>;
  /** Files identical on both sides — not transferred. */
  same: string[];
  /** Files newest-wins would have transferred but ownership rules vetoed
   *  (e.g. a stale peer copy of `snapshot.db` that would otherwise
   *  overwrite the master's authoritative version). Surfaced so the UI
   *  can show the user *why* a file isn't being synced. */
  skipped: Array<{ rel: string; direction: "aToB" | "bToA"; reason: string }>;
};

/**
 * Ownership rules for sql-git's cluster files:
 *   - `snapshot.db`           → master
 *   - `peers/<peerId>.jsonl`  → peerId
 *
 * Returns the owner's peer id, or null for files we don't recognize.
 */
function fileOwner(rel: string, masterId: string): string | null {
  if (rel === "snapshot.db") return masterId;
  const m = /^peers\/(.+)\.jsonl$/.exec(rel);
  if (m) return m[1]!;
  return null;
}

/**
 * Compute a transfer plan between two peer dirs.
 *
 * Newest-wins on its own isn't safe because sql-git has single-writer
 * invariants: only master writes `snapshot.db`, only peer X writes
 * `peers/X.jsonl`. If a peer's stale copy gets an mtime bump (e.g., from
 * being written by a previous sync), naive newest-wins would overwrite
 * the owner's authoritative file with a cache. That's what causes the
 * `FileSyncLagError` cycle the user hit.
 *
 * Rule we add: never write a file whose destination is the owner. The
 * source may be the owner or another cache — both are safe since the
 * content should match.
 */
export function diffPeers(
  a: FileEntry[],
  b: FileEntry[],
  peerA: string,
  peerB: string,
  masterId: string,
): SyncPlan {
  const byRel = new Map<string, { a?: FileEntry; b?: FileEntry }>();
  for (const f of a) byRel.set(f.rel, { a: f });
  for (const f of b) {
    const slot = byRel.get(f.rel) ?? {};
    slot.b = f;
    byRel.set(f.rel, slot);
  }
  const aToB: SyncPlan["aToB"] = [];
  const bToA: SyncPlan["bToA"] = [];
  const same: string[] = [];
  const skipped: SyncPlan["skipped"] = [];

  const decide = (
    rel: string,
    fa: FileEntry | undefined,
    fb: FileEntry | undefined,
  ): { dir: "aToB" | "bToA" | "same"; size?: number; reason?: "new" | "newer" } => {
    if (fa && !fb) return { dir: "aToB", size: fa.size, reason: "new" };
    if (fb && !fa) return { dir: "bToA", size: fb.size, reason: "new" };
    if (fa && fb) {
      if (fa.size === fb.size && sameMtime(fa.mtimeMs, fb.mtimeMs)) return { dir: "same" };
      if (fa.mtimeMs > fb.mtimeMs) return { dir: "aToB", size: fa.size, reason: "newer" };
      if (fb.mtimeMs > fa.mtimeMs) return { dir: "bToA", size: fb.size, reason: "newer" };
    }
    return { dir: "same" };
  };

  for (const [rel, { a: fa, b: fb }] of byRel) {
    const choice = decide(rel, fa, fb);
    if (choice.dir === "same") {
      same.push(rel);
      continue;
    }
    const owner = fileOwner(rel, masterId);
    const dest = choice.dir === "aToB" ? peerB : peerA;
    if (owner && dest === owner) {
      // The destination is the authoritative writer of this file. Never
      // overwrite — even if the source's mtime is newer (it's a stale
      // cache). This preserves sql-git's single-writer invariant.
      skipped.push({
        rel,
        direction: choice.dir,
        reason: `${dest} owns ${rel}; cache copies never propagate back`,
      });
      continue;
    }
    (choice.dir === "aToB" ? aToB : bToA).push({
      rel,
      reason: choice.reason!,
      size: choice.size!,
    });
  }

  // Order files so `snapshot.db` lands at the destination before any
  // `peers/*.jsonl` that references it. Without this, a peer's watcher
  // can fire on the newly-arrived master log whose trailing snapshot
  // marker points at a snapshot that hasn't landed yet — exactly the
  // `FileSyncLagError` race.
  aToB.sort(orderForTransfer);
  bToA.sort(orderForTransfer);
  same.sort();
  skipped.sort((a, b) => a.rel.localeCompare(b.rel));
  return { aToB, bToA, same, skipped };
}

function orderForTransfer(a: { rel: string }, b: { rel: string }): number {
  // snapshot.db first (it's the anchor every log entry depends on),
  // then peer logs, alphabetical inside each bucket.
  const rank = (rel: string): number => (rel === "snapshot.db" ? 0 : 1);
  const d = rank(a.rel) - rank(b.rel);
  if (d !== 0) return d;
  return a.rel.localeCompare(b.rel);
}

function sameMtime(aMs: number, bMs: number): boolean {
  return Math.abs(aMs - bMs) < 2;
}

/** Execute a sync plan: copy each file from source peer dir to target peer dir.
 *  The plan is already ordered so snapshot.db lands before peer logs. */
export async function applySyncPlan(
  fs: FsAdapter,
  path: PathAdapter,
  peerA: string,
  peerB: string,
  plan: SyncPlan,
): Promise<void> {
  for (const f of plan.aToB) {
    const bytes = await fs.readFile(path.join(peerA, f.rel));
    await fs.mkdirp(path.dirname(path.join(peerB, f.rel)));
    await fs.writeFile(path.join(peerB, f.rel), bytes);
  }
  for (const f of plan.bToA) {
    const bytes = await fs.readFile(path.join(peerB, f.rel));
    await fs.mkdirp(path.dirname(path.join(peerA, f.rel)));
    await fs.writeFile(path.join(peerA, f.rel), bytes);
  }
}
