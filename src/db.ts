import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { copyFileSync, existsSync } from "node:fs";

export const META_TABLE = "__sqlgit_meta__";

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  initMeta(db);
  return db;
}

export function openMemoryDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initMeta(db);
  return db;
}

export function cloneDb(db: Db): Db {
  const buf = db.serialize();
  const cloned = new Database(buf);
  cloned.pragma("foreign_keys = ON");
  return cloned;
}

export function copyDbFile(src: string, dest: string): void {
  if (!existsSync(src)) return;
  copyFileSync(src, dest);
}

export function initMeta(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
}

export function getSnapshotHead(db: Db): number {
  const row = db
    .prepare(`SELECT value FROM ${META_TABLE} WHERE key='snapshot_head'`)
    .get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function setSnapshotHead(db: Db, seq: number): void {
  db.prepare(
    `INSERT INTO ${META_TABLE} (key, value) VALUES ('snapshot_head', ?) ` +
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(seq));
}

type TableInfo = { name: string };
type ColumnInfo = { name: string };

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function dumpAll(db: Db): string {
  const schemaRows = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND name <> '${META_TABLE}'
       ORDER BY type, name`,
    )
    .all();

  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '${META_TABLE}'
       ORDER BY name`,
    )
    .all() as TableInfo[];

  const data: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as ColumnInfo[];
    const colList = cols.map((c) => quoteIdent(c.name)).join(", ");
    const orderBy = cols.map((c) => quoteIdent(c.name)).join(", ");
    data[name] = db
      .prepare(`SELECT ${colList} FROM ${quoteIdent(name)} ORDER BY ${orderBy}`)
      .all();
  }

  let sequences: unknown[] = [];
  const seqExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
    .get();
  if (seqExists) {
    sequences = db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all();
  }

  return JSON.stringify({ schema: schemaRows, data, sequences });
}

/**
 * Structural equality of two SQLite databases by their user-visible content.
 *
 * Compares: schema (tables, indices, views, triggers from `sqlite_master`),
 * every user table's rows sorted by all columns, and `sqlite_sequence`
 * (AUTOINCREMENT counters). Ignores rowid ordering and the internal
 * `__sqlgit_meta__` table.
 */
export function compareDbs(a: Db, b: Db): boolean {
  return dumpAll(a) === dumpAll(b);
}

export function dumpDigest(db: Db): string {
  return dumpAll(db);
}
