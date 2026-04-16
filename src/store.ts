import type { Database as Db } from "better-sqlite3";
import { appendEntry, ensureDir, ensureFile, readLog } from "./log.ts";
import { peerLogPath, peersDir, snapshotPath } from "./paths.ts";
import { loadSnapshotToMemory } from "./snapshot.ts";
import { getSnapshotHead } from "./db.ts";
import { applyAction } from "./apply.ts";
import { assertFilesConsistent } from "./file-sync.ts";
import { runMasterSync } from "./sync-master.ts";
import { runPeerSync } from "./sync-peer.ts";
import type {
  ActionRegistry,
  MasterActionEntry,
  MasterLogEntry,
  PeerActionEntry,
  PeerLogEntry,
  StoreOptions,
  SyncOptions,
  SyncReport,
} from "./types.ts";

/**
 * A peer in a sql-git cluster — backed by `<root>/snapshot.db` and per-peer
 * `<root>/peers/<peerId>.jsonl` logs. One peer in the cluster is designated
 * master (`peerId === masterId`); its log is the canonical ordering and only
 * the master writes `snapshot.db`.
 *
 * **File-sync model.** The library never watches or pushes files itself —
 * the `<root>` directory is expected to be replicated between hosts by an
 * external syncer (Syncthing, Dropbox, `rsync`, a shared volume, …). Each
 * peer only writes its own log; only the master writes `snapshot.db`; all
 * writes are atomic (tmp-then-rename) so readers on other hosts never see
 * partial files. Analogously to `git fetch` + `git rebase origin/master`:
 * file sync = fetch, `store.sync()` = rebase/integrate. If the file syncer
 * has delivered an updated trimmed master log before its matching snapshot,
 * {@link Store.open} or {@link Store.sync} throws `FileSyncLagError` — the
 * caller should retry after the syncer settles.
 *
 * Lifecycle: `Store.open(...)` → `submit(...)` / `sync(...)` → `close()`.
 */
export class Store {
  /**
   * The live, queryable in-memory SQLite database. Reflects snapshot + applied
   * master log (up to what this peer has seen) + this peer's pending actions.
   *
   * Warning: peer-side `sync()` replaces this reference; the previous db is
   * closed. Do not cache `store.db` across `sync()` calls — re-read it.
   */
  db: Db;

  /** Filesystem root containing `snapshot.db` and the `peers/` directory. */
  readonly root: string;

  /** This peer's stable id. Also the filename stem of its log under `peers/`. */
  readonly peerId: string;

  /** The master peer's id. If `peerId === masterId`, this store is the master. */
  readonly masterId: string;

  /** `true` iff this store is the master (convenience for `peerId === masterId`). */
  readonly isMaster: boolean;

  /** Registry of action functions keyed by name. Must match across peers. */
  readonly actions: ActionRegistry;

  /** @internal Master-only: canonical ordered log. Empty for non-master. */
  masterLog: MasterLogEntry[];

  /** @internal Non-master only: this peer's proposed-action log. Empty for master. */
  peerLog: PeerLogEntry[];

  /** @internal Next seq for master's own actions (master only). */
  nextMasterSeq: number;

  /** @internal Next seq for this peer's own actions (non-master only). */
  nextPeerSeq: number;

  /** @internal Highest master seq this peer has integrated into local db. */
  currentMasterSeq: number;

  private constructor(init: {
    db: Db;
    root: string;
    peerId: string;
    masterId: string;
    isMaster: boolean;
    actions: ActionRegistry;
    masterLog: MasterLogEntry[];
    peerLog: PeerLogEntry[];
    nextMasterSeq: number;
    nextPeerSeq: number;
    currentMasterSeq: number;
  }) {
    this.db = init.db;
    this.root = init.root;
    this.peerId = init.peerId;
    this.masterId = init.masterId;
    this.isMaster = init.isMaster;
    this.actions = init.actions;
    this.masterLog = init.masterLog;
    this.peerLog = init.peerLog;
    this.nextMasterSeq = init.nextMasterSeq;
    this.nextPeerSeq = init.nextPeerSeq;
    this.currentMasterSeq = init.currentMasterSeq;
  }

  /**
   * Open (or create) a peer at `opts.root`. The directory is created if it
   * doesn't exist; the peer's own log file is created empty if new.
   *
   * On open, the local db is rebuilt from `snapshot.db` plus the applicable
   * log entries:
   * - master: applies every action in its own log (post-snapshot).
   * - non-master with pending actions: applies master's log up to the peer's
   *   last-known master seq (from own log's baseMasterSeq / master_ack), then
   *   replays own pending actions.
   * - non-master with no pending actions (fresh or fully-incorporated): auto
   *   catches up to the current master head on disk.
   *
   * All actions referenced in the logs must be present in `opts.actions`.
   */
  static open(opts: StoreOptions): Store {
    ensureDir(peersDir(opts.root));
    const db = loadSnapshotToMemory(snapshotPath(opts.root));
    const isMaster = opts.peerId === opts.masterId;
    const ownLogPath = peerLogPath(opts.root, opts.peerId);
    ensureFile(ownLogPath);

    if (isMaster) {
      const masterLog: MasterLogEntry[] = readLog(ownLogPath);
      const snapshotHead = getSnapshotHead(db);
      let nextMasterSeq = snapshotHead + 1;
      let currentMasterSeq = snapshotHead;
      for (const e of masterLog) {
        if (e.kind === "action") {
          applyAction(db, opts.actions, e.name, e.params);
          if (e.seq + 1 > nextMasterSeq) nextMasterSeq = e.seq + 1;
          if (e.seq > currentMasterSeq) currentMasterSeq = e.seq;
        }
      }
      return new Store({
        db,
        root: opts.root,
        peerId: opts.peerId,
        masterId: opts.masterId,
        isMaster: true,
        actions: opts.actions,
        masterLog,
        peerLog: [],
        nextMasterSeq,
        nextPeerSeq: nextMasterSeq,
        currentMasterSeq,
      });
    }

    const peerLog: PeerLogEntry[] = readLog(ownLogPath);
    const masterLogDisk: MasterLogEntry[] = readLog(peerLogPath(opts.root, opts.masterId));
    const snapshotHead = getSnapshotHead(db);
    try {
      assertFilesConsistent(masterLogDisk, snapshotHead);
    } catch (err) {
      db.close();
      throw err;
    }
    const hasPendingActions = peerLog.some((e) => e.kind === "action");
    let lastSeen = snapshotHead;
    if (hasPendingActions) {
      for (const e of peerLog) {
        if (e.kind === "action" && e.baseMasterSeq > lastSeen) lastSeen = e.baseMasterSeq;
        else if (e.kind === "master_ack" && e.masterSeq > lastSeen) lastSeen = e.masterSeq;
      }
    } else {
      // No pending local actions — auto-catch-up to current master head.
      for (const e of masterLogDisk) {
        if (e.kind === "action" && e.seq > lastSeen) lastSeen = e.seq;
      }
    }
    for (const entry of masterLogDisk) {
      if (entry.kind === "action" && entry.seq > snapshotHead && entry.seq <= lastSeen) {
        applyAction(db, opts.actions, entry.name, entry.params);
      }
    }
    let nextPeerSeq = 1;
    for (const e of peerLog) {
      if (e.kind === "action") {
        applyAction(db, opts.actions, e.name, e.params);
        if (e.seq + 1 > nextPeerSeq) nextPeerSeq = e.seq + 1;
      }
    }
    return new Store({
      db,
      root: opts.root,
      peerId: opts.peerId,
      masterId: opts.masterId,
      isMaster: false,
      actions: opts.actions,
      masterLog: [],
      peerLog,
      nextMasterSeq: 0,
      nextPeerSeq,
      currentMasterSeq: lastSeen,
    });
  }

  /**
   * Apply a registered action locally and append it to this peer's log.
   *
   * If the action throws when applied to the current local db, `submit` throws
   * and nothing is written to the log. On success, the entry is tagged with
   * `baseMasterSeq = currentMasterSeq` (for non-master peers) so master-side
   * conflict detection has a reference point on the next sync.
   *
   * `params` must be JSON-serializable — it is persisted verbatim in the log
   * and replayed on every peer. Actions must be deterministic functions of
   * `(db, params)`; avoid reading clocks, random sources, or external state.
   *
   * @throws if `name` isn't in the action registry, or if the action throws.
   */
  submit(name: string, params: unknown): void {
    if (!this.actions[name]) throw new Error(`Unknown action: ${name}`);
    if (this.isMaster) {
      const seq = this.nextMasterSeq;
      applyAction(this.db, this.actions, name, params);
      const entry: MasterActionEntry = {
        kind: "action",
        seq,
        name,
        params,
        source: { peer: this.peerId, seq },
      };
      this.masterLog.push(entry);
      appendEntry(peerLogPath(this.root, this.peerId), entry);
      this.nextMasterSeq = seq + 1;
      this.currentMasterSeq = seq;
    } else {
      const seq = this.nextPeerSeq;
      applyAction(this.db, this.actions, name, params);
      const entry: PeerActionEntry = {
        kind: "action",
        seq,
        name,
        params,
        baseMasterSeq: this.currentMasterSeq,
      };
      this.peerLog.push(entry);
      appendEntry(peerLogPath(this.root, this.peerId), entry);
      this.nextPeerSeq = seq + 1;
    }
  }

  /**
   * Synchronize with the cluster. Behavior depends on role:
   *
   * **Master**: iterates peers in sorted id order. For each peer, walks that
   * peer's log and incorporates non-conflicting actions into the master log
   * (with a `source: {peer, seq}` back-reference). On the first conflicting
   * action for a peer, master **stops** processing that peer entirely — later
   * actions from the same peer stay pending until the peer rebases on a newer
   * master head. Forced actions are accepted iff master head equals the
   * action's `baseMasterSeq` (no advance since the force was recorded). After
   * incorporation, squashes acked prefix into `snapshot.db` if every peer has
   * acked past the current snapshot head. Ignores `opts.onConflict`.
   *
   * **Peer**: drops own actions that master has incorporated (identified by
   * `source.peer === peerId`), rebuilds the local db from snapshot + current
   * master log, then rebases remaining own actions. For each, if applying on
   * the new master state throws, or if `base + action + suffix` differs from
   * `base + suffix + action`, `opts.onConflict` is invoked. The resolver
   * returns `"drop"` (skip it — removed from log) or `"force"` (apply anyway
   * and tag with `{force: true, baseMasterSeq: <new master head>}`). Finally
   * appends a `master_ack` entry to this peer's log. **Throws** on conflict
   * if `onConflict` is not provided, or on `"force"` of an `"error"`-kind
   * conflict (cannot apply when the action throws on current state).
   *
   * @returns counts of incorporated / skipped / dropped / forced entries, plus
   *          the master seq that was squashed to (if any).
   */
  async sync(opts: SyncOptions = {}): Promise<SyncReport> {
    if (this.isMaster) return runMasterSync(this);
    return runPeerSync(this, opts);
  }

  /** Close the underlying SQLite connection. The on-disk log and snapshot are untouched. */
  close(): void {
    this.db.close();
  }
}
