import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { Db, loadDbFromBytes, openMemoryDb } from "./db.ts";

/*
 * snapshot.db on disk is a small JSON document: schema + rows + sequences.
 * The WASM SQLite build doesn't ship `sqlite3_serialize`, so we round-trip
 * via the structural dump we already needed for `compareDbs`.
 */

export function loadSnapshotToMemory(snapshotFile: string): Db {
  if (!existsSync(snapshotFile)) return openMemoryDb();
  const bytes = readFileSync(snapshotFile);
  if (bytes.length === 0) return openMemoryDb();
  return loadDbFromBytes(bytes);
}

export function saveDbToFile(db: Db, path: string): void {
  const bytes = db.serialize();
  const tmp = path + ".tmp";
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}
