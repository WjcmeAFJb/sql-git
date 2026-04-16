import type { Database as Db } from "better-sqlite3";
import { appendEntry, ensureDir, ensureFile, readLog } from "./log.ts";
import { peerLogPath, peersDir, snapshotPath } from "./paths.ts";
import { loadSnapshotToMemory } from "./snapshot.ts";
import { getSnapshotHead } from "./db.ts";
import { applyAction } from "./apply.ts";
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

export class Store {
  db: Db;
  readonly root: string;
  readonly peerId: string;
  readonly masterId: string;
  readonly isMaster: boolean;
  readonly actions: ActionRegistry;

  /** Master-only: canonical ordered log. Empty for non-master. */
  masterLog: MasterLogEntry[];

  /** Non-master only: this peer's proposed-action log. Empty for master. */
  peerLog: PeerLogEntry[];

  /** Next seq for master's own actions (master only). */
  nextMasterSeq: number;

  /** Next seq for this peer's own actions (non-master only). */
  nextPeerSeq: number;

  /** Highest master seq this peer has integrated into local db. */
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

  async sync(opts: SyncOptions = {}): Promise<SyncReport> {
    if (this.isMaster) return runMasterSync(this);
    return runPeerSync(this, opts);
  }

  close(): void {
    this.db.close();
  }
}
