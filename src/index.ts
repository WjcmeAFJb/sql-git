export { Store } from "./store.ts";
export { FileSyncLagError } from "./file-sync.ts";
export type {
  ActionFn,
  ActionRegistry,
  ConflictContext,
  ConflictKind,
  MasterActionEntry,
  MasterLogEntry,
  PeerActionEntry,
  PeerLogEntry,
  Resolution,
  Resolver,
  StoreOptions,
  SyncOptions,
  SyncReport,
} from "./types.ts";
export { compareDbs } from "./db.ts";
