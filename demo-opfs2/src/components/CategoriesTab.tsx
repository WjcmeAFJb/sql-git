import { Pencil, Plus, Trash2 } from "lucide-react";
import type { Category } from "../../../demo/actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function CategoriesTab({
  categories,
  onNew,
  onRename,
  onDelete,
}: {
  categories: Category[];
  onNew: () => void;
  onRename: (category: Category) => void;
  onDelete: (category: Category) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Categories <span className="text-muted-foreground">({categories.length})</span>
        </h2>
        <Button size="sm" onClick={onNew}>
          <Plus className="h-3 w-3" /> New
        </Button>
      </div>
      {categories.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No categories yet. Add one to tag your income/expense transactions.
        </div>
      ) : (
        <ul className="rounded-md border divide-y">
          {categories.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Badge variant="outline" className="font-mono text-[10px]">
                {c.id}
              </Badge>
              <span className="font-medium">{c.name}</span>
              <span
                className={cn(
                  "ml-auto font-mono uppercase text-[10px]",
                  c.kind === "income" && "text-[hsl(var(--success))]",
                  c.kind === "expense" && "text-destructive",
                  c.kind === "both" && "text-[hsl(var(--warning))]",
                )}
              >
                {c.kind}
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  title="Rename"
                  onClick={() => onRename(c)}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 hover:text-destructive"
                  title="Delete"
                  onClick={() => onDelete(c)}
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
