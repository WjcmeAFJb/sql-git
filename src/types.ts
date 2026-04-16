import type { Database } from "better-sqlite3";

export type ActionFn = (db: Database, params: unknown) => void;

export type ActionRegistry = Record<string, ActionFn>;

export type Source = { peer: string; seq: number };

export type PeerActionEntry = {
  kind: "action";
  seq: number;
  name: string;
  params: unknown;
  baseMasterSeq: number;
  force?: boolean;
};

export type MasterAckEntry = {
  kind: "master_ack";
  masterSeq: number;
};

export type PeerLogEntry = PeerActionEntry | MasterAckEntry;

export type MasterActionEntry = {
  kind: "action";
  seq: number;
  name: string;
  params: unknown;
  source: Source;
  forced?: boolean;
};

export type PeerAckEntry = {
  kind: "peer_ack";
  peer: string;
  masterSeq: number;
};

export type SnapshotMarkerEntry = {
  kind: "snapshot";
  masterSeq: number;
};

export type MasterLogEntry = MasterActionEntry | PeerAckEntry | SnapshotMarkerEntry;

export type ConflictKind = "error" | "non_commutative";

export type ConflictContext = {
  action: PeerActionEntry;
  kind: ConflictKind;
  error?: Error;
  masterSuffix: MasterActionEntry[];
  baseDb: Database;
  rebasedDb: Database;
};

export type Resolution = "drop" | "force";

export type Resolver = (ctx: ConflictContext) => Resolution | Promise<Resolution>;

export type StoreOptions = {
  root: string;
  peerId: string;
  masterId: string;
  actions: ActionRegistry;
};

export type SyncOptions = {
  onConflict?: Resolver;
};

export type SyncReport = {
  applied: number;
  skipped: number;
  dropped: number;
  forced: number;
  squashedTo?: number;
};
