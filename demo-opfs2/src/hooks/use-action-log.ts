import { useEffect, useState } from "react";
import type { OpfsFs } from "../../../src/fs-opfs";
import { readLog } from "../../../src/log";
import { peerLogPath } from "../../../src/paths";
import type { MasterLogEntry } from "../../../src/types";

/**
 * Read the master log from disk for display. Both master and peer tabs
 * need to see it — master has `store.masterLog` in memory, but we also
 * re-read from disk so the peer tabs see it after file-sync. Cheap because
 * the log is short (trimmed on squash) and only refreshed on `tick`.
 */
export function useMasterLog(
  opfs: OpfsFs | null,
  root: string,
  masterId: string,
  tick: number,
): MasterLogEntry[] {
  const [log, setLog] = useState<MasterLogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!opfs || !root) return;
    (async () => {
      try {
        const entries = await readLog<MasterLogEntry>(peerLogPath(root, masterId));
        if (!cancelled) setLog(entries);
      } catch {
        if (!cancelled) setLog([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opfs, root, masterId, tick]);

  return log;
}
