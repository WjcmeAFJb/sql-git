import { useEffect, useRef, useState } from "react";
import type { FsEvent } from "../../../src/fs";
import type { OpfsFs } from "../../../src/fs-opfs";

export type WatchEvent = FsEvent & { at: number; origin: "local" | "remote" };

/**
 * Subscribe to OPFS mutation events under `peerDir` for this tab's peer.
 *
 * Returns the most recent events (for the UI) and fires `onRemoteWrite` when
 * another tab or the sync menu touches a file in our peer dir — that's the
 * signal for auto-sync. We filter out writes to our own `peers/<peerId>.jsonl`
 * to avoid the self-feedback loop the TUI demo wrestled with: every time
 * we append to our own log we'd otherwise retrigger sync forever.
 *
 * `onRemoteWrite` is captured via a ref so we never re-subscribe when the
 * parent passes a fresh closure. Re-subscribing on every render would tear
 * down in-flight debounce timers and silently drop events.
 */
export function useWatcher({
  opfs,
  peerDir,
  peerId,
  isMaster,
  onRemoteWrite,
  debounceMs = 250,
}: {
  opfs: OpfsFs | null;
  peerDir: string;
  peerId: string;
  isMaster: boolean;
  onRemoteWrite: () => void;
  debounceMs?: number;
}) {
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(onRemoteWrite);
  callbackRef.current = onRemoteWrite;

  useEffect(() => {
    if (!opfs) return;

    const ownLogSuffix = `/peers/${peerId}.jsonl`;
    const snapshotSuffix = `/snapshot.db`;

    const isOwnWrite = (path: string): boolean => {
      if (path.endsWith(ownLogSuffix)) return true;
      if (isMaster && path.endsWith(snapshotSuffix)) return true;
      return false;
    };

    const unsub = opfs.fs.watch!(peerDir, (e, origin) => {
      const at = Date.now();
      const path = "from" in e ? e.to : e.path;
      setEvents((prev) => [{ ...e, at, origin }, ...prev].slice(0, 50));

      if (origin !== "remote") return;
      if (isOwnWrite(path)) return;

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        callbackRef.current();
      }, debounceMs);
    });

    return () => {
      unsub();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [opfs, peerDir, peerId, isMaster, debounceMs]);

  return { events, clearEvents: () => setEvents([]) };
}
