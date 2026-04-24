import type { Account } from "../../../demo/actions";
import { cn } from "@/lib/utils";

export function BalanceStrip({ accounts }: { accounts: Account[] }) {
  if (accounts.length === 0) {
    return (
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <span>balances:</span>
        <span className="italic">no accounts yet — create one in the Accounts tab</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2 text-xs">
      <span className="text-muted-foreground">balances:</span>
      {accounts.map((a) => (
        <div key={a.id} className="flex items-center gap-1.5 font-mono">
          <span className="text-muted-foreground">{a.name}</span>
          <span
            className={cn(
              "tabular-nums",
              a.balance > 0 ? "text-[hsl(var(--success))]" : "text-muted-foreground",
            )}
          >
            ${a.balance}
          </span>
        </div>
      ))}
    </div>
  );
}
