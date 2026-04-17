import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { Alert, Badge, Spinner } from "@inkjs/ui";
import chokidar from "chokidar";
import { Store, FileSyncLagError } from "../src/index.ts";
import type { ConflictContext, Resolver } from "../src/types.ts";
import {
  bankActions,
  type Account,
  type Category,
  type Transaction,
} from "./actions.ts";

type Props = {
  root: string;
  peerId: string;
  masterId: string;
  seed?: boolean;
  watchDebounceMs?: number;
  noWatch?: boolean;
};

type Tab = "accounts" | "categories" | "transactions";
type Mode =
  | "idle"
  | "syncing"
  | "form"
  | "sub_tx_new"
  | "sub_tx_edit"
  | "conflict"
  | "retry";

type FormSpec = {
  id: string;
  title: string;
  hint: string;
  onSubmit: (value: string) => string | null; // returns error message or null on success
};

type PendingConflict = {
  ctx: ConflictContext;
  resolve: (r: "drop" | "force" | "retry") => void;
};

function nowTs(): string {
  return new Date().toISOString();
}

// ─── sub-components ──────────────────────────────────────────────────────────

function TopBar({
  peerId,
  masterId,
  head,
  mode,
  status,
  statusKind,
}: {
  peerId: string;
  masterId: string;
  head: number;
  mode: Mode;
  status: string;
  statusKind: "info" | "success" | "error" | "warning";
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          tracker
        </Text>
        <Text dimColor> │ peer=</Text>
        <Text color="yellow">{peerId}</Text>
        <Text dimColor> │ master=</Text>
        <Text>{masterId}</Text>
        <Text dimColor> │ head=</Text>
        <Text color="green">{head}</Text>
        <Text dimColor> │ mode=</Text>
        <Text color={mode === "idle" ? "green" : "magenta"}>{mode}</Text>
        {mode === "syncing" ? (
          <Box marginLeft={2}>
            <Spinner label="syncing…" />
          </Box>
        ) : null}
      </Box>
      <Box>
        <Alert variant={statusKind}>
          <Text>{status}</Text>
        </Alert>
      </Box>
    </Box>
  );
}

function BalanceStrip({ accounts }: { accounts: Account[] }) {
  if (accounts.length === 0) return null;
  return (
    <Box>
      <Text dimColor>balances: </Text>
      {accounts.map((a, i) => (
        <React.Fragment key={a.id}>
          {i > 0 ? <Text dimColor> │ </Text> : null}
          <Text>ACCT {a.id} </Text>
          <Text color={a.balance > 0 ? "green" : "gray"}>${a.balance} </Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

function Tabs({ active }: { active: Tab }) {
  const tab = (label: string, key: string, val: Tab) => {
    const focused = active === val;
    return (
      <Box marginRight={1} key={val}>
        <Text
          color={focused ? "black" : "gray"}
          backgroundColor={focused ? "cyan" : undefined}
          bold={focused}
        >
          {" "}
          [{key}] {label}{" "}
        </Text>
      </Box>
    );
  };
  return (
    <Box>
      {tab("Accounts", "a", "accounts")}
      {tab("Categories", "c", "categories")}
      {tab("Transactions", "t", "transactions")}
    </Box>
  );
}

function AccountsTab({ accounts }: { accounts: Account[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexGrow={1}>
      <Text bold>Accounts ({accounts.length})</Text>
      {accounts.length === 0 ? <Text dimColor>— none —</Text> : null}
      {accounts.map((a) => (
        <Text key={a.id}>
          ACCT {a.id} <Text color="yellow">{a.name}</Text>{" "}
          <Text color={a.balance > 0 ? "green" : "gray"}>${a.balance}</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>[n]ew  [r]ename  [d]elete</Text>
      </Box>
    </Box>
  );
}

function CategoriesTab({ categories }: { categories: Category[] }) {
  const color = (kind: Category["kind"]) =>
    kind === "income" ? "green" : kind === "expense" ? "red" : "yellow";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexGrow={1}>
      <Text bold>Categories ({categories.length})</Text>
      {categories.length === 0 ? <Text dimColor>— none —</Text> : null}
      {categories.map((c) => (
        <Text key={c.id}>
          CAT {c.id} <Text color="yellow">{c.name}</Text>{" "}
          <Text color={color(c.kind)}>[{c.kind}]</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>[n]ew  [r]ename  [d]elete</Text>
      </Box>
    </Box>
  );
}

function TransactionsTab({
  transactions,
  accounts,
  categories,
}: {
  transactions: Transaction[];
  accounts: Account[];
  categories: Category[];
}) {
  const accName = (id: string | null) =>
    id ? (accounts.find((a) => a.id === id)?.name ?? id) : "·";
  const catName = (id: string | null) =>
    id ? (categories.find((c) => c.id === id)?.name ?? id) : "—";
  const kindColor = (k: Transaction["kind"]) =>
    k === "income" ? "green" : k === "expense" ? "red" : "cyan";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexGrow={1}>
      <Text bold>Transactions ({transactions.length})</Text>
      {transactions.length === 0 ? <Text dimColor>— none —</Text> : null}
      {transactions.slice(-12).map((t) => {
        const flow =
          t.kind === "income"
            ? `→ ${accName(t.acc_to)}`
            : t.kind === "expense"
              ? `${accName(t.acc_from)} →`
              : `${accName(t.acc_from)} → ${accName(t.acc_to)}`;
        const memoText = t.memo
          ? " memo=" +
            JSON.stringify(t.memo.length > 40 ? t.memo.slice(0, 40) + "…" : t.memo)
          : "";
        return (
          <Text key={t.id} wrap="truncate-end">
            TX {t.id} <Text color={kindColor(t.kind)}>[{t.kind}]</Text> {flow}{" "}
            <Text color="green">${t.amount}</Text>{" "}
            <Text dimColor>cat={catName(t.category_id)}</Text>
            {memoText}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          [n]ew (i/e/x)  [e]dit (p/m/c)  [d]elete
        </Text>
      </Box>
    </Box>
  );
}

function FormPanel({
  title,
  hint,
  value,
  onChange,
  onSubmit,
  onCancel: _onCancel,
}: {
  title: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Box>
        <Badge color="yellow">FORM</Badge>
        <Text bold> {title}</Text>
      </Box>
      <Text dimColor>{hint}</Text>
      <Box>
        <Text color="yellow">› </Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
      <Text dimColor>Enter=submit  Esc=cancel</Text>
    </Box>
  );
}

function SubMenu({ title, options }: { title: string; options: Array<[string, string]> }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1}>
      <Box>
        <Badge color="magenta">MENU</Badge>
        <Text bold> {title}</Text>
      </Box>
      {options.map(([key, label]) => (
        <Text key={key}>
          <Text bold color="magenta">
            [{key}]
          </Text>
          {" "}
          {label}
        </Text>
      ))}
      <Text dimColor>Esc=cancel</Text>
    </Box>
  );
}

function ConflictPanel({ conflict }: { conflict: PendingConflict }) {
  const c = conflict.ctx;
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="red" paddingX={1}>
      <Box>
        <Badge color="red">CONFLICT</Badge>
        <Text> kind=</Text>
        <Text color="red">{c.kind}</Text>
      </Box>
      <Text>
        action: <Text color="yellow">{c.action.name}</Text> {JSON.stringify(c.action.params)}
      </Text>
      {c.error ? <Text color="red">error: {c.error.message}</Text> : null}
      <Box marginTop={1}>
        <Text>
          <Text bold>[d]</Text>rop the action · <Text bold>[f]</Text>orce (override commute check) ·{" "}
          <Text bold>[r]</Text>etry (submit fixing actions first)
        </Text>
      </Box>
    </Box>
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

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

  const [tab, setTab] = useState<Tab>("transactions");
  const [mode, setMode] = useState<Mode>("idle");
  const [form, setForm] = useState<FormSpec | null>(null);
  const [subMenuOptions, setSubMenuOptions] = useState<Array<[string, string]>>([]);
  const [subMenuHandlers, setSubMenuHandlers] = useState<Record<string, () => void>>({});
  const [subMenuTitle, setSubMenuTitle] = useState("");
  const [inputValue, setInputValue] = useState("");

  const [status, setStatus] = useState("starting");
  const [statusKind, setStatusKind] = useState<"info" | "success" | "error" | "warning">(
    "info",
  );
  const [head, setHead] = useState(0);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [, tick] = useState(0);
  const bump = useCallback(() => tick((x) => x + 1), []);

  const modeRef = useRef<Mode>("idle");
  const syncingRef = useRef(false);
  const storeRef = useRef<Store | null>(null);
  modeRef.current = mode;
  storeRef.current = store;

  const setOk = useCallback((msg: string) => {
    setStatus(msg);
    setStatusKind("success");
  }, []);
  const setErr = useCallback((msg: string) => {
    setStatus(msg);
    setStatusKind("error");
  }, []);
  const setInfo = useCallback((msg: string) => {
    setStatus(msg);
    setStatusKind("info");
  }, []);

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
      const bits = [
        `applied=${report.applied}`,
        `skipped=${report.skipped}`,
        `dropped=${report.dropped}`,
        `forced=${report.forced}`,
      ];
      if (report.squashedTo !== undefined) bits.push(`squashedTo=${report.squashedTo}`);
      setOk(`synced ${bits.join(" ")}`);
      setMode("idle");
      setConflict(null);
      bump();
    } catch (err) {
      if (err instanceof FileSyncLagError) {
        setInfo(
          `file-sync-lag snapshotHead=${err.snapshotHead} declared=${err.declaredSnapshotHead}`,
        );
      } else {
        setErr(`sync-error: ${err instanceof Error ? err.message : String(err)}`);
      }
      setMode("idle");
      setConflict(null);
    } finally {
      syncingRef.current = false;
    }
  }, [bump, setErr, setInfo, setOk]);

  // open store
  useEffect(() => {
    try {
      const s = Store.open({ root, peerId, masterId, actions: bankActions });
      storeRef.current = s;
      setStore(s);
      setHead(s.currentMasterSeq);
      if (seed && s.isMaster) {
        const hasTables = s.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
          )
          .get();
        if (!hasTables) {
          s.submit("init_bank", {});
          s.submit("create_account", { id: "checking", name: "Checking", ts: nowTs() });
          s.submit("create_account", { id: "savings", name: "Savings", ts: nowTs() });
          s.submit("create_account", { id: "external", name: "External", ts: nowTs() });
          setHead(s.currentMasterSeq);
        }
      }
      setInfo("opened");
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      storeRef.current?.close();
      storeRef.current = null;
    };
  }, [root, peerId, masterId, seed, setInfo]);

  // initial sync
  useEffect(() => {
    if (store) void doSync();
  }, [store, doSync]);

  // file watcher
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
        if (modeRef.current === "idle" || modeRef.current === "syncing") void doSync();
      }, watchDebounceMs);
    };
    watcher.on("all", onChange);
    return () => {
      void watcher.close();
      if (timer) clearTimeout(timer);
    };
  }, [store, root, doSync, watchDebounceMs, noWatch]);

  // ─── form-spec builders ────────────────────────────────────────────────
  const openForm = useCallback(
    (spec: FormSpec) => {
      setForm(spec);
      setInputValue("");
      setMode("form");
    },
    [],
  );
  const closeForm = useCallback(() => {
    setForm(null);
    setInputValue("");
    setMode("idle");
  }, []);

  const accountNewForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "account_new",
      title: "New account",
      hint: "id name",
      onSubmit: (v) => {
        const parts = v.trim().split(/\s+/);
        if (parts.length !== 2) return `expected "id name"`;
        try {
          s.submit("create_account", { id: parts[0], name: parts[1], ts: nowTs() });
          setOk(`created account ${parts[0]}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);
  const accountRenameForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "account_rename",
      title: "Rename account",
      hint: "id new-name",
      onSubmit: (v) => {
        const parts = v.trim().split(/\s+/);
        if (parts.length !== 2) return `expected "id new-name"`;
        try {
          s.submit("rename_account", { id: parts[0], name: parts[1] });
          setOk(`renamed ${parts[0]}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);
  const accountDeleteForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "account_delete",
      title: "Delete account",
      hint: "id",
      onSubmit: (v) => {
        const id = v.trim();
        if (!id) return "empty id";
        try {
          s.submit("delete_account", { id });
          setOk(`deleted account ${id}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);

  const categoryNewForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "category_new",
      title: "New category",
      hint: "id name kind   (kind: income | expense | both)",
      onSubmit: (v) => {
        const parts = v.trim().split(/\s+/);
        if (parts.length !== 3) return `expected "id name kind"`;
        const [id, name, kind] = parts;
        if (kind !== "income" && kind !== "expense" && kind !== "both") {
          return `kind must be income|expense|both`;
        }
        try {
          s.submit("create_category", { id, name, kind, ts: nowTs() });
          setOk(`created category ${id}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);
  const categoryRenameForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "category_rename",
      title: "Rename category",
      hint: "id new-name",
      onSubmit: (v) => {
        const parts = v.trim().split(/\s+/);
        if (parts.length !== 2) return `expected "id new-name"`;
        try {
          s.submit("rename_category", { id: parts[0], name: parts[1] });
          setOk(`renamed ${parts[0]}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);
  const categoryDeleteForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "category_delete",
      title: "Delete category",
      hint: "id",
      onSubmit: (v) => {
        const id = v.trim();
        if (!id) return "empty id";
        try {
          s.submit("delete_category", { id });
          setOk(`deleted category ${id}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);

  const txIncomeForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "tx_income",
      title: "New income",
      hint: "id acc_to amount [category_id|- [memo…]]",
      onSubmit: (v) => {
        const parts = v.trim().split(/\s+/);
        if (parts.length < 3) return `expected "id acc_to amount [cat [memo…]]"`;
        const [id, acc_to, amountStr, cat = "-", ...rest] = parts;
        try {
          s.submit("create_income", {
            id,
            acc_to,
            amount: Number(amountStr),
            category_id: cat === "-" ? null : cat,
            memo: rest.join(" "),
            ts: nowTs(),
          });
          setOk(`income ${id}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);
  const txExpenseForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "tx_expense",
      title: "New expense",
      hint: "id acc_from amount [category_id|- [memo…]]",
      onSubmit: (v) => {
        const parts = v.trim().split(/\s+/);
        if (parts.length < 3) return `expected "id acc_from amount [cat [memo…]]"`;
        const [id, acc_from, amountStr, cat = "-", ...rest] = parts;
        try {
          s.submit("create_expense", {
            id,
            acc_from,
            amount: Number(amountStr),
            category_id: cat === "-" ? null : cat,
            memo: rest.join(" "),
            ts: nowTs(),
          });
          setOk(`expense ${id}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);
  const txTransferForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "tx_transfer",
      title: "New transfer (between accounts)",
      hint: "id acc_from acc_to amount [memo…]",
      onSubmit: (v) => {
        const parts = v.trim().split(/\s+/);
        if (parts.length < 4) return `expected "id acc_from acc_to amount [memo…]"`;
        const [id, acc_from, acc_to, amountStr, ...rest] = parts;
        try {
          s.submit("create_transfer", {
            id,
            acc_from,
            acc_to,
            amount: Number(amountStr),
            memo: rest.join(" "),
            ts: nowTs(),
          });
          setOk(`transfer ${id}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);
  const txEditAmountForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "tx_edit_amount",
      title: "Edit transaction amount",
      hint: "id amount",
      onSubmit: (v) => {
        const parts = v.trim().split(/\s+/);
        if (parts.length !== 2) return `expected "id amount"`;
        try {
          s.submit("edit_tx_amount", { id: parts[0], amount: Number(parts[1]) });
          setOk(`amount updated for ${parts[0]}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);
  const txEditMemoForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "tx_edit_memo",
      title: "Edit transaction memo",
      hint: "id memo…",
      onSubmit: (v) => {
        const idx = v.indexOf(" ");
        if (idx < 0) return `expected "id memo…"`;
        const id = v.slice(0, idx).trim();
        const memo = v.slice(idx + 1);
        try {
          s.submit("edit_tx_memo", { id, memo });
          setOk(`memo updated for ${id}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);
  const txEditCategoryForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "tx_edit_category",
      title: "Edit transaction category",
      hint: "id category_id|-",
      onSubmit: (v) => {
        const parts = v.trim().split(/\s+/);
        if (parts.length !== 2) return `expected "id category_id|-"`;
        try {
          s.submit("edit_tx_category", {
            id: parts[0],
            category_id: parts[1] === "-" ? null : parts[1],
          });
          setOk(`category updated for ${parts[0]}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);
  const txDeleteForm = useCallback((): FormSpec => {
    const s = storeRef.current!;
    return {
      id: "tx_delete",
      title: "Delete transaction",
      hint: "id",
      onSubmit: (v) => {
        const id = v.trim();
        if (!id) return "empty id";
        try {
          s.submit("delete_transaction", { id });
          setOk(`deleted tx ${id}`);
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        return null;
      },
    };
  }, [setOk]);

  // ─── keyboard ─────────────────────────────────────────────────────────
  useInput((raw, key) => {
    if (openError) {
      if (raw === "q") exit();
      return;
    }
    if (!store) return;

    if (mode === "form" && form) {
      if (key.escape) closeForm();
      return;
    }
    if (mode === "sub_tx_new" || mode === "sub_tx_edit") {
      if (key.escape) {
        setMode("idle");
        return;
      }
      const h = subMenuHandlers[raw];
      if (h) {
        h();
      }
      return;
    }
    if (mode === "retry") {
      if (key.escape) {
        setInputValue("");
        setMode("conflict");
      }
      return;
    }
    if (mode === "conflict" && conflict) {
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
      return;
    }

    // idle
    if (raw === "q") {
      exit();
      return;
    }
    if (raw === "s") {
      void doSync();
      return;
    }
    // tab switching
    if (raw === "a" || raw === "1") {
      setTab("accounts");
      return;
    }
    if (raw === "c" || raw === "2") {
      setTab("categories");
      return;
    }
    if (raw === "t" || raw === "3") {
      setTab("transactions");
      return;
    }

    // per-tab commands
    if (tab === "accounts") {
      if (raw === "n") openForm(accountNewForm());
      else if (raw === "r") openForm(accountRenameForm());
      else if (raw === "d") openForm(accountDeleteForm());
    } else if (tab === "categories") {
      if (raw === "n") openForm(categoryNewForm());
      else if (raw === "r") openForm(categoryRenameForm());
      else if (raw === "d") openForm(categoryDeleteForm());
    } else if (tab === "transactions") {
      if (raw === "n") {
        setSubMenuTitle("New transaction — pick kind");
        setSubMenuOptions([
          ["i", "income"],
          ["e", "expense"],
          ["x", "transfer (between accounts)"],
        ]);
        setSubMenuHandlers({
          i: () => openForm(txIncomeForm()),
          e: () => openForm(txExpenseForm()),
          x: () => openForm(txTransferForm()),
        });
        setMode("sub_tx_new");
      } else if (raw === "e") {
        setSubMenuTitle("Edit transaction — pick field");
        setSubMenuOptions([
          ["p", "amount (price)"],
          ["m", "memo"],
          ["c", "category"],
        ]);
        setSubMenuHandlers({
          p: () => openForm(txEditAmountForm()),
          m: () => openForm(txEditMemoForm()),
          c: () => openForm(txEditCategoryForm()),
        });
        setMode("sub_tx_edit");
      } else if (raw === "d") {
        openForm(txDeleteForm());
      }
    }
  });

  // ─── data queries ─────────────────────────────────────────────────────
  const tablesExist = store
    ? store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
        )
        .get() !== undefined
    : false;
  const accounts: Account[] =
    store && tablesExist
      ? (store.db.prepare("SELECT * FROM accounts ORDER BY created_at").all() as Account[])
      : [];
  const categories: Category[] =
    store && tablesExist
      ? (store.db
          .prepare("SELECT * FROM categories ORDER BY created_at")
          .all() as Category[])
      : [];
  const transactions: Transaction[] =
    store && tablesExist
      ? (store.db
          .prepare("SELECT * FROM transactions ORDER BY ts")
          .all() as Transaction[])
      : [];
  const pendingCount = store && !store.isMaster
    ? store.peerLog.filter((e) => e.kind === "action").length
    : 0;

  if (openError) {
    return (
      <Box flexDirection="column">
        <Text>
          PEER={peerId} MASTER={masterId}
        </Text>
        <Alert variant="error">
          <Text>OPEN-ERROR {openError}</Text>
        </Alert>
        <Text dimColor>[q]uit</Text>
      </Box>
    );
  }
  if (!store) return <Text>opening…</Text>;

  const termWidth = Math.max(process.stdout.columns || 120, 80);
  return (
    <Box flexDirection="column" width={termWidth}>
      <TopBar
        peerId={peerId}
        masterId={masterId}
        head={head}
        mode={mode}
        status={status}
        statusKind={statusKind}
      />
      <BalanceStrip accounts={accounts} />
      <Tabs active={tab} />
      <Box marginTop={1}>
        {tab === "accounts" ? <AccountsTab accounts={accounts} /> : null}
        {tab === "categories" ? <CategoriesTab categories={categories} /> : null}
        {tab === "transactions" ? (
          <TransactionsTab
            transactions={transactions}
            accounts={accounts}
            categories={categories}
          />
        ) : null}
      </Box>
      {!store.isMaster ? (
        <Box marginTop={1}>
          <Text dimColor>
            pending ({pendingCount})
            {pendingCount > 0
              ? ": " +
                store.peerLog
                  .filter((e) => e.kind === "action")
                  .map((e) =>
                    e.kind === "action"
                      ? `seq=${e.seq}:${e.name}${e.force ? "(force)" : ""}`
                      : "",
                  )
                  .join(", ")
              : ""}
          </Text>
        </Box>
      ) : null}

      {mode === "form" && form ? (
        <Box marginTop={1}>
          <FormPanel
            title={form.title}
            hint={form.hint}
            value={inputValue}
            onChange={setInputValue}
            onSubmit={(v) => {
              const err = form.onSubmit(v);
              if (err) setErr(err);
              closeForm();
              bump();
            }}
            onCancel={closeForm}
          />
        </Box>
      ) : null}

      {(mode === "sub_tx_new" || mode === "sub_tx_edit") ? (
        <Box marginTop={1}>
          <SubMenu title={subMenuTitle} options={subMenuOptions} />
        </Box>
      ) : null}

      {mode === "conflict" && conflict ? (
        <Box marginTop={1}>
          <ConflictPanel conflict={conflict} />
        </Box>
      ) : null}

      {mode === "retry" && conflict ? (
        <Box marginTop={1}>
          <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
            <Box>
              <Badge color="yellow">RETRY</Badge>
              <Text bold> submit a prepended action, then retry</Text>
            </Box>
            <Text dimColor>syntax: same as the TX form you're retrying</Text>
            <Text dimColor>
              e.g. transfer: "txId acc_from acc_to amount [memo]"
            </Text>
            <Box>
              <Text color="yellow">› </Text>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={(val) => {
                  // Always parse as a transfer — the canonical "topup" retry.
                  const parts = val.trim().split(/\s+/);
                  if (parts.length < 4) {
                    setErr(`retry expected "id acc_from acc_to amount [memo]"`);
                    setInputValue("");
                    return;
                  }
                  const [id, acc_from, acc_to, amountStr, ...rest] = parts;
                  const amount = Number(amountStr);
                  if (!Number.isFinite(amount) || amount <= 0) {
                    setErr(`retry: amount must be a positive number, got "${amountStr}"`);
                    setInputValue("");
                    return;
                  }
                  try {
                    conflict.ctx.submit("create_transfer", {
                      id,
                      acc_from,
                      acc_to,
                      amount,
                      memo: rest.join(" "),
                      ts: nowTs(),
                    });
                    setOk(`prepended transfer ${id} — retrying`);
                    conflict.resolve("retry");
                    setConflict(null);
                    setMode("syncing");
                    setInputValue("");
                  } catch (err) {
                    setErr(
                      `retry prepend failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                    setInputValue("");
                  }
                }}
              />
            </Box>
            <Text dimColor>Enter=prepend+retry  Esc=back</Text>
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          [s]ync  [q]uit  │ tabs: [a] accounts  [c] categories  [t] transactions
        </Text>
      </Box>
    </Box>
  );
}
