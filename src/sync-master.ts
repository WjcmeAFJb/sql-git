import type { Database as Db } from "better-sqlite3";
import { appendEntry, readLog, rewriteLog } from "./log.ts";
import { peerLogPath, snapshotPath } from "./paths.ts";
import { loadSnapshotToMemory, saveDbToFile } from "./snapshot.ts";
import { getSnapshotHead, setSnapshotHead } from "./db.ts";
import { applyAction } from "./apply.ts";
import { listPeerIds } from "./peers.ts";
import { checkConflict, type ConflictResult } from "./conflict.ts";
import type { Store } from "./store.ts";
import type {
  MasterActionEntry,
  MasterLogEntry,
  PeerAckEntry,
  PeerLogEntry,
  SnapshotMarkerEntry,
  SyncReport,
} from "./types.ts";

function masterSuffixAfter(
  store: Store,
  baseSeq: number,
  excludePeer?: string,
): MasterActionEntry[] {
  return store.masterLog
    .filter(
      (e): e is MasterActionEntry =>
        e.kind === "action" &&
        e.seq > baseSeq &&
        (excludePeer === undefined || e.source.peer !== excludePeer),
    )
    .sort((a, b) => a.seq - b.seq);
}

function buildStateAt(
  store: Store,
  targetSeq: number,
  alsoIncludeSamePeer?: string,
): Db {
  const db = loadSnapshotToMemory(snapshotPath(store.root));
  const head = getSnapshotHead(db);
  const entries = store.masterLog
    .filter(
      (e): e is MasterActionEntry =>
        e.kind === "action" &&
        e.seq > head &&
        (e.seq <= targetSeq ||
          (alsoIncludeSamePeer !== undefined && e.source.peer === alsoIncludeSamePeer)),
    )
    .sort((a, b) => a.seq - b.seq);
  for (const e of entries) applyAction(db, store.actions, e.name, e.params);
  return db;
}

function recordPeerAck(store: Store, peerId: string, masterSeq: number): void {
  const snapshotFloor = getSnapshotHead(store.db);
  let latest = snapshotFloor;
  for (const e of store.masterLog) {
    if (e.kind === "peer_ack" && e.peer === peerId && e.masterSeq > latest) {
      latest = e.masterSeq;
    }
  }
  if (masterSeq > latest) {
    const entry: PeerAckEntry = { kind: "peer_ack", peer: peerId, masterSeq };
    store.masterLog.push(entry);
    appendEntry(peerLogPath(store.root, store.masterId), entry);
  }
}

function latestAckFor(store: Store, peerId: string): number {
  let latest = getSnapshotHead(store.db);
  for (const e of store.masterLog) {
    if (e.kind === "peer_ack" && e.peer === peerId && e.masterSeq > latest) {
      latest = e.masterSeq;
    }
  }
  return latest;
}

function attemptSquash(store: Store): number | undefined {
  const peerIds = listPeerIds(store.root).filter((p) => p !== store.masterId);
  if (peerIds.length === 0) return undefined;

  const currentHead = getSnapshotHead(store.db);
  let minAck = Infinity;
  for (const p of peerIds) {
    const ack = latestAckFor(store, p);
    if (ack < minAck) minAck = ack;
  }
  if (!Number.isFinite(minAck) || minAck <= currentHead) return undefined;

  const newSnap = loadSnapshotToMemory(snapshotPath(store.root));
  const toApply = store.masterLog
    .filter(
      (e): e is MasterActionEntry => e.kind === "action" && e.seq > currentHead && e.seq <= minAck,
    )
    .sort((a, b) => a.seq - b.seq);
  for (const e of toApply) applyAction(newSnap, store.actions, e.name, e.params);
  setSnapshotHead(newSnap, minAck);
  saveDbToFile(newSnap, snapshotPath(store.root));
  newSnap.close();
  setSnapshotHead(store.db, minAck);

  const marker: SnapshotMarkerEntry = { kind: "snapshot", masterSeq: minAck };
  const trimmed: MasterLogEntry[] = [marker];
  for (const e of store.masterLog) {
    if (e.kind === "action" && e.seq > minAck) trimmed.push(e);
    else if (e.kind === "peer_ack" && e.masterSeq > minAck) trimmed.push(e);
    else if (e.kind === "snapshot") {
      // drop older snapshot markers
    }
  }
  store.masterLog.length = 0;
  store.masterLog.push(...trimmed);
  rewriteLog(peerLogPath(store.root, store.masterId), trimmed);

  return minAck;
}

export function runMasterSync(store: Store): SyncReport {
  const report: SyncReport = { applied: 0, skipped: 0, dropped: 0, forced: 0 };
  const peerIds = listPeerIds(store.root)
    .filter((p) => p !== store.masterId)
    .sort();

  for (const peerId of peerIds) {
    const peerLog: PeerLogEntry[] = readLog(peerLogPath(store.root, peerId));
    const incorporated = new Set<number>();
    for (const e of store.masterLog) {
      if (e.kind === "action" && e.source.peer === peerId) incorporated.add(e.source.seq);
    }

    let stopped = false;
    for (const entry of peerLog) {
      if (entry.kind === "master_ack") {
        recordPeerAck(store, peerId, entry.masterSeq);
        continue;
      }
      if (entry.kind !== "action") continue;
      if (incorporated.has(entry.seq)) continue;
      if (stopped) {
        report.skipped++;
        continue;
      }

      let conflict: ConflictResult;
      if (entry.force) {
        // Relaxed force boundary: accept iff every master action written
        // since `entry.baseMasterSeq` is authored by this same peer. Own
        // actions (e.g., actions this peer prepended during a `retry`
        // resolution) don't invalidate the force, but another peer's
        // interleaved action does.
        const interleavedFromOthers = store.masterLog.some(
          (e) => e.kind === "action" && e.seq > entry.baseMasterSeq && e.source.peer !== peerId,
        );
        conflict = interleavedFromOthers
          ? { ok: false, kind: "non_commutative" }
          : { ok: true };
      } else {
        // Relaxed commutativity: same-peer entries in the log since
        // `entry.baseMasterSeq` are treated as "intended prior context" for
        // this action (e.g., a create+rename pair from the same peer), so
        // they're excluded from the suffix used to check commutativity with
        // other-peer incorporations.
        const suffix = masterSuffixAfter(store, entry.baseMasterSeq, peerId);
        const baseDb =
          suffix.length === 0 ? store.db : buildStateAt(store, entry.baseMasterSeq, peerId);
        conflict = checkConflict({
          currentDb: store.db,
          baseDb,
          masterSuffix: suffix,
          actions: store.actions,
          action: entry,
        });
        if (baseDb !== store.db) baseDb.close();
      }

      if (!conflict.ok) {
        stopped = true;
        report.skipped++;
        continue;
      }

      const newSeq = store.nextMasterSeq;
      applyAction(store.db, store.actions, entry.name, entry.params);
      const masterEntry: MasterActionEntry = {
        kind: "action",
        seq: newSeq,
        name: entry.name,
        params: entry.params,
        source: { peer: peerId, seq: entry.seq },
        ...(entry.force ? { forced: true } : {}),
      };
      store.masterLog.push(masterEntry);
      appendEntry(peerLogPath(store.root, store.masterId), masterEntry);
      store.nextMasterSeq = newSeq + 1;
      store.currentMasterSeq = newSeq;
      report.applied++;
      if (entry.force) report.forced++;
    }
  }

  const squashed = attemptSquash(store);
  if (squashed !== undefined) report.squashedTo = squashed;

  return report;
}
