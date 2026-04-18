import type { Db } from "./db.ts";
import { readLog, rewriteLog } from "./log.ts";
import { peerLogPath, snapshotPath } from "./paths.ts";
import { loadSnapshotToMemory } from "./snapshot.ts";
import { cloneDb, compareDbs, getSnapshotHead } from "./db.ts";
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

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Trace each peer action on a fresh base clone, collect write-row keys,
 * greedy-partition by overlap into chains, and test each chain: when the
 * chain applied alone to `baseDb` leaves every row it touched identical
 * to the corresponding row in `rebasedDb`, those actions converge — their
 * net effect has already been realized by master, with or without mid-
 * sequence states that would otherwise error (e.g. edit_tx_amount on a
 * row master has already deleted).
 *
 * Returns indices into `unincorporated` whose enclosing chain converges.
 * An index not in the returned set falls through to per-action checks.
 */
function findConvergentChains(
  baseDb: Db,
  rebasedDb: Db,
  actions: Store["actions"],
  unincorporated: PeerActionEntry[],
): Set<number> {
  // Trace each action on a running simulation to get its write set.
  const sim = cloneDb(baseDb);
  const writesPerAction: Set<string>[] = [];
  let simOk = true;
  for (const action of unincorporated) {
    sim.beginTracking();
    try {
      applyAction(sim, actions, action.name, action.params);
    } catch {
      simOk = false;
    }
    const writes = sim.getWriteLog();
    sim.endTracking();
    const keys = new Set<string>();
    for (const w of writes) {
      if (w.op === "truncate") {
        keys.add(`${w.table}:*`);
      } else {
        keys.add(`${w.table}:${String(w.rowid)}`);
      }
    }
    writesPerAction.push(keys);
    if (!simOk) break;
  }
  sim.close();
  if (!simOk) return new Set();

  // Greedy chain boundaries: consecutive actions share at least one written row.
  type Chain = { start: number; end: number; writes: Set<string> };
  const chains: Chain[] = [];
  let cur: Chain | null = null;
  for (let i = 0; i < unincorporated.length; i++) {
    const w = writesPerAction[i];
    if (!cur) {
      cur = { start: i, end: i, writes: new Set(w) };
      continue;
    }
    let overlaps = false;
    for (const k of w) {
      if (cur.writes.has(k)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) {
      cur.end = i;
      for (const k of w) cur.writes.add(k);
    } else {
      chains.push(cur);
      cur = { start: i, end: i, writes: new Set(w) };
    }
  }
  if (cur) chains.push(cur);

  const absorbed = new Set<number>();
  for (const chain of chains) {
    const probe = cloneDb(baseDb);
    let applyOk = true;
    try {
      for (let i = chain.start; i <= chain.end; i++) {
        applyAction(probe, actions, unincorporated[i].name, unincorporated[i].params);
      }
    } catch {
      applyOk = false;
    }
    if (applyOk && rowsetMatches(probe, rebasedDb, chain.writes)) {
      for (let i = chain.start; i <= chain.end; i++) absorbed.add(i);
    }
    probe.close();
  }
  return absorbed;
}

/**
 * True iff every `(table, rowid)` in `rowKeys` holds the same row contents
 * in both databases (absent in both also counts as equal). Table-wildcard
 * keys (`table:*` from truncates) require the full table contents to match.
 */
function rowsetMatches(a: Db, b: Db, rowKeys: Set<string>): boolean {
  for (const key of rowKeys) {
    const sep = key.lastIndexOf(":");
    const table = key.slice(0, sep);
    const rowid = key.slice(sep + 1);
    const qt = quoteIdent(table);
    if (rowid === "*") {
      const rowsA = JSON.stringify(
        a.prepare(`SELECT * FROM ${qt} ORDER BY rowid`).all(),
      );
      const rowsB = JSON.stringify(
        b.prepare(`SELECT * FROM ${qt} ORDER BY rowid`).all(),
      );
      if (rowsA !== rowsB) return false;
      continue;
    }
    const aRow = a.prepare(`SELECT * FROM ${qt} WHERE rowid = ?`).get(rowid);
    const bRow = b.prepare(`SELECT * FROM ${qt} WHERE rowid = ?`).get(rowid);
    if (aRow === undefined && bRow === undefined) continue;
    if (aRow === undefined || bRow === undefined) return false;
    if (JSON.stringify(aRow) !== JSON.stringify(bRow)) return false;
  }
  return true;
}

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

  // Convergence pre-checks: skip the per-action loop for actions whose
  // intent has already been realized by master.
  //
  //   (1) Global: if applying EVERY unincorporated peer action on top of the
  //       appropriate base produces exactly the rebased master state, the
  //       peer's entire suffix is subsumed. Drop and acknowledge.
  //   (2) Chain: partition the peer's unincorporated actions by write-set
  //       overlap (consecutive actions whose writes intersect form one
  //       chain — e.g. an `edit_tx_amount` followed by a `delete_transaction`
  //       on the same row). For each chain, if applying it on a fresh base
  //       leaves the chain's touched rows identical to the rebased master
  //       state, that chain converges — drop those actions silently.
  //
  // What remains goes through the per-action loop, so genuine conflicts
  // still surface to the resolver one at a time.
  const unincorporated = ownActions.filter((a) => !incorporated.has(a.seq));
  const absorbedSeqs = new Set<number>();
  if (unincorporated.length > 0) {
    let firstBase = unincorporated[0].baseMasterSeq;
    for (const a of unincorporated) {
      if (a.baseMasterSeq < firstBase) firstBase = a.baseMasterSeq;
    }
    const probeBuild = buildMasterState(
      masterLog,
      snapshotPath(store.root),
      firstBase,
      store.actions,
      store.peerId,
    );
    let probeOk = true;
    try {
      for (const a of unincorporated) {
        applyAction(probeBuild.db, store.actions, a.name, a.params);
      }
    } catch {
      probeOk = false;
    }
    if (probeOk && compareDbs(probeBuild.db, rebasedDb)) {
      probeBuild.db.close();
      const newLog: PeerLogEntry[] = [{ kind: "master_ack", masterSeq: newMasterHead }];
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
      report.convergent = unincorporated.length;
      return report;
    }
    probeBuild.db.close();

    // Chain-based: trace each action's writes, group by overlap, absorb
    // convergent chains. Remaining fall through to the per-action loop.
    const chainBaseBuild = buildMasterState(
      masterLog,
      snapshotPath(store.root),
      firstBase,
      store.actions,
      store.peerId,
    );
    const absorbedIdxs = findConvergentChains(
      chainBaseBuild.db,
      rebasedDb,
      store.actions,
      unincorporated,
    );
    chainBaseBuild.db.close();
    for (const idx of absorbedIdxs) absorbedSeqs.add(unincorporated[idx].seq);
    if (absorbedSeqs.size > 0) report.convergent = absorbedSeqs.size;
  }

  const kept: PeerActionEntry[] = [];

  for (const origAction of ownActions) {
    if (incorporated.has(origAction.seq)) continue;
    if (absorbedSeqs.has(origAction.seq)) continue;

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
          : { ok: true, reason: "disjoint" };
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
