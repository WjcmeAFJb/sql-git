import { observer } from "mobx-react-lite";
import { sql } from "kysely";
import { ArrowDownRight, ArrowUpRight, Wallet, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useBankQuery } from "@/hooks/use-sql-query";
import type { BankOrm } from "@/lib/orm";

/**
 * Overall aggregate stats across the current peer's view of the cluster.
 * Everything here is a scalar aggregate running through the reactive ORM,
 * so submitting an action or pulling a remote log via the file-sync menu
 * invalidates the underlying tables and these numbers re-render in place.
 */
export const StatsPanel = observer(function StatsPanel({ orm }: { orm: BankOrm | null }) {
  const overall = useBankQuery<{
    netBalance: number;
    totalIncome: number;
    totalExpense: number;
    accountCount: number;
    txCount: number;
  }>(
    orm,
    (db) =>
      db.selectNoFrom([
        sql<number>`COALESCE((SELECT SUM(balance) FROM accounts), 0)`.as("netBalance"),
        sql<number>`COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='income'), 0)`.as(
          "totalIncome",
        ),
        sql<number>`COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='expense'), 0)`.as(
          "totalExpense",
        ),
        sql<number>`(SELECT COUNT(*) FROM accounts)`.as("accountCount"),
        sql<number>`(SELECT COUNT(*) FROM transactions)`.as("txCount"),
      ]),
    [],
  );

  const row = overall.rows[0];
  const net = row?.netBalance ?? 0;
  const inc = row?.totalIncome ?? 0;
  const exp = row?.totalExpense ?? 0;
  const accts = row?.accountCount ?? 0;
  const txs = row?.txCount ?? 0;

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Stat
        icon={<Wallet className="h-4 w-4" />}
        label="Net balance"
        value={formatMoney(net)}
        tone={net > 0 ? "success" : net === 0 ? "muted" : "destructive"}
        sub={`across ${accts} account${accts === 1 ? "" : "s"}`}
      />
      <Stat
        icon={<ArrowUpRight className="h-4 w-4" />}
        label="Total income"
        value={formatMoney(inc)}
        tone="success"
      />
      <Stat
        icon={<ArrowDownRight className="h-4 w-4" />}
        label="Total expense"
        value={formatMoney(exp)}
        tone="destructive"
      />
      <Stat
        icon={<Activity className="h-4 w-4" />}
        label="Transactions"
        value={String(txs)}
        tone="muted"
        sub={`income + expense + transfer`}
      />
    </div>
  );
});

function Stat({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone: "success" | "destructive" | "muted";
}) {
  return (
    <Card>
      <CardHeader className="p-3 pb-0">
        <CardTitle className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          {icon} {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-1">
        <div
          className={cn(
            "text-lg font-mono font-semibold tabular-nums",
            tone === "success" && "text-[hsl(var(--success))]",
            tone === "destructive" && "text-destructive",
            tone === "muted" && "text-foreground",
          )}
        >
          {value}
        </div>
        {sub ? <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}

function formatMoney(n: number): string {
  return `$${n.toLocaleString()}`;
}
