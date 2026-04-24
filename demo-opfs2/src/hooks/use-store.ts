import { useCallback, useEffect, useRef, useState } from "react";
import { createOpfsFs, type OpfsFs } from "../../../src/fs-opfs";
import { setFs, setPath } from "../../../src/fs";
import { Store, FileSyncLagError } from "../../../src/index";
import type { ConflictContext, Resolution, SyncReport } from "../../../src/types";
import { bankActions } from "../../../demo/actions";
import { configureSqlite } from "@/lib/sqlite-init";
import { MASTER_ID } from "@/components/PeerGate";

const OPFS_DEMO_ROOT = "demo-opfs2";
const OPFS_CHANNEL = `sql-git:${OPFS_DEMO_ROOT}`;

export type Mode = "opening" | "idle" | "syncing" | "conflict" | "error";

export type QueuedAction = { name: string; params: unknown };

export type PendingConflict = {
  ctx: ConflictContext;
  resolve: (r: Resolution) => void;
  /** Actions the user has queued (via ctx.submit) during this conflict.
   *  Retained for display; `ctx.submit` already committed them to the
   *  library-internal `prepended` list. */
  queued: QueuedAction[];
};

export type Status = {
  kind: "info" | "success" | "error" | "warning";
  message: string;
};

export type UseStore = {
  store: Store | null;
  opfs: OpfsFs | null;
  mode: Mode;
  status: Status;
  head: number;
  conflict: PendingConflict | null;
  resolveConflict: (r: Resolution) => void;
  sync: () => Promise<void>;
  submit: (name: string, params: unknown) => Promise<string | null>;
  bump: () => void;
  tick: number; // changes whenever store state is mutated — forces re-reads
};

/**
 * One-time global OPFS setup. The adapter is a singleton because sql-git's
 * internals route through `setFs(...)` — we can't have two Stores backed by
 * different OPFS mounts in the same page. Every peer tab opens the same
 * demo root (`demo-opfs2/`) and scopes its Store to a `/peerId` subdir.
 */
let sharedOpfs: Promise<OpfsFs> | null = null;
function getSharedOpfs(): Promise<OpfsFs> {
  if (!sharedOpfs) {
    sharedOpfs = (async () => {
      configureSqlite();
      const opfs = createOpfsFs();
      await opfs.init({ rootName: OPFS_DEMO_ROOT, channelName: OPFS_CHANNEL });
      // Install as the global fs+path for sql-git. Browser adapters need an
      // explicit install (unlike the Node adapter's auto-register).
      setFs(opfs.fs);
      setPath(opfs.path);
      return opfs;
    })();
  }
  return sharedOpfs;
}

export function useStore(peerId: string | null): UseStore {
  const [store, setStore] = useState<Store | null>(null);
  const [opfs, setOpfs] = useState<OpfsFs | null>(null);
  const [mode, setMode] = useState<Mode>("opening");
  const [status, setStatus] = useState<Status>({ kind: "info", message: "starting…" });
  const [head, setHead] = useState(0);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [tick, setTick] = useState(0);

  const storeRef = useRef<Store | null>(null);
  const syncingRef = useRef(false);
  const modeRef = useRef<Mode>(mode);
  const conflictRef = useRef<PendingConflict | null>(null);
  modeRef.current = mode;
  storeRef.current = store;
  conflictRef.current = conflict;

  const bump = useCallback(() => setTick((n) => n + 1), []);

  const sync = useCallback(async () => {
    const s = storeRef.current;
    if (!s || syncingRef.current) return;
    syncingRef.current = true;
    setMode("syncing");
    try {
      const resolver = (ctx: ConflictContext) =>
        new Promise<Resolution>((resolve) => {
          setConflict({ ctx, resolve, queued: [] });
          setMode("conflict");
        });
      const report: SyncReport = await s.sync({ onConflict: resolver });
      setHead(s.currentMasterSeq);
      const bits = [
        `applied=${report.applied}`,
        `skipped=${report.skipped}`,
        `dropped=${report.dropped}`,
        `forced=${report.forced}`,
      ];
      if (report.convergent !== undefined && report.convergent > 0)
        bits.push(`convergent=${report.convergent}`);
      if (report.squashedTo !== undefined)
        bits.push(`squashedTo=${report.squashedTo}`);
      setStatus({ kind: "success", message: `synced ${bits.join(" ")}` });
      setConflict(null);
      setMode("idle");
      bump();
    } catch (err) {
      if (err instanceof FileSyncLagError) {
        setStatus({
          kind: "info",
          message: `file-sync-lag snapshotHead=${err.snapshotHead} declared=${err.declaredSnapshotHead}`,
        });
      } else {
        setStatus({
          kind: "error",
          message: `sync-error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      setConflict(null);
      setMode("idle");
    } finally {
      syncingRef.current = false;
    }
  }, [bump]);

  const submit = useCallback(
    async (name: string, params: unknown): Promise<string | null> => {
      const s = storeRef.current;
      if (!s) return "store not open";
      // During conflict, route through the resolver's ctx.submit so the user's
      // mitigation actions are prepended into the in-flight sync rather than
      // disappearing on the next rewriteLog. This applies to rebasedDb
      // immediately, so the UI (which reads from rebasedDb while the conflict
      // is pending) reflects the change right away.
      if (modeRef.current === "conflict") {
        const c = conflictRef.current;
        if (!c) return "no active conflict";
        try {
          c.ctx.submit(name, params);
          setConflict((curr) =>
            curr ? { ...curr, queued: [...curr.queued, { name, params }] } : curr,
          );
          bump();
          return null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setStatus({ kind: "error", message: msg });
          return msg;
        }
      }
      try {
        await s.submit(name, params);
        setHead(s.currentMasterSeq);
        bump();
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus({ kind: "error", message: msg });
        return msg;
      }
    },
    [bump],
  );

  const resolveConflict = useCallback((r: Resolution) => {
    setConflict((c) => {
      if (c) c.resolve(r);
      return null;
    });
    setMode("syncing");
  }, []);

  // Boot: init OPFS + open Store for the chosen peer.
  useEffect(() => {
    if (!peerId) return;
    let cancelled = false;

    (async () => {
      setMode("opening");
      setStatus({ kind: "info", message: "initializing OPFS…" });
      try {
        const sharedFs = await getSharedOpfs();
        if (cancelled) return;
        setOpfs(sharedFs);

        // Make sure the peer's root dir exists before the Store reads it.
        const root = `/${peerId}`;
        await sharedFs.fs.mkdirp(`${root}/peers`);

        const isMaster = peerId === MASTER_ID;
        setStatus({ kind: "info", message: `opening store at ${root}…` });
        const s = await Store.open({
          root,
          peerId,
          masterId: MASTER_ID,
          actions: bankActions,
        });
        if (cancelled) {
          s.close();
          return;
        }

        storeRef.current = s;
        setStore(s);
        setHead(s.currentMasterSeq);

        // Master auto-initialises the bank schema if this is a fresh dir.
        // We re-check `cancelled` around the submit: StrictMode dev runs
        // effects twice, and the first run's async IIFE keeps going even
        // after cleanup sets cancelled=true.
        if (isMaster && !cancelled) {
          const hasTable = s.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
            )
            .get();
          if (!hasTable && !cancelled) {
            await s.submit("init_bank", {});
            if (cancelled) return;
            setHead(s.currentMasterSeq);
          }
        }
        if (cancelled) return;

        setStatus({
          kind: "success",
          message: isMaster ? "opened as master" : "opened as peer",
        });
        setMode("idle");

        // Initial sync. For the master this trims acked log + squashes if
        // possible; for a peer it catches up to the master head on disk.
        void sync();
      } catch (err) {
        if (cancelled) return;
        setStatus({
          kind: "error",
          message: `open-error: ${err instanceof Error ? err.message : String(err)}`,
        });
        setMode("error");
      }
    })();

    return () => {
      cancelled = true;
      storeRef.current?.close();
      storeRef.current = null;
      setStore(null);
    };
  }, [peerId, sync]);

  return {
    store,
    opfs,
    mode,
    status,
    head,
    conflict,
    resolveConflict,
    sync,
    submit,
    bump,
    tick,
  };
}

export { OPFS_DEMO_ROOT, OPFS_CHANNEL };
