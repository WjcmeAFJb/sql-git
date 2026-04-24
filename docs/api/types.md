# Types reference

Every exported type, grouped by topic. Import any of them from the
package root:

```ts
import type {
  ActionFn,
  ActionRegistry,
  ActionTrace,
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
} from "sql-git";

import type {
  FsAdapter,
  PathAdapter,
  FsEvent,
} from "sql-git";

import type { Db, SqliteInitConfig } from "sql-git";
```

## Actions

```ts
type ActionFn = (db: Db, params: unknown) => void;
type ActionRegistry = Record<string, ActionFn>;
```

## Store options

```ts
type StoreOptions = {
  root: string;
  peerId: string;
  masterId: string;
  actions: ActionRegistry;
  debug?: { keepSquashedLog?: boolean };
};

type SyncOptions = {
  onConflict?: Resolver;
};

type SyncReport = {
  applied: number;
  skipped: number;
  dropped: number;
  forced: number;
  convergent?: number;
  squashedTo?: number;
};
```

## Log entries

```ts
type PeerActionEntry = {
  kind: "action";
  seq: number;
  name: string;
  params: unknown;
  baseMasterSeq: number;
  force?: boolean;
};

type MasterAckEntry = {
  kind: "master_ack";
  masterSeq: number;
};

type PeerLogEntry = PeerActionEntry | MasterAckEntry;

type MasterActionEntry = {
  kind: "action";
  seq: number;
  name: string;
  params: unknown;
  source: { peer: string; seq: number };
  forced?: boolean;
};

type PeerAckEntry = {
  kind: "peer_ack";
  peer: string;
  masterSeq: number;
};

type SnapshotMarkerEntry = {
  kind: "snapshot";
  masterSeq: number;
};

type MasterLogEntry = MasterActionEntry | PeerAckEntry | SnapshotMarkerEntry;
```

## Conflict resolution

```ts
type ConflictKind = "error" | "non_commutative";
type Resolution = "drop" | "force" | "retry";
type Resolver = (ctx: ConflictContext) => Resolution | Promise<Resolution>;

type ConflictContext = {
  action: PeerActionEntry;
  kind: ConflictKind;
  error?: Error;
  masterSuffix: MasterActionEntry[];
  baseDb: Db;
  rebasedDb: Db;
  submit(name: string, params: unknown): void;
};
```

## Tracing (used by the convergence detector)

```ts
type ActionTrace = {
  reads: ReadLogEntry[];
  writes: WriteLogEntry[];
  predicates: PredicateLogEntry[];
  idxWrites: IndexWriteLogEntry[];
};
```

`ReadLogEntry` / `WriteLogEntry` / `PredicateLogEntry` /
`IndexWriteLogEntry` come from
[`sqlite3-read-tracking`](https://github.com/WjcmeAFJb/sql-read-tracking)
and are re-exported for convenience.

## FS adapter

```ts
type FsEvent =
  | { type: "write"; path: string }
  | { type: "mkdir"; path: string }
  | { type: "rename"; from: string; to: string }
  | { type: "delete"; path: string };

interface FsAdapter {
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  remove?(path: string): Promise<void>;
  watch?(
    path: string,
    cb: (e: FsEvent, origin: "local" | "remote") => void,
  ): () => void;
}

interface PathAdapter {
  join(...parts: string[]): string;
  dirname(path: string): string;
}
```

## SQLite

```ts
interface SqliteInitConfig {
  locateFile?: (name: string) => string;
  wasmBinary?: ArrayBuffer | Uint8Array;
}

function setSqliteInitConfig(cfg: SqliteInitConfig): void;
function initSql(): Promise<SqliteTracked>;

class Db {
  exec(sql: string, params?: Param[] | Record<string, Param>): void;
  prepare(sql: string): Stmt;
  pragma(stmt: string): void;
  close(): void;
  // ...
}
```

## Errors

```ts
class FileSyncLagError extends Error {
  readonly code = "SQLGIT_FILE_SYNC_LAG";
  readonly snapshotHead: number;
  readonly declaredSnapshotHead: number;
}
```

Thrown by `Store.open` / `Store.sync` when the master log references a
snapshot head that the on-disk `snapshot.db` hasn't caught up to yet.
Safe to retry after your file syncer settles.
