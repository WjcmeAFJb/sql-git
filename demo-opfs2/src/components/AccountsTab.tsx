import { Pencil, Plus, Trash2 } from "lucide-react";
import type { Account } from "../../../demo/actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function AccountsTab({
  accounts,
  onNew,
  onRename,
  onDelete,
}: {
  accounts: Account[];
  onNew: () => void;
  onRename: (account: Account) => void;
  onDelete: (account: Account) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Accounts <span className="text-muted-foreground">({accounts.length})</span>
        </h2>
        <Button size="sm" onClick={onNew}>
          <Plus className="h-3 w-3" /> New
        </Button>
      </div>
      {accounts.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No accounts yet. Add the first one to start recording transactions.
        </div>
      ) : (
        <ul className="rounded-md border divide-y">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Badge variant="outline" className="font-mono text-[10px]">
                {a.id}
              </Badge>
              <span className="font-medium">{a.name}</span>
              <span
                className={cn(
                  "ml-auto font-mono tabular-nums",
                  a.balance > 0
                    ? "text-[hsl(var(--success))]"
                    : a.balance === 0
                      ? "text-muted-foreground"
                      : "text-destructive",
                )}
              >
                ${a.balance}
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  title="Rename"
                  onClick={() => onRename(a)}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 hover:text-destructive"
                  title="Delete"
                  onClick={() => onDelete(a)}
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
