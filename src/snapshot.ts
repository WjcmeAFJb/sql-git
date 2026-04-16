import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { existsSync, writeFileSync, renameSync } from "node:fs";
import { initMeta } from "./db.ts";

export function loadSnapshotToMemory(snapshotFile: string): Db {
  if (!existsSync(snapshotFile)) {
    const mem = new Database(":memory:");
    initMeta(mem);
    return mem;
  }
  const fileDb = new Database(snapshotFile, { readonly: true });
  const buf = fileDb.serialize();
  fileDb.close();
  const mem = new Database(buf);
  initMeta(mem);
  return mem;
}

export function saveDbToFile(db: Db, path: string): void {
  const buf = db.serialize();
  const tmp = path + ".tmp";
  writeFileSync(tmp, buf);
  renameSync(tmp, path);
}
