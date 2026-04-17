import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import chokidar from "chokidar";
import { Store, FileSyncLagError } from "../src/index.ts";
import type { ConflictContext, Resolver } from "../src/types.ts";
import { bankActions, type Account, type Transaction } from "./actions.ts";

type Props = {
  root: string;
  peerId: string;
  masterId: string;
  seed?: boolean;
  watchDebounceMs?: number;
  noWatch?: boolean;
};

type Mode = "idle" | "syncing" | "transfer" | "memo" | "category" | "conflict" | "retry";

type PendingConflict = {
  ctx: ConflictContext;
  resolve: (r: "drop" | "force" | "retry") => void;
};

export function App({
  root,
  peerId,
  masterId,
  seed = false,
  watchDebounceMs = 300,
  noWatch = false,
}: Props) {
  const { exit } = useApp();
  const [store, setStore] = useState<Store | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [status, setStatus] = useState("starting");
  const [head, setHead] = useState(0);
  const [mode, setMode] = useState<Mode>("idle");
  const [inputValue, setInputValue] = useState("");
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [, tick] = useState(0);
  const bump = useCallback(() => tick((x) => x + 1), []);

  const modeRef = useRef<Mode>("idle");
  const syncingRef = useRef(false);
  const storeRef = useRef<Store | null>(null);
  modeRef.current = mode;
  storeRef.current = store;

  const doSync = useCallback(async () => {
    const s = storeRef.current;
    if (!s || syncingRef.current) return;
    syncingRef.current = true;
    setMode("syncing");
    try {
      const resolver: Resolver = (ctx) =>
        new Promise<"drop" | "force" | "retry">((resolve) => {
          setConflict({ ctx, resolve });
          setMode("conflict");
        });
      const report = await s.sync({ onConflict: resolver });
      setHead(s.currentMasterSeq);
      setStatus(
        `synced applied=${report.applied} skipped=${report.skipped} dropped=${report.dropped} forced=${report.forced}` +
          (report.squashedTo !== undefined ? ` squashedTo=${report.squashedTo}` : ""),
      );
      setMode("idle");
      setConflict(null);
      bump();
    } catch (err) {
      if (err instanceof FileSyncLagError) {
        setStatus(
          `file-sync-lag snapshotHead=${err.snapshotHead} declared=${err.declaredSnapshotHead}`,
        );
      } else {
        setStatus(`sync-error: ${err instanceof Error ? err.message : String(err)}`);
      }
      setMode("idle");
      setConflict(null);
    } finally {
      syncingRef.current = false;
    }
  }, [bump]);

  // Open store on mount.
  useEffect(() => {
    try {
      const s = Store.open({ root, peerId, masterId, actions: bankActions });
      storeRef.current = s;
      setStore(s);
      setHead(s.currentMasterSeq);
      if (seed && s.isMaster) {
        const hasAccounts = s.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
          )
          .get();
        if (!hasAccounts) {
          s.submit("init_bank", {});
          s.submit("open_account", { id: "checking", initial: 100 });
          s.submit("open_account", { id: "savings", initial: 200 });
          s.submit("open_account", { id: "external", initial: 0 });
          setHead(s.currentMasterSeq);
        }
      }
      setStatus("opened");
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      storeRef.current?.close();
      storeRef.current = null;
    };
  }, [root, peerId, masterId, seed]);

  // Initial sync after open.
  useEffect(() => {
    if (store) {
      void doSync();
    }
  }, [store, doSync]);

  // File watcher — Syncthing/rsync/whatever delivers updates; we debounce and re-sync.
  useEffect(() => {
    if (!store || noWatch) return;
    let timer: NodeJS.Timeout | null = null;
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 30, pollInterval: 20 },
    });
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (modeRef.current === "idle" || modeRef.current === "syncing") {
          void doSync();
        }
      }, watchDebounceMs);
    };
    watcher.on("all", onChange);
    return () => {
      void watcher.close();
      if (timer) clearTimeout(timer);
    };
  }, [store, root, doSync, watchDebounceMs, noWatch]);

  useInput((raw, key) => {
    if (openError) {
      if (raw === "q") exit();
      return;
    }
    if (!store) return;
    if (mode === "idle") {
      if (raw === "q") exit();
      if (raw === "s") void doSync();
      if (raw === "t") {
        setInputValue("");
        setMode("transfer");
      }
      if (raw === "m") {
        setInputValue("");
        setMode("memo");
      }
      if (raw === "c") {
        setInputValue("");
        setMode("category");
      }
    } else if (mode === "transfer" || mode === "memo" || mode === "category") {
      if (key.escape) {
        setMode("idle");
        setInputValue("");
      }
    } else if (mode === "conflict" && conflict) {
      if (raw === "d") {
        conflict.resolve("drop");
        setConflict(null);
        setMode("syncing");
      } else if (raw === "f") {
        conflict.resolve("force");
        setConflict(null);
        setMode("syncing");
      } else if (raw === "r") {
        setInputValue("");
        setMode("retry");
      }
    } else if (mode === "retry") {
      if (key.escape) {
        setInputValue("");
        setMode("conflict");
      }
    }
  });

  if (openError) {
    return (
      <Box flexDirection="column">
        <Text>PEER={peerId} MASTER={masterId}</Text>
        <Text color="red">OPEN-ERROR {openError}</Text>
        <Text dimColor>[q]uit</Text>
      </Box>
    );
  }
  if (!store) return <Text>opening…</Text>;

  const tablesExist =
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
      .get() !== undefined;
  const accounts: Account[] = tablesExist
    ? (store.db.prepare("SELECT id, balance FROM accounts ORDER BY id").all() as Account[])
    : [];
  const txs: Transaction[] = tablesExist
    ? (store.db.prepare("SELECT * FROM transactions ORDER BY ts").all() as Transaction[])
    : [];
  const pendingActions = store.isMaster
    ? []
    : store.peerLog.filter((e) => e.kind === "action");

  return (
    <Box flexDirection="column">
      <Text>
        PEER={peerId} MASTER={masterId} HEAD={head} MODE={mode}
      </Text>
      <Text>STATUS={status}</Text>
      <Text>-- accounts ({accounts.length}) --</Text>
      {accounts.map((a) => (
        <Text key={a.id}>
          ACCT {a.id} {a.balance}
        </Text>
      ))}
      <Text>-- transactions ({txs.length}) --</Text>
      {txs.slice(-10).map((t) => (
        <Text key={t.id}>
          TX {t.id} {t.acc_from}-&gt;{t.acc_to} {t.amount}
          {t.memo ? ` memo=${JSON.stringify(t.memo)}` : ""}
          {t.category ? ` cat=${t.category}` : ""}
        </Text>
      ))}
      <Text>-- pending ({pendingActions.length}) --</Text>
      {pendingActions.map((e) =>
        e.kind === "action" ? (
          <Text key={e.seq}>
            PENDING seq={e.seq} {e.name} base={e.baseMasterSeq}
            {e.force ? " FORCE" : ""}
          </Text>
        ) : null,
      )}

      {mode === "transfer" && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan">
          <Text>TRANSFER-FORM: "txId from to amount"  Enter=submit  Esc=cancel</Text>
          <Box>
            <Text>&gt; </Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={(val) => {
                const parts = val.trim().split(/\s+/);
                if (parts.length !== 4) {
                  setStatus(`bad-transfer-input "${val}"`);
                  setMode("idle");
                  setInputValue("");
                  return;
                }
                const [txId, from, to, amountStr] = parts;
                try {
                  store.submit("transfer", {
                    txId,
                    from,
                    to,
                    amount: Number(amountStr),
                    ts: new Date().toISOString(),
                  });
                  setStatus(`submitted ${txId}`);
                } catch (err) {
                  setStatus(
                    `submit-failed ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
                setMode("idle");
                setInputValue("");
                bump();
              }}
            />
          </Box>
        </Box>
      )}

      {mode === "memo" && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan">
          <Text>MEMO-FORM: "txId new-memo words…"  Enter=submit  Esc=cancel</Text>
          <Box>
            <Text>&gt; </Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={(val) => {
                const idx = val.indexOf(" ");
                if (idx < 0) {
                  setStatus(`bad-memo-input "${val}"`);
                  setMode("idle");
                  setInputValue("");
                  return;
                }
                const txId = val.slice(0, idx).trim();
                const memo = val.slice(idx + 1);
                try {
                  store.submit("update_memo", { txId, memo });
                  setStatus(`memo-updated ${txId}`);
                } catch (err) {
                  setStatus(
                    `memo-failed ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
                setMode("idle");
                setInputValue("");
                bump();
              }}
            />
          </Box>
        </Box>
      )}

      {mode === "category" && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan">
          <Text>CATEGORY-FORM: "txId category"  Enter=submit  Esc=cancel</Text>
          <Box>
            <Text>&gt; </Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={(val) => {
                const parts = val.trim().split(/\s+/);
                if (parts.length !== 2) {
                  setStatus(`bad-category-input "${val}"`);
                  setMode("idle");
                  setInputValue("");
                  return;
                }
                const [txId, category] = parts;
                try {
                  store.submit("update_category", { txId, category });
                  setStatus(`category-updated ${txId}`);
                } catch (err) {
                  setStatus(
                    `category-failed ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
                setMode("idle");
                setInputValue("");
                bump();
              }}
            />
          </Box>
        </Box>
      )}

      {mode === "conflict" && conflict && (
        <Box flexDirection="column" borderStyle="single" borderColor="red">
          <Text>CONFLICT kind={conflict.ctx.kind}</Text>
          <Text>
            ACTION {conflict.ctx.action.name} {JSON.stringify(conflict.ctx.action.params)}
          </Text>
          {conflict.ctx.error && <Text>ERR {conflict.ctx.error.message}</Text>}
          <Text>[d]rop [f]orce [r]etry</Text>
        </Box>
      )}

      {mode === "retry" && conflict && (
        <Box flexDirection="column" borderStyle="single" borderColor="yellow">
          <Text>RETRY-FORM: "txId from to amount"  Enter=prepend+retry  Esc=back</Text>
          <Box>
            <Text>&gt; </Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={(val) => {
                const parts = val.trim().split(/\s+/);
                if (parts.length !== 4) {
                  setStatus(`bad-retry-input "${val}"`);
                  return;
                }
                const [txId, from, to, amountStr] = parts;
                try {
                  conflict.ctx.submit("transfer", {
                    txId,
                    from,
                    to,
                    amount: Number(amountStr),
                    ts: new Date().toISOString(),
                  });
                  setStatus(`prepended ${txId}; retrying`);
                  conflict.resolve("retry");
                  setConflict(null);
                  setMode("syncing");
                  setInputValue("");
                } catch (err) {
                  setStatus(
                    `prepend-failed ${err instanceof Error ? err.message : String(err)}`,
                  );
                  setInputValue("");
                }
              }}
            />
          </Box>
        </Box>
      )}

      <Text dimColor>
        [s]ync [t]ransfer [m]emo [c]ategory [q]uit (conflict: [d]/[f]/[r])
      </Text>
    </Box>
  );
}
