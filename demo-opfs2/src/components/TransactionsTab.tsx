import { Pencil, Plus, Trash2, ArrowRight } from "lucide-react";
import type { Account, Category, Transaction } from "../../../demo/actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function TransactionsTab({
  transactions,
  accounts,
  categories,
  onNew,
  onEdit,
  onDelete,
}: {
  transactions: Transaction[];
  accounts: Account[];
  categories: Category[];
  onNew: () => void;
  onEdit: (tx: Transaction) => void;
  onDelete: (tx: Transaction) => void;
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
        <Button size="sm" onClick={onNew}>
          <Plus className="h-3 w-3" /> New
        </Button>
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
              <div className="flex items-center gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  title="Edit"
                  onClick={() => onEdit(t)}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 hover:text-destructive"
                  title="Delete"
                  onClick={() => onDelete(t)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
