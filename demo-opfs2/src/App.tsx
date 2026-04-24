import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert } from "@/components/ui/alert";
import { PeerGate, MASTER_ID, type PeerGateChoice } from "@/components/PeerGate";
import { TopBar } from "@/components/TopBar";
import { BalanceStrip } from "@/components/BalanceStrip";
import { AccountsTab } from "@/components/AccountsTab";
import { CategoriesTab } from "@/components/CategoriesTab";
import { TransactionsTab } from "@/components/TransactionsTab";
import { FormDialog, type FormSpec } from "@/components/FormDialog";
import {
  NewTransactionDialog,
  type NewTxValues,
} from "@/components/NewTransactionDialog";
import {
  EditTransactionDialog,
  type EditTxChanges,
} from "@/components/EditTransactionDialog";
import { ConflictBar } from "@/components/ConflictBar";
import { SyncMenu } from "@/components/SyncMenu";
import { HistorySidebar } from "@/components/HistorySidebar";
import { StatsPanel } from "@/components/StatsPanel";
import { CategoryBreakdown } from "@/components/CategoryBreakdown";
import { SqlConsole } from "@/components/SqlConsole";
import { useStore, OPFS_DEMO_ROOT } from "@/hooks/use-store";
import { useWatcher } from "@/hooks/use-watcher";
import { useMasterLog } from "@/hooks/use-action-log";
import { useOrm } from "@/hooks/use-orm";
import { useBankQuery } from "@/hooks/use-sql-query";
import {
  applySyncPlan,
  diffPeers,
  listPeerDirs,
  listPeerFiles,
} from "@/lib/peer-dirs";
import { genId, nowTs } from "@/lib/id";
import { seedBank } from "@/lib/seed";
import type {
  AccountRow,
  CategoryRow,
  TransactionRow,
} from "@/lib/orm-entities";

type Tab = "transactions" | "accounts" | "categories";

const PEER_KEY = "sql-git:opfs2:peer";
const SEED_PENDING_KEY = "sql-git:opfs2:seedPending";

/**
 * Reads from the reactive ORM are tracked via MobX observables. Leaf
 * components that care about auto-rerender (StatsPanel, CategoryBreakdown)
 * are wrapped with `observer` themselves. For the App-level queries we
 * bump the `tick` counter on submit/sync and refetch imperatively — that
 * avoids wrapping the whole App in a MobX reaction, which clashes with
 * React 18's concurrent rendering model in subtle ways (infinite loops
 * on first sqlQuery creation if the MobX reaction fires mid-render).
 */
function App() {
  const [peerId, setPeerId] = useState<string | null>(() =>
    sessionStorage.getItem(PEER_KEY),
  );
  const [knownPeers, setKnownPeers] = useState<string[]>([]);

  const {
    store,
    opfs,
    mode,
    status,
    head,
    conflict,
    resolveConflict,
    sync,
    submit,
    resetPeerDir,
    tick,
  } = useStore(peerId);

  const orm = useOrm(store, conflict, tick, head);

  // Auto-sync on remote events for this peer's dir.
  const { events } = useWatcher({
    opfs,
    peerDir: peerId ? `/${peerId}` : "/",
    peerId: peerId ?? "",
    isMaster: peerId === MASTER_ID,
    onRemoteWrite: () => {
      void sync();
    },
  });

  // Scan OPFS for peer dirs so the gate can show "existing" badges.
  useEffect(() => {
    (async () => {
      if (!opfs) return;
      try {
        const ids = await listPeerDirs(opfs.fs, opfs.path, "/");
        setKnownPeers(ids);
      } catch {
        /* non-fatal — gate still works */
      }
    })();
  }, [opfs, tick, peerId]);

  // Track tab + transient UI state.
  const [tab, setTab] = useState<Tab>("transactions");
  const [form, setForm] = useState<FormSpec | null>(null);
  const [newTxOpen, setNewTxOpen] = useState(false);
  const [editTx, setEditTx] = useState<TransactionRow | null>(null);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [fileSyncing, setFileSyncing] = useState(false);
  const [fileSyncMsg, setFileSyncMsg] = useState<{
    kind: "success" | "warning" | "error";
    message: string;
  } | null>(null);

  // All row reads go through the reactive ORM. The driver is backed by a
  // getter that returns `store.db` normally, or `conflict.ctx.rebasedDb`
  // during conflict resolution, so queued mitigations preview live.
  // Check if the bank schema exists (master always auto-bootstraps, peer
  // waits for a file-sync to deliver snapshot+master log). We query
  // sqlite_master directly through the ORM's raw driver — Kysely's typed
  // builder doesn't know about the catalog so a string is cleaner here.
  const [tablesExist, setTablesExist] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!orm) {
        setTablesExist(false);
        return;
      }
      try {
        const rows = await orm.driver.all<{ n: number }>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='accounts'",
        );
        if (!cancelled) setTablesExist((rows[0]?.n ?? 0) > 0);
      } catch {
        if (!cancelled) setTablesExist(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orm, tick, head]);

  // Only run bank-table queries once the schema is in place; before that
  // `SELECT * FROM accounts` raises "no such table" and our SqlQuery
  // settles as rejected (benign, but noisy).
  const queriableOrm = tablesExist ? orm : null;
  const accountsQ = useBankQuery<AccountRow>(
    queriableOrm,
    (db) => db.selectFrom("accounts").selectAll().orderBy("created_at"),
    [tick],
  );
  const categoriesQ = useBankQuery<CategoryRow>(
    queriableOrm,
    (db) => db.selectFrom("categories").selectAll().orderBy("created_at"),
    [tick],
  );
  const transactionsQ = useBankQuery<TransactionRow>(
    queriableOrm,
    (db) => db.selectFrom("transactions").selectAll().orderBy("ts"),
    [tick],
  );

  const accounts = tablesExist ? accountsQ.rows : [];
  const categories = tablesExist ? categoriesQ.rows : [];
  const transactions = tablesExist ? transactionsQ.rows : [];

  const pendingCount = store && !store.isMaster
    ? store.peerLog.filter((e) => e.kind === "action").length
    : 0;

  // Master log for the history sidebar. Reads the on-disk jsonl so peer tabs
  // see it too after file-sync brings the master's log into their dir.
  const masterLog = useMasterLog(opfs, peerId ? `/${peerId}` : "", MASTER_ID, tick);

  // ─── form builders (account + category CRUD only) ─────────────────────

  const newAccountForm: FormSpec = useMemo(
    () => ({
      title: "New account",
      description: "Display-name only — ID is auto-generated.",
      submitLabel: "Create",
      fields: [{ type: "text", key: "name", label: "Name", placeholder: "Checking" }],
      onSubmit: async (v) => {
        const id = genId("acc");
        return submit("create_account", { id, name: v.name, ts: nowTs() });
      },
    }),
    [submit],
  );

  const newCategoryForm: FormSpec = useMemo(
    () => ({
      title: "New category",
      submitLabel: "Create",
      fields: [
        { type: "text", key: "name", label: "Name", placeholder: "Groceries" },
        {
          type: "select",
          key: "kind",
          label: "Kind",
          options: [
            { label: "income", value: "income" },
            { label: "expense", value: "expense" },
            { label: "both", value: "both" },
          ],
        },
      ],
      onSubmit: async (v) => {
        const id = genId("cat");
        return submit("create_category", {
          id,
          name: v.name,
          kind: v.kind as "income" | "expense" | "both",
          ts: nowTs(),
        });
      },
    }),
    [submit],
  );

  const renameAccountForm = (acc: AccountRow): FormSpec => ({
    title: `Rename ${acc.name}`,
    submitLabel: "Save",
    fields: [{ type: "text", key: "name", label: "New name", initial: acc.name }],
    onSubmit: async (v) => {
      if (v.name === acc.name) return null;
      return submit("rename_account", { id: acc.id, name: v.name });
    },
  });

  const renameCategoryForm = (cat: CategoryRow): FormSpec => ({
    title: `Rename ${cat.name}`,
    submitLabel: "Save",
    fields: [{ type: "text", key: "name", label: "New name", initial: cat.name }],
    onSubmit: async (v) => {
      if (v.name === cat.name) return null;
      return submit("rename_category", { id: cat.id, name: v.name });
    },
  });

  // ─── transaction handlers ─────────────────────────────────────────────

  const onNewTxSubmit = async (v: NewTxValues): Promise<string | null> => {
    if (v.kind === "income") {
      return submit("create_income", {
        id: genId("inc"),
        acc_to: v.acc_to,
        amount: v.amount,
        category_id: v.category_id,
        memo: v.memo ?? "",
        ts: nowTs(),
      });
    }
    if (v.kind === "expense") {
      return submit("create_expense", {
        id: genId("exp"),
        acc_from: v.acc_from,
        amount: v.amount,
        category_id: v.category_id,
        memo: v.memo ?? "",
        ts: nowTs(),
      });
    }
    return submit("create_transfer", {
      id: genId("tr"),
      acc_from: v.acc_from,
      acc_to: v.acc_to,
      amount: v.amount,
      memo: v.memo ?? "",
      ts: nowTs(),
    });
  };

  const onEditTxSubmit = async (
    id: string,
    changes: EditTxChanges,
  ): Promise<string | null> => {
    if (changes.amount !== undefined) {
      const err = await submit("edit_tx_amount", { id, amount: changes.amount });
      if (err) return err;
    }
    if (changes.memo !== undefined) {
      const err = await submit("edit_tx_memo", { id, memo: changes.memo });
      if (err) return err;
    }
    if (changes.category_id !== undefined) {
      const err = await submit("edit_tx_category", {
        id,
        category_id: changes.category_id,
      });
      if (err) return err;
    }
    return null;
  };

  const confirmAndSubmit = async (msg: string, action: () => Promise<string | null>) => {
    if (!confirm(msg)) return;
    // Errors from `submit` already surface in the top-bar status alert via
    // use-store, so we just fire-and-forget here.
    await action();
  };

  // ─── quick file-sync (no modal) ───────────────────────────────────────

  const runFileSync = useCallback(
    async (targets: string[]) => {
      if (!opfs || !peerId) return;
      const selfDir = `/${peerId}`;
      let transferred = 0;
      let touchedSelf = false;
      for (const other of targets) {
        if (other === peerId) continue;
        // Re-read selfFiles each iteration — an earlier peer in `targets`
        // may have pushed new files into selfDir that the next peer needs.
        const selfFiles = await listPeerFiles(opfs.fs, opfs.path, selfDir);
        const otherDir = `/${other}`;
        const otherFiles = await listPeerFiles(opfs.fs, opfs.path, otherDir);
        const plan = diffPeers(selfFiles, otherFiles, peerId, other, MASTER_ID);
        await applySyncPlan(opfs.fs, opfs.path, selfDir, otherDir, plan);
        transferred += plan.aToB.length + plan.bToA.length;
        if (plan.bToA.length > 0) touchedSelf = true;
      }
      return { transferred, touchedSelf, targetCount: targets.length };
    },
    [opfs, peerId],
  );

  const onFileSync = useCallback(async () => {
    if (!opfs || !peerId) return;
    setFileSyncing(true);
    setFileSyncMsg(null);
    try {
      const ids = await listPeerDirs(opfs.fs, opfs.path, "/");
      let targets: string[];
      if (peerId === MASTER_ID) {
        targets = ids.filter((id) => id !== MASTER_ID);
      } else if (ids.includes(MASTER_ID)) {
        targets = [MASTER_ID];
      } else {
        setFileSyncMsg({
          kind: "warning",
          message:
            "no master dir on disk yet — open another tab as 'master' to create it",
        });
        return;
      }
      if (targets.length === 0) {
        setFileSyncMsg({
          kind: "warning",
          message: "no other peer dirs on disk — open another tab as a different peer",
        });
        return;
      }
      const r = await runFileSync(targets);
      if (!r) return;
      if (r.transferred === 0) {
        setFileSyncMsg({
          kind: "success",
          message:
            r.targetCount === 1
              ? `already in sync with ${targets[0]}`
              : `already in sync with ${r.targetCount} peer(s)`,
        });
      } else {
        setFileSyncMsg({
          kind: "success",
          message:
            r.targetCount === 1
              ? `synced with ${targets[0]}: ${r.transferred} file(s) moved`
              : `synced with ${r.targetCount} peer(s): ${r.transferred} file(s) moved`,
        });
      }
      if (r.touchedSelf) void sync();
    } catch (err) {
      setFileSyncMsg({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setFileSyncing(false);
    }
  }, [opfs, peerId, runFileSync, sync]);

  // ─── misc ─────────────────────────────────────────────────────────────

  const pickPeer = ({ peerId: id, seed }: PeerGateChoice) => {
    sessionStorage.setItem(PEER_KEY, id);
    if (seed) sessionStorage.setItem(SEED_PENDING_KEY, "1");
    else sessionStorage.removeItem(SEED_PENDING_KEY);
    setPeerId(id);
  };

  const switchPeer = () => {
    sessionStorage.removeItem(PEER_KEY);
    sessionStorage.removeItem(SEED_PENDING_KEY);
    setPeerId(null);
  };

  const resetPeer = async () => {
    if (!peerId) return;
    const isMaster = peerId === MASTER_ID;
    const msg = isMaster
      ? `Reset '${peerId}' (MASTER)?\n\nThis wipes the master dir — every other peer will need to re-sync before they see any data. All master state is lost.`
      : `Reset peer '${peerId}'?\n\nThis wipes this peer's OPFS dir. Any unsynced local actions are lost; a fresh snapshot will be pulled from the master on next file-sync.`;
    if (!confirm(msg)) return;
    await resetPeerDir();
    sessionStorage.removeItem(PEER_KEY);
    sessionStorage.removeItem(SEED_PENDING_KEY);
    setPeerId(null);
  };

  // Seed once per tab lifetime: consume the flag as soon as the store is
  // open AND the schema is in place (master is auto-bootstrapped on open;
  // a non-master needs a file-sync first, after which this effect fires).
  // A ref guards against concurrent re-runs during the async seed burst.
  const seedingRef = useRef(false);
  useEffect(() => {
    if (!store || !tablesExist) return;
    if (sessionStorage.getItem(SEED_PENDING_KEY) !== "1") return;
    if (seedingRef.current) return;
    seedingRef.current = true;
    sessionStorage.removeItem(SEED_PENDING_KEY);
    (async () => {
      const err = await seedBank(submit);
      seedingRef.current = false;
      if (err) console.error("seed failed:", err);
    })();
  }, [store, tablesExist, submit]);

  // ─── render ────────────────────────────────────────────────────────────

  if (!peerId) {
    return <PeerGate onSelect={pickPeer} knownPeers={knownPeers} />;
  }

  const showSchemaWaiting = !!store && !tablesExist && peerId !== MASTER_ID;

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        peerId={peerId}
        masterId={MASTER_ID}
        head={head}
        mode={mode}
        status={status}
        pending={pendingCount}
        fileSyncing={fileSyncing}
        onSync={() => void sync()}
        onFileSync={() => void onFileSync()}
        onOpenSyncMenu={() => setSyncMenuOpen(true)}
        onSwitchPeer={switchPeer}
        onResetPeer={() => void resetPeer()}
      />
      <BalanceStrip accounts={accounts} />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex min-w-0 flex-1 flex-col overflow-auto p-4">
            {fileSyncMsg ? (
              <Alert
                variant={
                  fileSyncMsg.kind === "success"
                    ? "success"
                    : fileSyncMsg.kind === "warning"
                      ? "warning"
                      : "destructive"
                }
                className="mb-3 text-xs"
              >
                {fileSyncMsg.message}
              </Alert>
            ) : null}
            {showSchemaWaiting ? (
              <Alert variant="info" className="mb-3">
                No schema on disk yet. Click{" "}
                <span className="font-mono">File-sync</span> in the top bar to pull
                from <span className="font-mono">{MASTER_ID}</span>, or open the{" "}
                <button
                  className="underline underline-offset-2 hover:text-primary"
                  onClick={() => setSyncMenuOpen(true)}
                >
                  peers menu
                </button>{" "}
                for detailed control.
              </Alert>
            ) : null}

            {tablesExist ? (
              <div className="mb-4 space-y-3">
                <StatsPanel orm={orm} />
                <CategoryBreakdown orm={orm} />
              </div>
            ) : null}

            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
              <TabsList>
                <TabsTrigger value="transactions">Transactions</TabsTrigger>
                <TabsTrigger value="accounts">Accounts</TabsTrigger>
                <TabsTrigger value="categories">Categories</TabsTrigger>
              </TabsList>
              <TabsContent value="transactions" className="mt-4">
                <TransactionsTab
                  transactions={transactions}
                  accounts={accounts}
                  categories={categories}
                  onNew={() => {
                    if (accounts.length === 0) {
                      alert("create an account first");
                      return;
                    }
                    setNewTxOpen(true);
                  }}
                  onEdit={(tx) => setEditTx(tx)}
                  onDelete={(tx) =>
                    void confirmAndSubmit(`Delete transaction ${tx.id}?`, () =>
                      submit("delete_transaction", { id: tx.id }),
                    )
                  }
                />
              </TabsContent>
              <TabsContent value="accounts" className="mt-4">
                <AccountsTab
                  accounts={accounts}
                  onNew={() => setForm(newAccountForm)}
                  onRename={(a) => setForm(renameAccountForm(a))}
                  onDelete={(a) =>
                    void confirmAndSubmit(
                      `Delete account "${a.name}"?\nAccounts with linked transactions can't be deleted.`,
                      () => submit("delete_account", { id: a.id }),
                    )
                  }
                />
              </TabsContent>
              <TabsContent value="categories" className="mt-4">
                <CategoriesTab
                  categories={categories}
                  onNew={() => setForm(newCategoryForm)}
                  onRename={(c) => setForm(renameCategoryForm(c))}
                  onDelete={(c) =>
                    void confirmAndSubmit(`Delete category "${c.name}"?`, () =>
                      submit("delete_category", { id: c.id }),
                    )
                  }
                />
              </TabsContent>
            </Tabs>

            <footer className="mt-6 border-t pt-3 text-[11px] text-muted-foreground">
              OPFS root{" "}
              <code className="rounded bg-muted px-1">/{OPFS_DEMO_ROOT}</code> ·
              peer dir{" "}
              <code className="rounded bg-muted px-1">/{peerId}</code> · reads go
              through <code className="rounded bg-muted px-1">sql-reactive-orm</code>,
              mutations through sql-git actions.
            </footer>
          </main>

          {conflict ? (
            <ConflictBar conflict={conflict} onResolve={resolveConflict} />
          ) : null}
        </div>

        <HistorySidebar
          masterLog={store?.isMaster ? store.masterLog : masterLog}
          peerLog={store?.isMaster ? [] : (store?.peerLog ?? [])}
          queued={conflict?.queued ?? []}
          events={events}
          peerId={peerId}
        />
      </div>

      <FormDialog
        key={form?.title ?? "closed"}
        spec={form}
        open={form !== null}
        onClose={() => setForm(null)}
      />
      <NewTransactionDialog
        open={newTxOpen}
        onClose={() => setNewTxOpen(false)}
        accounts={accounts}
        categories={categories}
        onSubmit={onNewTxSubmit}
      />
      <EditTransactionDialog
        tx={editTx}
        open={editTx !== null}
        onClose={() => setEditTx(null)}
        categories={categories}
        onSubmit={onEditTxSubmit}
      />
      <SyncMenu
        open={syncMenuOpen}
        onClose={() => setSyncMenuOpen(false)}
        opfs={opfs}
        currentPeerId={peerId}
        masterId={MASTER_ID}
        onTransferAffectsCurrent={() => void sync()}
      />
      <SqlConsole orm={orm} submit={submit} ready={tablesExist && !!store} />
    </div>
  );
}

export default App;
