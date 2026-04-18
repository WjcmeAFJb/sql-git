import { fs } from "./fs.ts";
import { Db, loadDbFromBytes, openMemoryDb } from "./db.ts";

/*
 * snapshot.db on disk is a small JSON document: schema + rows + sequences.
 * The WASM SQLite build doesn't ship `sqlite3_serialize`, so we round-trip
 * via the structural dump we already needed for `compareDbs`.
 */

export async function loadSnapshotToMemory(snapshotFile: string): Promise<Db> {
  if (!(await fs.exists(snapshotFile))) return openMemoryDb();
  const bytes = await fs.readFile(snapshotFile);
  if (bytes.length === 0) return openMemoryDb();
  return loadDbFromBytes(bytes);
}

export async function saveDbToFile(db: Db, p: string): Promise<void> {
  const bytes = db.serialize();
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, p);
}
