import { Pencil, Plus, Trash2, ArrowRight } from "lucide-react";
import type { Account, Category, Transaction } from "../../../demo/actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function TransactionsTab({
  transactions,
  accounts,
  categories,
  onNewKind,
  onEdit,
  onDelete,
  newOpen,
  setNewOpen,
}: {
  transactions: Transaction[];
  accounts: Account[];
  categories: Category[];
  onNewKind: (kind: "income" | "expense" | "transfer") => void;
  onEdit: () => void;
  onDelete: () => void;
  newOpen: boolean;
  setNewOpen: (v: boolean) => void;
}) {
  const accName = (id: string | null) =>
    id ? (accounts.find((a) => a.id === id)?.name ?? id) : "·";
  const catName = (id: string | null) =>
    id ? (categories.find((c) => c.id === id)?.name ?? id) : "—";

  const last = transactions.slice(-20).slice().reverse();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Transactions <span className="text-muted-foreground">({transactions.length})</span>
        </h2>
        <div className="flex items-center gap-1">
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus className="h-3 w-3" /> New
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit} disabled={!transactions.length}>
            <Pencil className="h-3 w-3" /> Edit
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={onDelete}
            disabled={!transactions.length}
          >
            <Trash2 className="h-3 w-3" /> Delete
          </Button>
        </div>
      </div>
      {transactions.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No transactions yet. Income/expense/transfer between accounts starts here.
        </div>
      ) : (
        <ul className="rounded-md border divide-y">
          {last.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Badge
                className={cn(
                  "font-mono text-[10px]",
                  t.kind === "income" && "bg-[hsl(var(--success))] text-black",
                  t.kind === "expense" && "bg-destructive text-destructive-foreground",
                  t.kind === "transfer" && "bg-sky-500 text-white",
                )}
              >
                {t.kind}
              </Badge>
              <div className="flex items-center gap-1.5 font-mono text-xs">
                <span
                  className={t.kind === "income" ? "text-muted-foreground" : "text-foreground"}
                >
                  {t.kind === "income" ? "—" : accName(t.acc_from)}
                </span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span
                  className={t.kind === "expense" ? "text-muted-foreground" : "text-foreground"}
                >
                  {t.kind === "expense" ? "—" : accName(t.acc_to)}
                </span>
              </div>
              <span className="font-mono tabular-nums text-[hsl(var(--success))]">
                ${t.amount}
              </span>
              <span className="text-xs text-muted-foreground">{catName(t.category_id)}</span>
              {t.memo ? (
                <span className="truncate text-xs italic text-muted-foreground">
                  “{t.memo}”
                </span>
              ) : null}
              <span className="ml-auto text-[10px] text-muted-foreground font-mono">
                {t.id}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New transaction</DialogTitle>
            <DialogDescription>Pick the kind first.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setNewOpen(false);
                onNewKind("income");
              }}
            >
              Income <span className="text-xs text-muted-foreground ml-2">cash in</span>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setNewOpen(false);
                onNewKind("expense");
              }}
            >
              Expense <span className="text-xs text-muted-foreground ml-2">cash out</span>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setNewOpen(false);
                onNewKind("transfer");
              }}
            >
              Transfer <span className="text-xs text-muted-foreground ml-2">acct → acct</span>
            </Button>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
