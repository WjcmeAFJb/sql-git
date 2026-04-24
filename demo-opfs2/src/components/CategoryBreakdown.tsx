import { observer } from "mobx-react-lite";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useBankQuery } from "@/hooks/use-sql-query";
import type { BankOrm } from "@/lib/orm";

type BreakdownRow = {
  id: string;
  name: string;
  kind: "income" | "expense" | "both";
  tx_count: number;
  total: number;
};

/**
 * Per-category totals driven by a Kysely-authored aggregate. Whenever the
 * ORM invalidates `transactions` or `categories` (which it does after every
 * submit and every sync), the underlying SqlQuery refetches and diff-patches
 * its rows — the component is `observer`-wrapped so only changed totals
 * trigger DOM updates.
 */
export const CategoryBreakdown = observer(function CategoryBreakdown({
  orm,
}: {
  orm: BankOrm | null;
}) {
  const { rows } = useBankQuery<BreakdownRow>(
    orm,
    (db) =>
      db
        .selectFrom("categories as c")
        .leftJoin("transactions as t", "t.category_id", "c.id")
        .select(["c.id", "c.name", "c.kind"])
        .select((eb) => eb.fn.count<number>("t.id").as("tx_count"))
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("t.amount"), eb.val(0)).as("total"))
        .groupBy("c.id")
        .orderBy("total", "desc"),
    [],
  );

  const grand = rows.reduce((sum, r) => sum + (r.total ?? 0), 0) || 1;

  return (
    <Card>
      <CardHeader className="p-3 pb-1">
        <CardTitle className="flex items-center gap-2 text-sm">
          Per-category breakdown
          <span className="text-xs font-normal text-muted-foreground">
            (kysely aggregate via reactive-orm)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 p-3 pt-1">
        {rows.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">
            No categories yet — add one under the Categories tab and this breakdown will populate as
            transactions are tagged with it.
          </p>
        ) : (
          rows.map((r) => (
            <Row
              key={r.id}
              name={r.name}
              kind={r.kind}
              total={r.total ?? 0}
              count={r.tx_count ?? 0}
              pct={((r.total ?? 0) / grand) * 100}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
});

function Row({
  name,
  kind,
  total,
  count,
  pct,
}: {
  name: string;
  kind: BreakdownRow["kind"];
  total: number;
  count: number;
  pct: number;
}) {
  const kindColor =
    kind === "income"
      ? "hsl(var(--success))"
      : kind === "expense"
        ? "hsl(var(--destructive))"
        : "hsl(var(--warning))";
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full" style={{ backgroundColor: kindColor }} />
          <span className="font-medium">{name}</span>
          <span className="text-[10px] uppercase text-muted-foreground">{kind}</span>
          <span className="text-[10px] text-muted-foreground">· {count} txs</span>
        </div>
        <span
          className={cn(
            "font-mono tabular-nums",
            total > 0 ? "text-[hsl(var(--success))]" : total === 0 ? "text-muted-foreground" : "text-destructive",
          )}
        >
          ${total}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded bg-muted">
        <div
          className="h-full"
          style={{ width: `${Math.max(0, Math.min(100, Math.abs(pct)))}%`, backgroundColor: kindColor }}
        />
      </div>
    </div>
  );
}
