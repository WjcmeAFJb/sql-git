import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
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
  watchDebounceMs?: number;
  noWatch?: boolean;
};

type Tab = "accounts" | "categories" | "transactions";
type Mode = "idle" | "syncing" | "form" | "submenu" | "conflict" | "retry";

type PendingConflict = {
  ctx: ConflictContext;
  resolve: (r: "drop" | "force" | "retry") => void;
};

function nowTs(): string {
  return new Date().toISOString();
}
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)
    .toString(36)
    .padStart(2, "0")}`;
}

// ─── form types ──────────────────────────────────────────────────────────────

type FieldText = {
  type: "text";
  key: string;
  label: string;
  initial?: string;
  optional?: boolean;
};
type FieldNumber = {
  type: "number";
  key: string;
  label: string;
  initial?: string;
  min?: number;
};
type FieldSelect = {
  type: "select";
  key: string;
  label: string;
  options: Array<{ label: string; value: string }>;
};
type FormField = FieldText | FieldNumber | FieldSelect;

type FormSpec = {
  title: string;
  fields: FormField[];
  onSubmit: (values: Record<string, string>) => string | null;
};

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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>Accounts ({accounts.length})</Text>
      {accounts.length === 0 ? <Text dimColor>— none —</Text> : null}
      {accounts.map((a) => (
        <Text key={a.id} wrap="truncate-end">
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>Categories ({categories.length})</Text>
      {categories.length === 0 ? <Text dimColor>— none —</Text> : null}
      {categories.map((c) => (
        <Text key={c.id} wrap="truncate-end">
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexGrow={1}
    >
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
          [n]ew (i/e/x)  [e]dit  [d]elete
        </Text>
      </Box>
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

/** Multi-step form. Each field is asked in turn; Enter advances, Esc cancels. */
function Wizard({
  form,
  values,
  setValues,
  current,
  setCurrent,
  textValue,
  setTextValue,
  fieldError,
  setFieldError,
  onFinish,
}: {
  form: FormSpec;
  values: Record<string, string>;
  setValues: (v: Record<string, string>) => void;
  current: number;
  setCurrent: (n: number) => void;
  textValue: string;
  setTextValue: (v: string) => void;
  fieldError: string | null;
  setFieldError: (e: string | null) => void;
  onFinish: (err: string | null) => void;
}) {
  const field = form.fields[current];

  const commit = (rawValue: string) => {
    let value = rawValue;
    if (field.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        setFieldError("must be a number");
        return;
      }
      if ("min" in field && field.min !== undefined && n < field.min) {
        setFieldError(`must be ≥ ${field.min}`);
        return;
      }
      value = String(n);
    }
    if (field.type === "text" && !("optional" in field && field.optional) && !value) {
      setFieldError("required");
      return;
    }
    const newValues = { ...values, [field.key]: value };
    setValues(newValues);
    setFieldError(null);
    const next = current + 1;
    if (next >= form.fields.length) {
      // Submit.
      const err = form.onSubmit(newValues);
      onFinish(err);
      return;
    }
    setCurrent(next);
    const nextField = form.fields[next];
    if (nextField.type === "text" || nextField.type === "number") {
      setTextValue(nextField.initial ?? "");
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      onFinish("cancelled");
      return;
    }
    if (field.type === "select") {
      const digit = parseInt(input, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= field.options.length) {
        commit(field.options[digit - 1].value);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Box>
        <Badge color="yellow">FORM</Badge>
        <Text bold> {form.title}</Text>
      </Box>
      {/* Completed fields */}
      {form.fields.slice(0, current).map((f) => {
        const v = values[f.key];
        const display =
          f.type === "select"
            ? (f.options.find((o) => o.value === v)?.label ?? v ?? "(empty)")
            : v || "(empty)";
        return (
          <Text key={f.key} dimColor>
            ✓ {f.label}: <Text>{display}</Text>
          </Text>
        );
      })}

      {/* Current field */}
      {field.type === "text" || field.type === "number" ? (
        <Box>
          <Text color="yellow">› {field.label}: </Text>
          <TextInput
            value={textValue}
            onChange={setTextValue}
            onSubmit={commit}
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color="yellow">› {field.label}:</Text>
          {field.options.map((o, i) => (
            <Text key={o.value}>
              {" "}
              <Text bold color="magenta">
                [{i + 1}]
              </Text>{" "}
              {o.label}
            </Text>
          ))}
        </Box>
      )}

      {fieldError ? (
        <Text color="red">✘ {fieldError}</Text>
      ) : null}

      {/* Pending fields preview */}
      {form.fields.slice(current + 1).map((f) => (
        <Text key={f.key} dimColor>
          · {f.label}
        </Text>
      ))}

      <Text dimColor>
        {field.type === "select"
          ? "press [1]–[9] to pick  Esc=cancel"
          : "Enter=next  Esc=cancel"}
      </Text>
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
          <Text bold>[d]</Text>rop · <Text bold>[f]</Text>orce ·{" "}
          <Text bold>[r]</Text>etry (prepend a fixing transfer)
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
  watchDebounceMs = 300,
  noWatch = false,
}: Props) {
  const { exit } = useApp();
  const [store, setStore] = useState<Store | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("transactions");
  const [mode, setMode] = useState<Mode>("idle");

  const [form, setForm] = useState<FormSpec | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formCurrent, setFormCurrent] = useState(0);
  const [formTextValue, setFormTextValue] = useState("");
  const [formFieldError, setFormFieldError] = useState<string | null>(null);

  const [submenu, setSubmenu] = useState<{
    title: string;
    options: Array<[string, string]>;
    handlers: Record<string, () => void>;
  } | null>(null);

  const [status, setStatus] = useState("starting");
  const [statusKind, setStatusKind] = useState<"info" | "success" | "error" | "warning">(
    "info",
  );
  const [head, setHead] = useState(0);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [retryInput, setRetryInput] = useState("");
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

  // open store + auto-init master schema
  useEffect(() => {
    try {
      const s = Store.open({ root, peerId, masterId, actions: bankActions });
      storeRef.current = s;
      setStore(s);
      setHead(s.currentMasterSeq);
      if (s.isMaster) {
        const hasAccountsTable = s.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
          )
          .get();
        if (!hasAccountsTable) {
          s.submit("init_bank", {});
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
  }, [root, peerId, masterId, setInfo]);

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
    const ownLogSuffix = `peers/${peerId}.jsonl`;
    const isOwnWrite = (path: string): boolean => {
      // Our own peer log — written by every sync — would otherwise retrigger
      // sync forever (self-feedback loop; visible as a flickering mode line).
      if (path.endsWith(ownLogSuffix)) return true;
      // Master also owns snapshot.db.
      if (store.isMaster && path.endsWith("/snapshot.db")) return true;
      // Ignore the atomic-rename scratch files from syncer and rewriteLog.
      if (path.endsWith(".tmp") || path.endsWith(".tmp-syncer")) return true;
      return false;
    };
    const onChange = (_evt: string, path: string) => {
      if (isOwnWrite(path)) return;
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
  }, [store, root, peerId, doSync, watchDebounceMs, noWatch]);

  // ─── data queries (computed each render) ──────────────────────────────
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
  const pendingActions = store && !store.isMaster
    ? store.peerLog.filter((e) => e.kind === "action")
    : [];

  // ─── form builders ────────────────────────────────────────────────────
  const openForm = (spec: FormSpec) => {
    setForm(spec);
    setFormValues({});
    setFormCurrent(0);
    const first = spec.fields[0];
    setFormTextValue(
      first && (first.type === "text" || first.type === "number") ? (first.initial ?? "") : "",
    );
    setFormFieldError(null);
    setMode("form");
  };
  const closeForm = () => {
    setForm(null);
    setFormValues({});
    setFormCurrent(0);
    setFormTextValue("");
    setFormFieldError(null);
    setMode("idle");
  };

  const accountOptions = () =>
    accounts.map((a) => ({ label: `${a.name} (${a.id}) · $${a.balance}`, value: a.id }));
  const categoryOptions = (includeNone = true) => {
    const opts = categories.map((c) => ({
      label: `${c.name} [${c.kind}]`,
      value: c.id,
    }));
    return includeNone ? [{ label: "— none —", value: "" }, ...opts] : opts;
  };
  const txOptions = () =>
    transactions
      .slice(-20)
      .map((t) => ({
        label: `${t.id} · ${t.kind} · $${t.amount}${t.memo ? " · " + t.memo.slice(0, 20) : ""}`,
        value: t.id,
      }));

  // Chain to the next form after the current one closes cleanly. Deferred so
  // React's close-then-open state transitions don't collapse into one render.
  const chain = (next: FormSpec) => setTimeout(() => openForm(next), 0);

  // ACCOUNTS
  const newAccountForm = (): FormSpec => ({
    title: "New account",
    fields: [{ type: "text", key: "name", label: "Display name" }],
    onSubmit: (v) => {
      const id = genId("acc");
      try {
        storeRef.current!.submit("create_account", { id, name: v.name, ts: nowTs() });
        setOk(`created account ${v.name} (${id})`);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  });
  const renameAccountForm = (): FormSpec | null => {
    if (accounts.length === 0) {
      setErr("no accounts to rename");
      return null;
    }
    return {
      title: "Rename account — pick one",
      fields: [{ type: "select", key: "id", label: "Account", options: accountOptions() }],
      onSubmit: (v) => {
        const acc = accounts.find((a) => a.id === v.id);
        if (!acc) return "account not found";
        chain(renameAccountStep2(acc));
        return null;
      },
    };
  };
  const renameAccountStep2 = (acc: Account): FormSpec => ({
    title: `Rename account "${acc.name}"`,
    fields: [
      {
        type: "text",
        key: "name",
        label: `New name (current: "${acc.name}")`,
      },
    ],
    onSubmit: (v) => {
      if (v.name === acc.name) {
        setInfo("unchanged");
        return null;
      }
      try {
        storeRef.current!.submit("rename_account", { id: acc.id, name: v.name });
        setOk(`renamed to "${v.name}"`);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  });
  const deleteAccountForm = (): FormSpec | null => {
    if (accounts.length === 0) {
      setErr("no accounts to delete");
      return null;
    }
    return {
      title: "Delete account",
      fields: [{ type: "select", key: "id", label: "Account", options: accountOptions() }],
      onSubmit: (v) => {
        try {
          storeRef.current!.submit("delete_account", { id: v.id });
          setOk(`deleted account ${v.id}`);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    };
  };

  // CATEGORIES
  const newCategoryForm = (): FormSpec => ({
    title: "New category",
    fields: [
      { type: "text", key: "name", label: "Name" },
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
    onSubmit: (v) => {
      const id = genId("cat");
      try {
        storeRef.current!.submit("create_category", {
          id,
          name: v.name,
          kind: v.kind as "income" | "expense" | "both",
          ts: nowTs(),
        });
        setOk(`created category ${v.name} [${v.kind}] (${id})`);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  });
  const renameCategoryForm = (): FormSpec | null => {
    if (categories.length === 0) {
      setErr("no categories to rename");
      return null;
    }
    return {
      title: "Rename category — pick one",
      fields: [
        { type: "select", key: "id", label: "Category", options: categoryOptions(false) },
      ],
      onSubmit: (v) => {
        const cat = categories.find((c) => c.id === v.id);
        if (!cat) return "category not found";
        chain(renameCategoryStep2(cat));
        return null;
      },
    };
  };
  const renameCategoryStep2 = (cat: Category): FormSpec => ({
    title: `Rename category "${cat.name}"`,
    fields: [
      {
        type: "text",
        key: "name",
        label: `New name (current: "${cat.name}")`,
      },
    ],
    onSubmit: (v) => {
      if (v.name === cat.name) {
        setInfo("unchanged");
        return null;
      }
      try {
        storeRef.current!.submit("rename_category", { id: cat.id, name: v.name });
        setOk(`renamed to "${v.name}"`);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  });
  const deleteCategoryForm = (): FormSpec | null => {
    if (categories.length === 0) {
      setErr("no categories to delete");
      return null;
    }
    return {
      title: "Delete category",
      fields: [
        { type: "select", key: "id", label: "Category", options: categoryOptions(false) },
      ],
      onSubmit: (v) => {
        try {
          storeRef.current!.submit("delete_category", { id: v.id });
          setOk(`deleted category ${v.id}`);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    };
  };

  // TRANSACTIONS
  const incomeForm = (): FormSpec | null => {
    if (accounts.length === 0) {
      setErr("create an account first");
      return null;
    }
    return {
      title: "New income (cash in)",
      fields: [
        { type: "number", key: "amount", label: "Amount", min: 1 },
        { type: "select", key: "acc_to", label: "Into account", options: accountOptions() },
        {
          type: "select",
          key: "category_id",
          label: "Category",
          options: categoryOptions(true),
        },
        { type: "text", key: "memo", label: "Memo (optional)", optional: true },
      ],
      onSubmit: (v) => {
        const id = genId("inc");
        try {
          storeRef.current!.submit("create_income", {
            id,
            acc_to: v.acc_to,
            amount: Number(v.amount),
            category_id: v.category_id || null,
            memo: v.memo,
            ts: nowTs(),
          });
          setOk(`income +$${v.amount} → ${v.acc_to} (${id})`);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    };
  };
  const expenseForm = (): FormSpec | null => {
    if (accounts.length === 0) {
      setErr("create an account first");
      return null;
    }
    return {
      title: "New expense (cash out)",
      fields: [
        { type: "number", key: "amount", label: "Amount", min: 1 },
        { type: "select", key: "acc_from", label: "From account", options: accountOptions() },
        {
          type: "select",
          key: "category_id",
          label: "Category",
          options: categoryOptions(true),
        },
        { type: "text", key: "memo", label: "Memo (optional)", optional: true },
      ],
      onSubmit: (v) => {
        const id = genId("exp");
        try {
          storeRef.current!.submit("create_expense", {
            id,
            acc_from: v.acc_from,
            amount: Number(v.amount),
            category_id: v.category_id || null,
            memo: v.memo,
            ts: nowTs(),
          });
          setOk(`expense -$${v.amount} from ${v.acc_from} (${id})`);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    };
  };
  const transferForm = (): FormSpec | null => {
    if (accounts.length < 2) {
      setErr("need at least two accounts for a transfer");
      return null;
    }
    return {
      title: "New transfer (between accounts)",
      fields: [
        { type: "number", key: "amount", label: "Amount", min: 1 },
        { type: "select", key: "acc_from", label: "From", options: accountOptions() },
        { type: "select", key: "acc_to", label: "To", options: accountOptions() },
        { type: "text", key: "memo", label: "Memo (optional)", optional: true },
      ],
      onSubmit: (v) => {
        if (v.acc_from === v.acc_to) return "from and to must differ";
        const id = genId("tr");
        try {
          storeRef.current!.submit("create_transfer", {
            id,
            acc_from: v.acc_from,
            acc_to: v.acc_to,
            amount: Number(v.amount),
            memo: v.memo,
            ts: nowTs(),
          });
          setOk(`transfer $${v.amount}: ${v.acc_from} → ${v.acc_to} (${id})`);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    };
  };

  /** Edit transaction — one wizard walks amount → memo → category. */
  const editTxForm = (): FormSpec | null => {
    if (transactions.length === 0) {
      setErr("no transactions");
      return null;
    }
    return {
      title: "Edit transaction — pick one",
      fields: [
        { type: "select", key: "id", label: "Transaction", options: txOptions() },
      ],
      onSubmit: (v) => {
        const tx = transactions.find((t) => t.id === v.id);
        if (!tx) return "not found";
        chain(editTxStep2(tx));
        return null;
      },
    };
  };
  const KEEP = "__keep__";
  const editTxStep2 = (tx: Transaction): FormSpec => {
    const catOpts = [
      { label: "— keep current —", value: KEEP },
      { label: "— none —", value: "" },
      ...categories.map((c) => ({ label: `${c.name} [${c.kind}]`, value: c.id })),
    ];
    const memoLabel = tx.memo
      ? `Memo (current: ${JSON.stringify(tx.memo)}, blank = keep)`
      : `Memo (blank = keep empty)`;
    return {
      title: `Edit tx ${tx.id}`,
      fields: [
        {
          type: "text",
          key: "amount",
          label: `Amount (current: $${tx.amount}, blank = keep)`,
          optional: true,
        },
        {
          type: "text",
          key: "memo",
          label: memoLabel,
          optional: true,
        },
        {
          type: "select",
          key: "category_id",
          label: `Category (current: ${tx.category_id ? categories.find((c) => c.id === tx.category_id)?.name ?? tx.category_id : "—"})`,
          options: catOpts,
        },
      ],
      onSubmit: (v) => {
        const changes: string[] = [];
        try {
          if (v.amount !== "") {
            const newAmount = Number(v.amount);
            if (!Number.isFinite(newAmount) || newAmount <= 0) {
              return `amount must be a positive number`;
            }
            if (newAmount !== tx.amount) {
              storeRef.current!.submit("edit_tx_amount", { id: tx.id, amount: newAmount });
              changes.push(`amount $${tx.amount}→$${newAmount}`);
            }
          }
          // Memo: blank submitted = "keep" (matches the label). Distinguishing
          // "blank = keep" from "intentionally clear" would require a sentinel
          // but keeping empty memos is the rarer case.
          if (v.memo !== "" && v.memo !== tx.memo) {
            storeRef.current!.submit("edit_tx_memo", { id: tx.id, memo: v.memo });
            changes.push(`memo`);
          }
          if (v.category_id !== KEEP) {
            const newCat = v.category_id || null;
            if (newCat !== tx.category_id) {
              storeRef.current!.submit("edit_tx_category", {
                id: tx.id,
                category_id: newCat,
              });
              changes.push(`category`);
            }
          }
          if (changes.length === 0) setInfo(`${tx.id} unchanged`);
          else setOk(`edited ${tx.id}: ${changes.join(", ")}`);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    };
  };
  const deleteTxForm = (): FormSpec | null => {
    if (transactions.length === 0) {
      setErr("no transactions");
      return null;
    }
    return {
      title: "Delete transaction",
      fields: [{ type: "select", key: "id", label: "Transaction", options: txOptions() }],
      onSubmit: (v) => {
        try {
          storeRef.current!.submit("delete_transaction", { id: v.id });
          setOk(`deleted tx ${v.id}`);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    };
  };

  // ─── keyboard ─────────────────────────────────────────────────────────
  useInput((raw, key) => {
    if (openError) {
      if (raw === "q") exit();
      return;
    }
    if (!store) return;

    if (mode === "form") {
      // handled by Wizard
      return;
    }
    if (mode === "submenu" && submenu) {
      if (key.escape) {
        setSubmenu(null);
        setMode("idle");
        return;
      }
      const h = submenu.handlers[raw];
      if (h) h();
      return;
    }
    if (mode === "retry") {
      if (key.escape) {
        setRetryInput("");
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
        setRetryInput("");
        setMode("retry");
      }
      return;
    }

    // Ignore inputs while syncing (except 'q'); a state-changing press during
    // an in-flight sync races with doSync's final setMode("idle").
    if (mode === "syncing") {
      if (raw === "q") exit();
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

    // Per-tab actions.
    const maybeOpen = (spec: FormSpec | null | undefined) => {
      if (spec) openForm(spec);
    };
    if (tab === "accounts") {
      if (raw === "n") maybeOpen(newAccountForm());
      else if (raw === "r") maybeOpen(renameAccountForm());
      else if (raw === "d") maybeOpen(deleteAccountForm());
    } else if (tab === "categories") {
      if (raw === "n") maybeOpen(newCategoryForm());
      else if (raw === "r") maybeOpen(renameCategoryForm());
      else if (raw === "d") maybeOpen(deleteCategoryForm());
    } else if (tab === "transactions") {
      if (raw === "n") {
        setSubmenu({
          title: "New transaction — pick kind",
          options: [
            ["i", "income (cash in)"],
            ["e", "expense (cash out)"],
            ["x", "transfer (between accounts)"],
          ],
          handlers: {
            i: () => {
              setSubmenu(null);
              maybeOpen(incomeForm());
            },
            e: () => {
              setSubmenu(null);
              maybeOpen(expenseForm());
            },
            x: () => {
              setSubmenu(null);
              maybeOpen(transferForm());
            },
          },
        });
        setMode("submenu");
      } else if (raw === "e") {
        maybeOpen(editTxForm());
      } else if (raw === "d") {
        maybeOpen(deleteTxForm());
      }
    }
  });

  // ─── render ───────────────────────────────────────────────────────────
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
  const showWaiting = !tablesExist && !store.isMaster;

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

      {showWaiting ? (
        <Box marginTop={1}>
          <Alert variant="info">
            <Text>
              no schema yet — waiting for master&apos;s initial sync. Run{" "}
              <Text bold>syncer sync</Text> between this host and master, then press{" "}
              <Text bold>[s]</Text> to re-sync.
            </Text>
          </Alert>
        </Box>
      ) : (
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
      )}

      {!store.isMaster && pendingActions.length > 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            pending ({pendingActions.length}):{" "}
            {pendingActions
              .map((e) =>
                e.kind === "action"
                  ? `seq=${e.seq}:${e.name}${e.force ? "(force)" : ""}`
                  : "",
              )
              .join(", ")}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>pending (0)</Text>
        </Box>
      )}

      {mode === "form" && form ? (
        <Box marginTop={1}>
          <Wizard
            form={form}
            values={formValues}
            setValues={setFormValues}
            current={formCurrent}
            setCurrent={setFormCurrent}
            textValue={formTextValue}
            setTextValue={setFormTextValue}
            fieldError={formFieldError}
            setFieldError={setFormFieldError}
            onFinish={(err) => {
              if (err === "cancelled") {
                closeForm();
                return;
              }
              if (err) {
                // stay on the last field with error
                setFormFieldError(err);
                return;
              }
              closeForm();
              bump();
            }}
          />
        </Box>
      ) : null}

      {mode === "submenu" && submenu ? (
        <Box marginTop={1}>
          <SubMenu title={submenu.title} options={submenu.options} />
        </Box>
      ) : null}

      {mode === "conflict" && conflict ? (
        <Box marginTop={1}>
          <ConflictPanel conflict={conflict} />
        </Box>
      ) : null}

      {mode === "retry" && conflict ? (
        <Box marginTop={1}>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="yellow"
            paddingX={1}
          >
            <Box>
              <Badge color="yellow">RETRY</Badge>
              <Text bold> prepend a transfer (topup), then retry</Text>
            </Box>
            <Text dimColor>syntax: "amount from-acc-id to-acc-id [memo]"</Text>
            <Box>
              <Text color="yellow">› </Text>
              <TextInput
                value={retryInput}
                onChange={setRetryInput}
                onSubmit={(val) => {
                  const parts = val.trim().split(/\s+/);
                  if (parts.length < 3) {
                    setErr(`retry expected "amount from-acc to-acc [memo]"`);
                    return;
                  }
                  const amount = Number(parts[0]);
                  if (!Number.isFinite(amount) || amount <= 0) {
                    setErr("amount must be a positive number");
                    return;
                  }
                  const [, acc_from, acc_to, ...memoParts] = parts;
                  const id = genId("topup");
                  try {
                    conflict.ctx.submit("create_transfer", {
                      id,
                      acc_from,
                      acc_to,
                      amount,
                      memo: memoParts.join(" "),
                      ts: nowTs(),
                    });
                    setOk(`prepended transfer ${id} — retrying`);
                    conflict.resolve("retry");
                    setConflict(null);
                    setMode("syncing");
                    setRetryInput("");
                  } catch (err) {
                    setErr(
                      `retry prepend failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                    setRetryInput("");
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
