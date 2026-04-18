import initSqliteTracked from "sqlite3-read-tracking";
import type {
  Database as RawDb,
  IndexWriteLogEntry,
  PredicateLogEntry,
  ReadLogEntry,
  SqliteTracked,
  SqlValue,
  WriteLogEntry,
} from "sqlite3-read-tracking";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type Param = string | number | boolean | bigint | Uint8Array | null | undefined;
export type { ReadLogEntry, WriteLogEntry, PredicateLogEntry, IndexWriteLogEntry, SqlValue };

export const META_TABLE = "__sqlgit_meta__";

/*
 * The read-tracking SQLite build is a WASM/sql.js factory: one module-wide
 * `initSqliteTracked()` loads the shared wasm, every Database then runs
 * synchronously against it. We memoize the factory promise and also cache a
 * direct `sqlite3_changes` cwrap so our `.run(...)` wrapper can surface a
 * row-count shape compatible with the better-sqlite3 API the rest of the
 * code still uses.
 */

let SQL_PROMISE: Promise<SqliteTracked> | null = null;
let SQL_CACHED: SqliteTracked | null = null;
let sqlite3_changes_fn: ((ptr: number) => number) | null = null;

export async function initSql(): Promise<SqliteTracked> {
  if (SQL_CACHED) return SQL_CACHED;
  if (!SQL_PROMISE) SQL_PROMISE = initSqliteTracked();
  const mod = await SQL_PROMISE;
  SQL_CACHED = mod;
  const cwrap = (mod as unknown as { cwrap: (name: string, ret: string, args: string[]) => (...a: number[]) => number }).cwrap;
  sqlite3_changes_fn = cwrap("sqlite3_changes", "number", ["number"]) as (p: number) => number;
  return mod;
}

function sqlSync(): SqliteTracked {
  if (!SQL_CACHED) {
    throw new Error(
      "sqlite3-read-tracking not initialized. Call `await initSql()` or open the Store before sync operations.",
    );
  }
  return SQL_CACHED;
}

function changes(raw: RawDb): number {
  if (!sqlite3_changes_fn) throw new Error("sqlite3_changes not wrapped");
  const ptr = (raw as unknown as { ptr: number }).ptr;
  return sqlite3_changes_fn(ptr);
}

function isBindObject(v: unknown): v is Record<string, Param> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Uint8Array) &&
    !(v instanceof ArrayBuffer)
  );
}

function normalizeArgs(args: Param[]): Param[] | Record<string, Param> | null {
  if (args.length === 0) return null;
  if (args.length === 1 && isBindObject(args[0])) return args[0];
  return args;
}

/**
 * Thin adapter around a sql.js `Database` that exposes the subset of the
 * better-sqlite3 surface our codebase uses (`prepare`, `exec`, `pragma`,
 * implicit tracking pass-through). Also surfaces the VDBE-level read/write
 * logs used by the conflict detector.
 */
export class Db {
  readonly raw: RawDb;

  constructor(raw: RawDb) {
    this.raw = raw;
  }

  exec(sql: string, params?: Param[] | Record<string, Param>): void {
    this.raw.exec(sql, params as never);
  }

  prepare(sql: string): Stmt {
    return new Stmt(this, sql);
  }

  pragma(stmt: string): void {
    this.raw.exec(`PRAGMA ${stmt}`);
  }

  beginTracking(): void {
    this.raw.beginTracking();
  }
  endTracking(): void {
    this.raw.endTracking();
  }
  resetTracking(): void {
    this.raw.resetTracking();
  }
  isTracking(): boolean {
    return this.raw.isTracking();
  }
  getReadLog(): ReadLogEntry[] {
    return this.raw.getReadLog();
  }
  getWriteLog(): WriteLogEntry[] {
    return this.raw.getWriteLog();
  }
  getPredicateLog(): PredicateLogEntry[] {
    return this.raw.getPredicateLog();
  }
  getIndexWriteLog(): IndexWriteLogEntry[] {
    return this.raw.getIndexWriteLog();
  }

  close(): void {
    try {
      this.raw.close();
    } catch {
      /* idempotent */
    }
  }

  /** Portable snapshot: JSON blob capturing schema, rows, and sqlite_sequence. */
  serialize(): Uint8Array {
    return serializeDb(this);
  }
}

/*
 * Statement wrapper mimicking better-sqlite3's `.run / .get / .all`. We use
 * `Database.exec(sql, params)` under the hood because the sqlite3-tracked
 * `Statement#getAsObject` steps internally — combining it with a `.step()`
 * loop double-advances the cursor. `exec` returns `[{columns, values}]`
 * directly from a single pass, which sidesteps the whole issue.
 */
export class Stmt {
  private readonly db: Db;
  private readonly sql: string;
  constructor(db: Db, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  run(...args: Param[]): { changes: number } {
    const params = normalizeArgs(args);
    if (params === null) this.db.raw.exec(this.sql);
    else this.db.raw.exec(this.sql, params as never);
    return { changes: changes(this.db.raw) };
  }

  get(...args: Param[]): Record<string, SqlValue> | undefined {
    const params = normalizeArgs(args);
    const results =
      params === null
        ? this.db.raw.exec(this.sql)
        : this.db.raw.exec(this.sql, params as never);
    if (!results.length) return undefined;
    const { columns, values } = results[0];
    if (!values.length) return undefined;
    return rowToObject(columns, values[0]);
  }

  all(...args: Param[]): Record<string, SqlValue>[] {
    const params = normalizeArgs(args);
    const results =
      params === null
        ? this.db.raw.exec(this.sql)
        : this.db.raw.exec(this.sql, params as never);
    if (!results.length) return [];
    const { columns, values } = results[0];
    return values.map((v) => rowToObject(columns, v));
  }
}

function rowToObject(columns: string[], values: SqlValue[]): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]] = values[i];
  return out;
}

export function openDb(path: string): Db {
  const SQL = sqlSync();
  const raw = existsSync(path) ? deserializeRaw(SQL, readFileSync(path)) : new SQL.Database();
  raw.exec("PRAGMA foreign_keys = ON");
  const db = new Db(raw);
  initMeta(db);
  return db;
}

export function openMemoryDb(): Db {
  const SQL = sqlSync();
  const raw = new SQL.Database();
  raw.exec("PRAGMA foreign_keys = ON");
  const db = new Db(raw);
  initMeta(db);
  return db;
}

export function cloneDb(db: Db): Db {
  const SQL = sqlSync();
  const bytes = serializeDb(db);
  const raw = deserializeRaw(SQL, bytes);
  raw.exec("PRAGMA foreign_keys = ON");
  return new Db(raw);
}

export function copyDbFile(src: string, dest: string): void {
  if (!existsSync(src)) return;
  const bytes = readFileSync(src);
  const tmp = dest + ".tmp";
  writeFileSync(tmp, bytes);
  renameSync(tmp, dest);
}

/** Load a JSON-dumped snapshot into a fresh in-memory Db. FKs are ON. */
export function loadDbFromBytes(bytes: Uint8Array): Db {
  const SQL = sqlSync();
  const raw = deserializeRaw(SQL, bytes);
  raw.exec("PRAGMA foreign_keys = ON");
  const db = new Db(raw);
  initMeta(db);
  return db;
}

export function initMeta(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
}

export function getSnapshotHead(db: Db): number {
  const row = db
    .prepare(`SELECT value FROM ${META_TABLE} WHERE key='snapshot_head'`)
    .get() as { value: string | number } | undefined;
  return row ? Number(row.value) : 0;
}

export function setSnapshotHead(db: Db, seq: number): void {
  db.prepare(
    `INSERT INTO ${META_TABLE} (key, value) VALUES ('snapshot_head', ?) ` +
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(seq));
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

type SerializedDb = {
  schema: { type: string; name: string; tbl_name: string; sql: string | null }[];
  tables: string[];
  /** Row tuples as `[rowid, ...schemaColsInOrder]` for rowid tables, or just
   *  `[...schemaColsInOrder]` for WITHOUT ROWID tables. */
  data: Record<string, SqlValue[][]>;
  columns: Record<string, string[]>;
  /** Whether each table is a rowid table (data rows carry a leading rowid). */
  rowidTables: Record<string, boolean>;
  sequences: { name: string; seq: number }[];
};

function hasRowid(db: Db, table: string): boolean {
  try {
    db.prepare(`SELECT rowid FROM ${quoteIdent(table)} LIMIT 0`).all();
    return true;
  } catch {
    return false;
  }
}

function dumpDoc(db: Db): SerializedDb {
  const schema = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];

  const tableRows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as { name: string }[];
  const tables = tableRows.map((r) => r.name);

  const data: Record<string, SqlValue[][]> = {};
  const columns: Record<string, string[]> = {};
  const rowidTables: Record<string, boolean> = {};
  for (const name of tables) {
    const cols = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    columns[name] = colNames;
    const withRowid = hasRowid(db, name);
    rowidTables[name] = withRowid;
    const colList = (withRowid ? ["rowid", ...colNames.map(quoteIdent)] : colNames.map(quoteIdent)).join(", ");
    // Preserve rowid ordering so tracking-log rowids roundtrip through clones.
    const orderBy = withRowid ? "rowid" : colNames.map(quoteIdent).join(", ");
    const rows = db
      .prepare(`SELECT ${colList} FROM ${quoteIdent(name)} ORDER BY ${orderBy}`)
      .all() as Record<string, SqlValue>[];
    data[name] = rows.map((r) =>
      withRowid
        ? [r.rowid ?? null, ...colNames.map((c) => r[c] ?? null)]
        : colNames.map((c) => r[c] ?? null),
    );
  }

  let sequences: { name: string; seq: number }[] = [];
  const seqExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
    .get();
  if (seqExists) {
    sequences = db
      .prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name")
      .all() as { name: string; seq: number }[];
  }

  return { schema, tables, data, columns, rowidTables, sequences };
}

function serializeDb(db: Db): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(dumpDoc(db)));
}

function deserializeRaw(SQL: SqliteTracked, bytes: Uint8Array): RawDb {
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    const raw = new SQL.Database();
    return raw;
  }
  const doc = JSON.parse(text) as SerializedDb;
  const raw = new SQL.Database();
  // FKs off during load so we can insert in any table order.
  raw.exec("PRAGMA foreign_keys = OFF");

  // Create tables first (so inserts can reference them), then indices and
  // triggers. Views are recreated last.
  const byType = (t: string) => doc.schema.filter((s) => s.type === t && s.sql);
  for (const s of byType("table")) raw.exec(s.sql as string);
  // Note: rowidTables may be absent in docs written by an older dumper — in
  // that case, default to "rowid table" but don't try to bind a rowid.
  const rowidTables = doc.rowidTables ?? {};
  for (const tbl of doc.tables) {
    const rows = doc.data[tbl] ?? [];
    if (rows.length === 0) continue;
    const cols = doc.columns[tbl];
    if (!cols) continue;
    const withRowid = rowidTables[tbl] ?? false;
    const colList = withRowid ? ["rowid", ...cols.map(quoteIdent)] : cols.map(quoteIdent);
    const placeholders = colList.map(() => "?").join(",");
    const stmt = raw.prepare(
      `INSERT INTO ${quoteIdent(tbl)} (${colList.join(",")}) VALUES (${placeholders})`,
    );
    try {
      for (const row of rows) {
        stmt.reset();
        stmt.bind(row as never);
        stmt.step();
      }
    } finally {
      stmt.free();
    }
  }
  for (const s of byType("index")) if (s.sql) raw.exec(s.sql);
  for (const s of byType("trigger")) if (s.sql) raw.exec(s.sql);
  for (const s of byType("view")) if (s.sql) raw.exec(s.sql);

  for (const row of doc.sequences) {
    raw.exec("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", [
      row.name,
      row.seq,
    ] as never);
  }
  return raw;
}

/**
 * Structural equality of two SQLite databases by their user-visible content.
 * Ignores rowid ordering and the internal __sqlgit_meta__ table (the latter
 * is user-visible in schema too, but carries only the snapshot head).
 */
export function compareDbs(a: Db, b: Db): boolean {
  return dumpDigest(a) === dumpDigest(b);
}

export function dumpDigest(db: Db): string {
  const doc = dumpDoc(db);
  // Exclude the internal meta table from structural compare (the snapshot
  // head drifts independently of user state).
  const schema = doc.schema.filter((s) => s.name !== META_TABLE && s.tbl_name !== META_TABLE);
  const data: Record<string, SqlValue[][]> = {};
  for (const [k, v] of Object.entries(doc.data)) {
    if (k === META_TABLE) continue;
    // Drop the leading rowid (it's content-irrelevant: two dbs with the same
    // user-visible rows but different insertion orders should still compare
    // equal). Sort tuples lexicographically so row order doesn't matter.
    const withRowid = doc.rowidTables[k] ?? false;
    const stripped = withRowid ? v.map((r) => r.slice(1)) : v.map((r) => r.slice());
    stripped.sort((a, b) => {
      const as = JSON.stringify(a);
      const bs = JSON.stringify(b);
      return as < bs ? -1 : as > bs ? 1 : 0;
    });
    data[k] = stripped;
  }
  return JSON.stringify({ schema, data, sequences: doc.sequences });
}
