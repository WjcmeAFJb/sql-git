import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowDown, ArrowRight, ArrowUp, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Account, Category } from "../../../demo/actions";

type TxKind = "income" | "expense" | "transfer";

export type NewTxValues =
  | {
      kind: "income";
      amount: number;
      acc_to: string;
      category_id: string | null;
      memo: string;
    }
  | {
      kind: "expense";
      amount: number;
      acc_from: string;
      category_id: string | null;
      memo: string;
    }
  | {
      kind: "transfer";
      amount: number;
      acc_from: string;
      acc_to: string;
      memo: string;
    };

const EMPTY = "__empty__";

export function NewTransactionDialog({
  open,
  onClose,
  accounts,
  categories,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  accounts: Account[];
  categories: Category[];
  onSubmit: (v: NewTxValues) => Promise<string | null>;
}) {
  const [kind, setKind] = useState<TxKind>("income");
  const [amount, setAmount] = useState("");
  const [accFrom, setAccFrom] = useState("");
  const [accTo, setAccTo] = useState("");
  const [categoryId, setCategoryId] = useState(EMPTY);
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset when reopened.
  useEffect(() => {
    if (!open) return;
    setKind("income");
    setAmount("");
    setAccFrom(accounts[0]?.id ?? "");
    setAccTo(accounts[0]?.id ?? "");
    setCategoryId(EMPTY);
    setMemo("");
    setError(null);
    setSubmitting(false);
  }, [open, accounts]);

  // When kind flips, make sure from≠to defaults and categoryId is valid.
  useEffect(() => {
    if (kind === "transfer" && accFrom === accTo && accounts.length >= 2) {
      const other = accounts.find((a) => a.id !== accFrom);
      if (other) setAccTo(other.id);
    }
    if (kind === "transfer") {
      setCategoryId(EMPTY);
    }
  }, [kind, accounts, accFrom, accTo]);

  // Don't memo by `[kind, categories]` — the reactive ORM returns a MobX-
  // proxied array whose reference is stable across updates, so useMemo
  // would never re-run. Re-filtering on every render is cheap.
  const filteredCategories: Category[] =
    kind === "transfer"
      ? []
      : categories.filter((c) => c.kind === kind || c.kind === "both");


  // Snap a dropped-selection back to a valid option when filter changes.
  useEffect(() => {
    if (kind === "transfer") return;
    if (categoryId === EMPTY) return;
    if (!filteredCategories.some((c) => c.id === categoryId)) {
      setCategoryId(EMPTY);
    }
  }, [filteredCategories, categoryId, kind]);

  const cannotTransfer = kind === "transfer" && accounts.length < 2;
  const noAccounts = accounts.length === 0;

  const handleSubmit = async () => {
    if (noAccounts) {
      setError("create an account first");
      return;
    }
    if (cannotTransfer) {
      setError("need at least two accounts for a transfer");
      return;
    }
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError("amount must be a positive number");
      return;
    }
    if (kind === "transfer" && accFrom === accTo) {
      setError("from and to must differ");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const cat = categoryId === EMPTY ? null : categoryId;
      let res: string | null;
      if (kind === "income") {
        if (!accTo) {
          setError("select an account");
          return;
        }
        res = await onSubmit({ kind, amount: n, acc_to: accTo, category_id: cat, memo });
      } else if (kind === "expense") {
        if (!accFrom) {
          setError("select an account");
          return;
        }
        res = await onSubmit({
          kind,
          amount: n,
          acc_from: accFrom,
          category_id: cat,
          memo,
        });
      } else {
        res = await onSubmit({
          kind,
          amount: n,
          acc_from: accFrom,
          acc_to: accTo,
          memo,
        });
      }
      if (res === null) onClose();
      else setError(res);
    } finally {
      setSubmitting(false);
    }
  };

  const accountOptions = accounts.map((a) => ({
    label: `${a.name} · $${a.balance}`,
    value: a.id,
  }));

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New transaction</DialogTitle>
          <DialogDescription>
            Pick a kind, then fill the fields — all at once.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <div className="grid grid-cols-3 gap-1.5">
              <KindButton
                testId="ntx-kind-income"
                active={kind === "income"}
                onClick={() => setKind("income")}
                icon={<ArrowDown className="h-3 w-3" />}
                label="Income"
                tone="success"
              />
              <KindButton
                testId="ntx-kind-expense"
                active={kind === "expense"}
                onClick={() => setKind("expense")}
                icon={<ArrowUp className="h-3 w-3" />}
                label="Expense"
                tone="destructive"
              />
              <KindButton
                testId="ntx-kind-transfer"
                active={kind === "transfer"}
                onClick={() => setKind("transfer")}
                icon={<ArrowRight className="h-3 w-3" />}
                label="Transfer"
                tone="sky"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ntx-amount">Amount</Label>
            <Input
              id="ntx-amount"
              autoFocus
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          {kind === "income" || kind === "transfer" ? (
            <div className="space-y-1.5">
              <Label htmlFor="ntx-acc-to">
                {kind === "transfer" ? "To account" : "Into account"}
              </Label>
              <AccountSelect
                id="ntx-acc-to"
                value={accTo}
                onChange={setAccTo}
                options={accountOptions}
                disabled={noAccounts}
              />
            </div>
          ) : null}

          {kind === "expense" || kind === "transfer" ? (
            <div className="space-y-1.5">
              <Label htmlFor="ntx-acc-from">
                {kind === "transfer" ? "From account" : "From account"}
              </Label>
              <AccountSelect
                id="ntx-acc-from"
                value={accFrom}
                onChange={setAccFrom}
                options={accountOptions}
                disabled={noAccounts}
              />
            </div>
          ) : null}

          {kind !== "transfer" ? (
            <div className="space-y-1.5">
              <Label htmlFor="ntx-category">Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="ntx-category">
                  <SelectValue placeholder="— none —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EMPTY}>— none —</SelectItem>
                  {filteredCategories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}{" "}
                      <span className="text-muted-foreground">[{c.kind}]</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filteredCategories.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  no {kind} categories — add one in the Categories tab
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="ntx-memo">Memo (optional)</Label>
            <Input
              id="ntx-memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder=""
            />
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || noAccounts || cannotTransfer}
          >
            <Check className="h-3 w-3" /> {submitting ? "Submitting…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KindButton({
  active,
  onClick,
  icon,
  label,
  tone,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tone: "success" | "destructive" | "sky";
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
        active
          ? tone === "success"
            ? "border-[hsl(var(--success))] bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]"
            : tone === "destructive"
              ? "border-destructive bg-destructive/15 text-destructive"
              : "border-sky-500 bg-sky-500/15 text-sky-500"
          : "border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function AccountSelect({
  id,
  value,
  onChange,
  options,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ label: string; value: string }>;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={disabled ? "no accounts" : "Select…"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
