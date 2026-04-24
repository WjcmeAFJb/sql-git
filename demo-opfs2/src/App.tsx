import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert } from "@/components/ui/alert";
import { PeerGate, MASTER_ID, type PeerGateChoice } from "@/components/PeerGate";
import { TopBar } from "@/components/TopBar";
import { BalanceStrip } from "@/components/BalanceStrip";
import { AccountsTab } from "@/components/AccountsTab";
import { CategoriesTab } from "@/components/CategoriesTab";
import { TransactionsTab } from "@/components/TransactionsTab";
import { Wizard, type FormSpec, unsentinelSelectValue } from "@/components/Wizard";
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
import { listPeerDirs } from "@/lib/peer-dirs";
import { genId, nowTs } from "@/lib/id";
import { seedBank } from "@/lib/seed";
import type { AccountRow, CategoryRow, TransactionRow } from "@/lib/orm-entities";

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
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);

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

  const accountOptions = accounts.map((a) => ({
    label: `${a.name} (${a.id}) · $${a.balance}`,
    value: a.id,
  }));
  const categoryOptions = useCallback(
    (includeNone = true) => {
      const opts = categories.map((c) => ({
        label: `${c.name} [${c.kind}]`,
        value: c.id,
      }));
      return includeNone ? [{ label: "— none —", value: "" }, ...opts] : opts;
    },
    [categories],
  );
  const txOptions = transactions.slice(-20).map((t) => ({
    label: `${t.id} · ${t.kind} · $${t.amount}${t.memo ? " · " + t.memo.slice(0, 20) : ""}`,
    value: t.id,
  }));

  // ─── form builders ─────────────────────────────────────────────────────

  const newAccount: FormSpec = {
    title: "New account",
    description: "Display-name only — ID is auto-generated.",
    fields: [{ type: "text", key: "name", label: "Name", placeholder: "Checking" }],
    onSubmit: async (v) => {
      const id = genId("acc");
      return submit("create_account", { id, name: v.name, ts: nowTs() });
    },
  };

  const renameAccount = (): FormSpec | null => {
    if (accounts.length === 0) return null;
    return {
      title: "Rename account",
      fields: [
        { type: "select", key: "id", label: "Account", options: accountOptions },
        { type: "text", key: "name", label: "New name" },
      ],
      onSubmit: async (v) => {
        const id = unsentinelSelectValue(v.id);
        const acc = accounts.find((a) => a.id === id);
        if (!acc) return "account not found";
        if (v.name === acc.name) return "unchanged";
        return submit("rename_account", { id, name: v.name });
      },
    };
  };

  const deleteAccount = (): FormSpec | null => {
    if (accounts.length === 0) return null;
    return {
      title: "Delete account",
      description: "Accounts with linked transactions can't be deleted.",
      fields: [{ type: "select", key: "id", label: "Account", options: accountOptions }],
      onSubmit: async (v) =>
        submit("delete_account", { id: unsentinelSelectValue(v.id) }),
    };
  };

  const newCategory: FormSpec = {
    title: "New category",
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
  };

  const renameCategory = (): FormSpec | null => {
    if (categories.length === 0) return null;
    return {
      title: "Rename category",
      fields: [
        {
          type: "select",
          key: "id",
          label: "Category",
          options: categoryOptions(false),
        },
        { type: "text", key: "name", label: "New name" },
      ],
      onSubmit: async (v) => {
        const id = unsentinelSelectValue(v.id);
        const cat = categories.find((c) => c.id === id);
        if (!cat) return "category not found";
        if (v.name === cat.name) return "unchanged";
        return submit("rename_category", { id, name: v.name });
      },
    };
  };

  const deleteCategory = (): FormSpec | null => {
    if (categories.length === 0) return null;
    return {
      title: "Delete category",
      fields: [
        {
          type: "select",
          key: "id",
          label: "Category",
          options: categoryOptions(false),
        },
      ],
      onSubmit: async (v) =>
        submit("delete_category", { id: unsentinelSelectValue(v.id) }),
    };
  };

  const newTransaction = (kind: "income" | "expense" | "transfer"): FormSpec | null => {
    if (kind === "transfer" && accounts.length < 2) return null;
    if (kind !== "transfer" && accounts.length === 0) return null;
    if (kind === "income") {
      return {
        title: "New income",
        description: "Cash in: increases one account's balance.",
        fields: [
          { type: "number", key: "amount", label: "Amount", min: 1 },
          {
            type: "select",
            key: "acc_to",
            label: "Into account",
            options: accountOptions,
          },
          {
            type: "select",
            key: "category_id",
            label: "Category",
            options: categoryOptions(true),
          },
          { type: "text", key: "memo", label: "Memo", optional: true },
        ],
        onSubmit: async (v) =>
          submit("create_income", {
            id: genId("inc"),
            acc_to: unsentinelSelectValue(v.acc_to),
            amount: Number(v.amount),
            category_id: unsentinelSelectValue(v.category_id) || null,
            memo: v.memo ?? "",
            ts: nowTs(),
          }),
      };
    }
    if (kind === "expense") {
      return {
        title: "New expense",
        description: "Cash out: deducts from one account. Balance can't go negative.",
        fields: [
          { type: "number", key: "amount", label: "Amount", min: 1 },
          {
            type: "select",
            key: "acc_from",
            label: "From account",
            options: accountOptions,
          },
          {
            type: "select",
            key: "category_id",
            label: "Category",
            options: categoryOptions(true),
          },
          { type: "text", key: "memo", label: "Memo", optional: true },
        ],
        onSubmit: async (v) =>
          submit("create_expense", {
            id: genId("exp"),
            acc_from: unsentinelSelectValue(v.acc_from),
            amount: Number(v.amount),
            category_id: unsentinelSelectValue(v.category_id) || null,
            memo: v.memo ?? "",
            ts: nowTs(),
          }),
      };
    }
    return {
      title: "New transfer",
      description: "Move funds between two of your accounts.",
      fields: [
        { type: "number", key: "amount", label: "Amount", min: 1 },
        { type: "select", key: "acc_from", label: "From", options: accountOptions },
        { type: "select", key: "acc_to", label: "To", options: accountOptions },
        { type: "text", key: "memo", label: "Memo", optional: true },
      ],
      onSubmit: async (v) => {
        const from = unsentinelSelectValue(v.acc_from);
        const to = unsentinelSelectValue(v.acc_to);
        if (from === to) return "from and to must differ";
        return submit("create_transfer", {
          id: genId("tr"),
          acc_from: from,
          acc_to: to,
          amount: Number(v.amount),
          memo: v.memo ?? "",
          ts: nowTs(),
        });
      },
    };
  };

  const KEEP = "__keep__";
  const editTx = (): FormSpec | null => {
    if (transactions.length === 0) return null;
    return {
      title: "Edit transaction",
      description: "Pick one, then walk through amount, memo, and category.",
      fields: [{ type: "select", key: "id", label: "Transaction", options: txOptions }],
      onSubmit: async (v) => {
        const id = unsentinelSelectValue(v.id);
        const tx = transactions.find((t) => t.id === id);
        if (!tx) return "not found";
        setTimeout(() => setForm(editTxFields(tx)), 0);
        return null;
      },
    };
  };

  const editTxFields = (tx: TransactionRow): FormSpec => {
    const catOpts = [
      { label: "— keep current —", value: KEEP },
      { label: "— none —", value: "" },
      ...categories.map((c) => ({ label: `${c.name} [${c.kind}]`, value: c.id })),
    ];
    return {
      title: `Edit ${tx.id}`,
      fields: [
        {
          type: "text",
          key: "amount",
          label: `Amount (current $${tx.amount}; blank = keep)`,
          optional: true,
        },
        {
          type: "text",
          key: "memo",
          label: tx.memo
            ? `Memo (current: ${JSON.stringify(tx.memo)}; blank = keep)`
            : "Memo (blank = keep empty)",
          optional: true,
        },
        {
          type: "select",
          key: "category_id",
          label: `Category (current: ${
            tx.category_id
              ? (categories.find((c) => c.id === tx.category_id)?.name ?? tx.category_id)
              : "—"
          })`,
          options: catOpts,
        },
      ],
      onSubmit: async (v) => {
        const changes: string[] = [];
        if (v.amount) {
          const newAmount = Number(v.amount);
          if (!Number.isFinite(newAmount) || newAmount <= 0) {
            return "amount must be a positive number";
          }
          if (newAmount !== tx.amount) {
            const err = await submit("edit_tx_amount", { id: tx.id, amount: newAmount });
            if (err) return err;
            changes.push("amount");
          }
        }
        if (v.memo && v.memo !== tx.memo) {
          const err = await submit("edit_tx_memo", { id: tx.id, memo: v.memo });
          if (err) return err;
          changes.push("memo");
        }
        const rawCat = unsentinelSelectValue(v.category_id);
        if (rawCat !== KEEP) {
          const newCat = rawCat || null;
          if (newCat !== tx.category_id) {
            const err = await submit("edit_tx_category", {
              id: tx.id,
              category_id: newCat,
            });
            if (err) return err;
            changes.push("category");
          }
        }
        return null;
      },
    };
  };

  const deleteTx = (): FormSpec | null => {
    if (transactions.length === 0) return null;
    return {
      title: "Delete transaction",
      fields: [{ type: "select", key: "id", label: "Transaction", options: txOptions }],
      onSubmit: async (v) =>
        submit("delete_transaction", { id: unsentinelSelectValue(v.id) }),
    };
  };

  const openForm = (f: FormSpec | null) => {
    if (!f) return;
    setForm(f);
  };

  const onNewTxKind = (kind: "income" | "expense" | "transfer") => {
    const f = newTransaction(kind);
    if (!f) {
      alert(
        kind === "transfer"
          ? "need at least two accounts for a transfer"
          : "create an account first",
      );
      return;
    }
    setForm(f);
  };

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
        onSync={() => void sync()}
        onOpenSyncMenu={() => setSyncMenuOpen(true)}
        onSwitchPeer={switchPeer}
      />
      <BalanceStrip accounts={accounts} />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex min-w-0 flex-1 flex-col overflow-auto p-4">
            {showSchemaWaiting ? (
              <Alert variant="info" className="mb-3">
                No schema on disk yet. Open the{" "}
                <button
                  className="underline underline-offset-2 hover:text-primary"
                  onClick={() => setSyncMenuOpen(true)}
                >
                  file-sync menu
                </button>{" "}
                and sync with <span className="font-mono">{MASTER_ID}</span> to
                fetch <code>snapshot.db</code> and <code>{MASTER_ID}.jsonl</code>.
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
                  newOpen={newTxOpen}
                  setNewOpen={setNewTxOpen}
                  onNewKind={onNewTxKind}
                  onEdit={() => openForm(editTx())}
                  onDelete={() => openForm(deleteTx())}
                />
              </TabsContent>
              <TabsContent value="accounts" className="mt-4">
                <AccountsTab
                  accounts={accounts}
                  onNew={() => openForm(newAccount)}
                  onRename={() => openForm(renameAccount())}
                  onDelete={() => openForm(deleteAccount())}
                />
              </TabsContent>
              <TabsContent value="categories" className="mt-4">
                <CategoriesTab
                  categories={categories}
                  onNew={() => openForm(newCategory)}
                  onRename={() => openForm(renameCategory())}
                  onDelete={() => openForm(deleteCategory())}
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

      <Wizard
        key={form?.title ?? "closed"}
        spec={form}
        open={form !== null}
        onClose={() => setForm(null)}
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
