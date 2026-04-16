import type { Database as Db } from "better-sqlite3";
import { readLog, rewriteLog } from "./log.ts";
import { peerLogPath, snapshotPath } from "./paths.ts";
import { loadSnapshotToMemory } from "./snapshot.ts";
import { getSnapshotHead } from "./db.ts";
import { applyAction } from "./apply.ts";
import { checkConflict, type ConflictResult } from "./conflict.ts";
import type { Store } from "./store.ts";
import type {
  MasterActionEntry,
  MasterLogEntry,
  PeerActionEntry,
  PeerLogEntry,
  SyncOptions,
  SyncReport,
} from "./types.ts";

function buildMasterState(
  masterLog: MasterLogEntry[],
  snapshotFile: string,
  targetSeq: number,
  actions: Store["actions"],
): { db: Db; masterHead: number; snapshotHead: number } {
  const db = loadSnapshotToMemory(snapshotFile);
  const snapshotHead = getSnapshotHead(db);
  const masterActions = masterLog
    .filter((e): e is MasterActionEntry => e.kind === "action")
    .sort((a, b) => a.seq - b.seq);
  let masterHead = snapshotHead;
  for (const e of masterActions) {
    if (e.seq > snapshotHead && e.seq <= targetSeq) {
      applyAction(db, actions, e.name, e.params);
      if (e.seq > masterHead) masterHead = e.seq;
    }
  }
  return { db, masterHead, snapshotHead };
}

export async function runPeerSync(store: Store, opts: SyncOptions): Promise<SyncReport> {
  const report: SyncReport = { applied: 0, skipped: 0, dropped: 0, forced: 0 };
  const resolver = opts.onConflict;

  const masterLog: MasterLogEntry[] = readLog(peerLogPath(store.root, store.masterId));

  let newMasterHead = 0;
  for (const e of masterLog) {
    if (e.kind === "action" && e.seq > newMasterHead) newMasterHead = e.seq;
  }
  const snapHead = (() => {
    const s = loadSnapshotToMemory(snapshotPath(store.root));
    const h = getSnapshotHead(s);
    s.close();
    return h;
  })();
  if (snapHead > newMasterHead) newMasterHead = snapHead;

  const incorporated = new Set<number>();
  for (const e of masterLog) {
    if (e.kind === "action" && e.source.peer === store.peerId) {
      incorporated.add(e.source.seq);
    }
  }

  const rebased = buildMasterState(masterLog, snapshotPath(store.root), newMasterHead, store.actions);
  const rebasedDb = rebased.db;

  const masterActions = masterLog
    .filter((e): e is MasterActionEntry => e.kind === "action")
    .sort((a, b) => a.seq - b.seq);

  const ownActions = store.peerLog
    .filter((e): e is PeerActionEntry => e.kind === "action")
    .sort((a, b) => a.seq - b.seq);

  const kept: PeerActionEntry[] = [];

  for (const action of ownActions) {
    if (incorporated.has(action.seq)) continue;

    const suffix = masterActions.filter((e) => e.seq > action.baseMasterSeq);

    let conflict: ConflictResult;
    let baseDbForResolver: Db | undefined;

    if (action.force) {
      if (newMasterHead === action.baseMasterSeq) {
        conflict = { ok: true };
      } else {
        conflict = { ok: false, kind: "non_commutative" };
      }
    } else {
      const baseDb =
        suffix.length === 0
          ? rebasedDb
          : buildMasterState(masterLog, snapshotPath(store.root), action.baseMasterSeq, store.actions).db;
      conflict = checkConflict({
        currentDb: rebasedDb,
        baseDb,
        masterSuffix: suffix,
        actions: store.actions,
        action,
      });
      baseDbForResolver = baseDb;
    }

    if (!conflict.ok) {
      if (!resolver) {
        if (baseDbForResolver && baseDbForResolver !== rebasedDb) baseDbForResolver.close();
        rebasedDb.close();
        throw new Error(
          `Conflict on action seq=${action.seq} (${action.name}) but no onConflict resolver was provided`,
        );
      }
      const resolution = await resolver({
        action,
        kind: conflict.kind,
        error: conflict.kind === "error" ? conflict.error : undefined,
        masterSuffix: suffix,
        baseDb: baseDbForResolver ?? rebasedDb,
        rebasedDb,
      });
      if (baseDbForResolver && baseDbForResolver !== rebasedDb) baseDbForResolver.close();

      if (resolution === "drop") {
        report.dropped++;
        continue;
      }
      if (resolution === "force") {
        if (conflict.kind === "error") {
          rebasedDb.close();
          throw new Error(
            `Cannot force an action that errors on current state (seq=${action.seq}, ${action.name}); resolver must drop it.`,
          );
        }
        try {
          applyAction(rebasedDb, store.actions, action.name, action.params);
        } catch (err) {
          rebasedDb.close();
          throw new Error(
            `Forced action unexpectedly threw when applied on current state (seq=${action.seq}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        kept.push({
          kind: "action",
          seq: action.seq,
          name: action.name,
          params: action.params,
          baseMasterSeq: newMasterHead,
          force: true,
        });
        report.forced++;
        continue;
      }
      if (baseDbForResolver && baseDbForResolver !== rebasedDb) baseDbForResolver.close();
      rebasedDb.close();
      throw new Error(`Invalid conflict resolution: ${String(resolution)}`);
    }

    if (baseDbForResolver && baseDbForResolver !== rebasedDb) baseDbForResolver.close();

    applyAction(rebasedDb, store.actions, action.name, action.params);
    kept.push({
      kind: "action",
      seq: action.seq,
      name: action.name,
      params: action.params,
      baseMasterSeq: newMasterHead,
      ...(action.force ? { force: true } : {}),
    });
    report.applied++;
  }

  const newLog: PeerLogEntry[] = [...kept, { kind: "master_ack", masterSeq: newMasterHead }];
  store.peerLog = newLog;
  rewriteLog(peerLogPath(store.root, store.peerId), newLog);

  const old = store.db;
  store.db = rebasedDb;
  store.currentMasterSeq = newMasterHead;
  // Old db is retained for a short window: closing it here would crash user code
  // that cached `store.db` before sync(). Tests close via Store.close(); real users
  // should re-read `store.db` after every sync.
  try {
    old.close();
  } catch {
    /* already closed */
  }

  return report;
}
