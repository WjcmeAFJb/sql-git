import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { peerLogPath, snapshotPath } from "../src/paths.ts";
import { makeRoot } from "./helpers.ts";

/**
 * Each peer gets its own `<root>` directory — simulating a distinct host.
 * Files only cross hosts via explicit {@link fileSync} calls, i.e. Syncthing.
 * Within a host, the library observes filesystem writes immediately (as it
 * would on any local disk).
 */
export type Cluster = {
  masterId: string;
  roots: Map<string, string>;
  root(peerId: string): string;
};

export function makeCluster(peerIds: string[], masterId: string): Cluster {
  if (!peerIds.includes(masterId)) {
    throw new Error(`master ${masterId} must be in peerIds`);
  }
  const roots = new Map<string, string>();
  for (const id of peerIds) {
    roots.set(id, makeRoot());
  }
  return {
    masterId,
    roots,
    root(peerId) {
      const r = roots.get(peerId);
      if (!r) throw new Error(`no root for ${peerId}`);
      return r;
    },
  };
}

function copyIfExists(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return true;
}

/**
 * Copy one owner's host-side files to one destination host. Each file has a
 * single writer, so there's no merge/conflict step — file sync is pure
 * propagation:
 *   - the owner's `peers/<ownerId>.jsonl` → dest (if it exists on src)
 *   - if the owner is master, its `snapshot.db` → dest as well
 */
export function fileSyncDirected(cluster: Cluster, fromPeerId: string, toPeerId: string): void {
  if (fromPeerId === toPeerId) return;
  const src = cluster.root(fromPeerId);
  const dst = cluster.root(toPeerId);
  copyIfExists(peerLogPath(src, fromPeerId), peerLogPath(dst, fromPeerId));
  if (fromPeerId === cluster.masterId) {
    copyIfExists(snapshotPath(src), snapshotPath(dst));
  }
}

/** Push one peer's host-side files to every other host (Syncthing finished settling for this owner). */
export function fileSyncPush(cluster: Cluster, fromPeerId: string): void {
  for (const id of cluster.roots.keys()) {
    if (id !== fromPeerId) fileSyncDirected(cluster, fromPeerId, id);
  }
}

/** Fully settle Syncthing: every owner's files reach every other host. */
export function fileSyncAll(cluster: Cluster): void {
  for (const ownerId of cluster.roots.keys()) {
    fileSyncPush(cluster, ownerId);
  }
}

/** Delete a file at one host to simulate Syncthing not having delivered it yet. */
export function deleteHostFile(cluster: Cluster, atPeerId: string, fileOwnerId: string): void {
  const root = cluster.root(atPeerId);
  try {
    rmSync(peerLogPath(root, fileOwnerId));
  } catch {
    /* already absent */
  }
  if (fileOwnerId === cluster.masterId) {
    try {
      rmSync(snapshotPath(root));
    } catch {
      /* already absent */
    }
  }
}
