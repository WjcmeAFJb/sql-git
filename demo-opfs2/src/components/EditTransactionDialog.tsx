import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
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
import { Check } from "lucide-react";
import type { Category, Transaction } from "../../../demo/actions";

const EMPTY = "__empty__";

export type EditTxChanges = {
  amount?: number;
  memo?: string;
  category_id?: string | null;
};

export function EditTransactionDialog({
  tx,
  open,
  onClose,
  categories,
  onSubmit,
}: {
  tx: Transaction | null;
  open: boolean;
  onClose: () => void;
  categories: Category[];
  onSubmit: (id: string, changes: EditTxChanges) => Promise<string | null>;
}) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [categoryId, setCategoryId] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!tx || !open) return;
    setAmount(String(tx.amount));
    setMemo(tx.memo ?? "");
    setCategoryId(tx.category_id ?? EMPTY);
    setError(null);
    setSubmitting(false);
  }, [tx, open]);

  // Re-filter each render — the reactive ORM hands us a MobX-proxied array
  // whose reference is stable, so useMemo by `[categories, tx]` would cache
  // a stale empty result. Cheap filter, fine to run every paint.
  const filteredCategories =
    !tx || tx.kind === "transfer"
      ? []
      : categories.filter((c) => c.kind === tx.kind || c.kind === "both");

  if (!tx) return null;

  const handleSubmit = async () => {
    const changes: EditTxChanges = {};
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError("amount must be a positive number");
      return;
    }
    if (n !== tx.amount) changes.amount = n;
    if (memo !== tx.memo) changes.memo = memo;
    const newCat = categoryId === EMPTY ? null : categoryId;
    if (newCat !== tx.category_id) changes.category_id = newCat;
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await onSubmit(tx.id, changes);
      if (res === null) onClose();
      else setError(res);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Edit <span className="font-mono text-xs">{tx.id}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="etx-amount">Amount</Label>
            <Input
              id="etx-amount"
              autoFocus
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="etx-memo">Memo</Label>
            <Input
              id="etx-memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>

          {tx.kind !== "transfer" ? (
            <div className="space-y-1.5">
              <Label htmlFor="etx-category">Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="etx-category">
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
                  no {tx.kind} categories available
                </p>
              ) : null}
            </div>
          ) : null}
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
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            <Check className="h-3 w-3" /> {submitting ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
