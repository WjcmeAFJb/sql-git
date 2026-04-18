import type { Db } from "./db.ts";
import type {
  IndexWriteLogEntry,
  PredicateLogEntry,
  ReadLogEntry,
  WriteLogEntry,
} from "sqlite3-read-tracking";

/**
 * An action: a deterministic, effectively-pure function of `(db, params)` that
 * mutates `db` in place. Return value is ignored; throwing signals failure and
 * aborts the operation (and, at sync time, marks the action as conflicting).
 *
 * Actions must be deterministic — no wall-clock reads, randomness, or external
 * I/O. `params` is persisted to the log as JSON and replayed on every peer.
 */
export type ActionFn = (db: Db, params: unknown) => void;

/** Map from action name to its implementation. Must agree across peers. */
export type ActionRegistry = Record<string, ActionFn>;

/** `{peer, seq}` back-reference identifying the original author of an action. */
export type Source = { peer: string; seq: number };

/**
 * VDBE-level read/write trace captured while applying one action. Used by the
 * conflict detector to cluster causally-related actions and skip the expensive
 * permutation check on disjoint peer/master suffixes.
 */
export type ActionTrace = {
  reads: ReadLogEntry[];
  writes: WriteLogEntry[];
  predicates: PredicateLogEntry[];
  idxWrites: IndexWriteLogEntry[];
};

/**
 * A non-master peer's proposed action (entry in `peers/<peerId>.jsonl`).
 * `baseMasterSeq` is the master head this peer had observed when the action
 * was written. `force: true` (set during conflict resolution) asks master to
 * accept even if its suffix is non-commutative — but only if master hasn't
 * advanced past `baseMasterSeq`.
 */
export type PeerActionEntry = {
  kind: "action";
  seq: number;
  name: string;
  params: unknown;
  baseMasterSeq: number;
  force?: boolean;
};

/**
 * A non-master peer's record of having observed master up to `masterSeq`.
 * Master reads these during its sync to decide how far it can squash.
 */
export type MasterAckEntry = {
  kind: "master_ack";
  masterSeq: number;
};

/** Any entry that can appear in a non-master peer's own log. */
export type PeerLogEntry = PeerActionEntry | MasterAckEntry;

/**
 * The master's canonical ordered action entry (entry in
 * `peers/<masterId>.jsonl`). `source` identifies the original author —
 * `source.peer === masterId` means the master submitted locally; otherwise it
 * references the incorporated action's `{peer, seq}` in the peer's own log.
 * `forced: true` is copied in when incorporating a forced peer action.
 */
export type MasterActionEntry = {
  kind: "action";
  seq: number;
  name: string;
  params: unknown;
  source: Source;
  forced?: boolean;
};

/** Master's record of a peer's latest `master_ack`. Drives squash progress. */
export type PeerAckEntry = {
  kind: "peer_ack";
  peer: string;
  masterSeq: number;
};

/**
 * Marker written at squash time. Everything at or below `masterSeq` is now
 * baked into `snapshot.db`; log entries at or below have been trimmed.
 */
export type SnapshotMarkerEntry = {
  kind: "snapshot";
  masterSeq: number;
};

/** Any entry that can appear in the master's log. */
export type MasterLogEntry = MasterActionEntry | PeerAckEntry | SnapshotMarkerEntry;

/**
 * Flavor of conflict reported to the resolver.
 * - `"error"`: applying the action on current master state throws.
 * - `"non_commutative"`: applies cleanly, but reordering with the master
 *   suffix produces a different final state (peer's intent doesn't survive rebase).
 */
export type ConflictKind = "error" | "non_commutative";

/**
 * Argument passed to a `Resolver` when peer sync hits a conflict. `baseDb`
 * and `rebasedDb` are read-only scratch databases (the action's original
 * base state and the current rebased master state, respectively) — the
 * resolver may inspect them but must not mutate.
 *
 * The resolver may also call {@link ConflictContext.submit} to append new
 * peer actions (like `git commit` during interactive rebase) — those actions
 * are applied to the in-flight rebased state and committed to the peer's log
 * regardless of whether the original action ends up applied, dropped, or
 * forced. Combined with `"retry"`, this lets the resolver unblock a failing
 * action (e.g., top up a balance) before re-attempting it.
 */
export type ConflictContext = {
  /** The peer-local action entry in conflict. */
  action: PeerActionEntry;
  /** What went wrong — see {@link ConflictKind}. */
  kind: ConflictKind;
  /** Present iff `kind === "error"`: the error the action threw. */
  error?: Error;
  /** Master actions that happened after `action.baseMasterSeq`. */
  masterSuffix: MasterActionEntry[];
  /** Read-only db at `action.baseMasterSeq`. Do not mutate. */
  baseDb: Db;
  /** Read-only db at the new master head. Do not mutate. */
  rebasedDb: Db;
  /**
   * Queue a new peer action to be committed before the current one retries.
   * Applied immediately to the rebased working db; persisted into the peer's
   * log on return from the resolver. Throws if `name` isn't registered, or
   * if the action throws when applied. Meant to be followed by `"retry"`.
   */
  submit(name: string, params: unknown): void;
};

/**
 * The resolver's decision.
 * - `"drop"`: remove the action from the peer's log; never propagate it.
 * - `"force"`: keep it, tagged `force: true` with `baseMasterSeq = <new head>`.
 *   Master will accept iff its head hasn't moved past that seq when it next
 *   processes this peer. Only valid for `"non_commutative"` conflicts.
 * - `"retry"`: re-check the action against the new state (after any
 *   `ctx.submit(...)` calls have been applied). Requires at least one
 *   `ctx.submit(...)` call, otherwise no progress is made and sync throws.
 */
export type Resolution = "drop" | "force" | "retry";

/** Callback invoked by peer sync on each conflict. May be sync or async. */
export type Resolver = (ctx: ConflictContext) => Resolution | Promise<Resolution>;

/** Arguments to {@link Store.open}. */
export type StoreOptions = {
  /** Filesystem directory containing `snapshot.db` and `peers/`. */
  root: string;
  /** This store's peer id. */
  peerId: string;
  /** The cluster's master peer id. If it matches `peerId`, this store is the master. */
  masterId: string;
  /** Registry of action implementations, shared across peers. */
  actions: ActionRegistry;
  /** Optional debug flags. Off by default. */
  debug?: {
    /** When true, master writes every log entry that leaves the live log
     *  during squash into `<root>/peers/<masterId>.squashed.jsonl` — so
     *  tooling (history graphs, auditors) can still see the full lineage
     *  of the cluster. */
    keepSquashedLog?: boolean;
  };
};

/** Arguments to {@link Store.sync}. */
export type SyncOptions = {
  /** Required for peers that may have conflicting actions; master ignores it. */
  onConflict?: Resolver;
};

/**
 * Summary of a completed sync.
 * - `applied`: entries that landed in the master log (for master) or in the
 *   peer's rebased log (for peer).
 * - `skipped`: peer actions master chose not to process (first-conflict stop
 *   or cascade after it).
 * - `dropped`: peer actions the resolver elected to drop.
 * - `forced`: peer actions marked forced this round (for master: how many
 *   forces were accepted; for peer: how many the resolver forced).
 * - `convergent`: peer actions that the conflict detector accepted as
 *   non-conflicting because both branch orderings reached the same final
 *   state (even though their read/write sets overlapped).
 * - `squashedTo`: master-only — the master seq the snapshot was advanced to.
 */
export type SyncReport = {
  applied: number;
  skipped: number;
  dropped: number;
  forced: number;
  convergent?: number;
  squashedTo?: number;
};
