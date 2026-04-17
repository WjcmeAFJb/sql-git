import type { Database as Db } from "better-sqlite3";
import { readLog, rewriteLog } from "./log.ts";
import { peerLogPath, snapshotPath } from "./paths.ts";
import { loadSnapshotToMemory } from "./snapshot.ts";
import { getSnapshotHead } from "./db.ts";
import { applyAction } from "./apply.ts";
import { checkConflict, type ConflictResult } from "./conflict.ts";
import { assertFilesConsistent } from "./file-sync.ts";
import type { Store } from "./store.ts";
import type {
  ConflictContext,
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
  alsoIncludeSamePeer?: string,
): { db: Db; masterHead: number; snapshotHead: number } {
  const db = loadSnapshotToMemory(snapshotFile);
  const snapshotHead = getSnapshotHead(db);
  const masterActions = masterLog
    .filter((e): e is MasterActionEntry => e.kind === "action")
    .sort((a, b) => a.seq - b.seq);
  let masterHead = snapshotHead;
  for (const e of masterActions) {
    const includeAboveTarget =
      alsoIncludeSamePeer !== undefined && e.source.peer === alsoIncludeSamePeer;
    if (e.seq > snapshotHead && (e.seq <= targetSeq || includeAboveTarget)) {
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
  assertFilesConsistent(masterLog, snapHead);
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

  // Process in log/file order, NOT seq order. A `retry` resolution writes the
  // prepended action (new high seq) before the retried original (its old
  // lower seq), so `sort by seq` would reorder them and apply the original
  // before its topup — triggering the very error the retry was meant to fix.
  const ownActions = store.peerLog.filter(
    (e): e is PeerActionEntry => e.kind === "action",
  );

  const kept: PeerActionEntry[] = [];

  for (const origAction of ownActions) {
    if (incorporated.has(origAction.seq)) continue;

    let action: PeerActionEntry = origAction;

    while (true) {
      // Relaxed suffix: same-peer entries (including this peer's own prior
      // actions already incorporated by master) don't count as interleavings —
      // peer's intent is that its actions apply in its own log order.
      const suffix = masterActions.filter(
        (e) => e.seq > action.baseMasterSeq && e.source.peer !== store.peerId,
      );
      let baseDb: Db;
      let baseIsRebased = false;
      if (suffix.length === 0) {
        baseDb = rebasedDb;
        baseIsRebased = true;
      } else {
        // baseDb needs to reflect state_at(base) PLUS this peer's own prior
        // incorporations, so the current action sees its intended context.
        baseDb = buildMasterState(
          masterLog,
          snapshotPath(store.root),
          action.baseMasterSeq,
          store.actions,
          store.peerId,
        ).db;
      }

      let conflict: ConflictResult;
      if (action.force) {
        // Relaxed force boundary — see matching logic in sync-master.ts.
        const interleavedFromOthers = masterActions.some(
          (e) => e.seq > action.baseMasterSeq && e.source.peer !== store.peerId,
        );
        conflict = interleavedFromOthers
          ? { ok: false, kind: "non_commutative" }
          : { ok: true };
      } else {
        conflict = checkConflict({
          currentDb: rebasedDb,
          baseDb,
          masterSuffix: suffix,
          actions: store.actions,
          action,
        });
      }

      if (conflict.ok) {
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
        if (!baseIsRebased) baseDb.close();
        break;
      }

      if (!resolver) {
        if (!baseIsRebased) baseDb.close();
        rebasedDb.close();
        throw new Error(
          `Conflict on action seq=${action.seq} (${action.name}) but no onConflict resolver was provided`,
        );
      }

      const prepended: PeerActionEntry[] = [];
      const ctx: ConflictContext = {
        action,
        kind: conflict.kind,
        error: conflict.kind === "error" ? conflict.error : undefined,
        masterSuffix: suffix,
        baseDb,
        rebasedDb,
        submit(name: string, params: unknown) {
          if (!store.actions[name]) throw new Error(`Unknown action: ${name}`);
          const newSeq = store.nextPeerSeq;
          store.nextPeerSeq = newSeq + 1;
          applyAction(rebasedDb, store.actions, name, params);
          prepended.push({
            kind: "action",
            seq: newSeq,
            name,
            params,
            baseMasterSeq: newMasterHead,
          });
        },
      };

      const resolution = await resolver(ctx);

      for (const p of prepended) {
        kept.push(p);
        report.applied++;
      }

      if (!baseIsRebased) baseDb.close();

      if (resolution === "drop") {
        report.dropped++;
        break;
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
        break;
      }
      if (resolution === "retry") {
        if (prepended.length === 0) {
          rebasedDb.close();
          throw new Error(
            `"retry" without any ctx.submit(...) calls would loop indefinitely (action seq=${action.seq}, ${action.name})`,
          );
        }
        // Mark as forced with fresh base: the peer is asserting "this action
        // applies on the current state plus my prepended actions". Master's
        // relaxed force check allows the own-peer prepended actions between
        // `baseMasterSeq` and master head without flagging them as
        // interleavings.
        action = { ...action, baseMasterSeq: newMasterHead, force: true };
        continue;
      }
      rebasedDb.close();
      throw new Error(`Invalid conflict resolution: ${String(resolution)}`);
    }
  }

  const newLog: PeerLogEntry[] = [...kept, { kind: "master_ack", masterSeq: newMasterHead }];
  store.peerLog = newLog;
  rewriteLog(peerLogPath(store.root, store.peerId), newLog);

  const old = store.db;
  store.db = rebasedDb;
  store.currentMasterSeq = newMasterHead;
  try {
    old.close();
  } catch {
    /* already closed */
  }

  return report;
}
