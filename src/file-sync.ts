import type { MasterLogEntry } from "./types.ts";

/**
 * Thrown when `snapshot.db` and the master log disagree about the squashed
 * prefix — specifically, the master log declares a snapshot at seq N but the
 * on-disk `snapshot.db` has head < N. This is the typical transient state
 * when an external file syncer (Syncthing, Dropbox, `rsync`) has delivered
 * the trimmed master log before the matching snapshot file. Retry the
 * operation after the file sync settles.
 */
export class FileSyncLagError extends Error {
  readonly code = "SQLGIT_FILE_SYNC_LAG" as const;
  readonly snapshotHead: number;
  readonly declaredSnapshotHead: number;
  constructor(snapshotHead: number, declaredSnapshotHead: number) {
    super(
      `sql-git file sync lag: master log declares snapshot up to seq ${declaredSnapshotHead}, ` +
        `but snapshot.db has head ${snapshotHead}. ` +
        `The external file syncer has not yet delivered snapshot.db — retry after it settles.`,
    );
    this.name = "FileSyncLagError";
    this.snapshotHead = snapshotHead;
    this.declaredSnapshotHead = declaredSnapshotHead;
  }
}

/** Latest snapshot-marker seq declared in the master log, or 0 if none. */
export function latestSnapshotMarker(masterLog: MasterLogEntry[]): number {
  let latest = 0;
  for (const e of masterLog) {
    if (e.kind === "snapshot" && e.masterSeq > latest) latest = e.masterSeq;
  }
  return latest;
}

/**
 * Throws {@link FileSyncLagError} if the master log's declared snapshot head
 * is ahead of the actual snapshot head. No-op otherwise. Safe to call with a
 * master-log view that has no snapshot markers (returns cleanly).
 */
export function assertFilesConsistent(masterLog: MasterLogEntry[], snapshotHead: number): void {
  const declared = latestSnapshotMarker(masterLog);
  if (declared > snapshotHead) {
    throw new FileSyncLagError(snapshotHead, declared);
  }
}
