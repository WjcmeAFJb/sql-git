import { useRef, useState } from "react";
import { ChevronsDown, Play, Terminal, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import type { BankOrm } from "@/lib/orm";

type SqlResult =
  | { kind: "idle" }
  | { kind: "ok"; action: string }
  | { kind: "rows"; rows: Record<string, unknown>[] }
  | { kind: "error"; message: string };

const SAMPLES: { label: string; sql: string }[] = [
  {
    label: "Top expenses",
    sql: "SELECT id, amount, memo, acc_from FROM transactions\nWHERE kind = 'expense'\nORDER BY amount DESC\nLIMIT 10;",
  },
  {
    label: "Balance per account",
    sql: "SELECT name, balance FROM accounts ORDER BY balance DESC;",
  },
  {
    label: "Spend by category",
    sql: "SELECT c.name, COUNT(t.id) AS n, SUM(t.amount) AS total\n  FROM categories c\n  LEFT JOIN transactions t ON t.category_id = c.id\n  WHERE t.kind = 'expense'\n  GROUP BY c.id\n  ORDER BY total DESC;",
  },
  {
    label: "EXPLAIN QUERY PLAN",
    sql: "EXPLAIN QUERY PLAN SELECT * FROM transactions WHERE kind = 'expense';",
  },
];

/**
 * Floating SQL console.
 *
 * Reads (SELECT / WITH / PRAGMA / EXPLAIN) go through `orm.driver.all` so
 * the query joins the ORM's reactivity graph and re-runs on mutation.
 *
 * Writes go through `store.submit("exec_sql", { sql })` — the `exec_sql`
 * action in `bankActions` applies the statement deterministically on
 * every peer, so a console mutation on one tab lands in master's log and
 * replicates like a regular action. That keeps the demo honest about the
 * replicated-log model and avoids the "won't replicate" escape hatch the
 * previous direct-driver path had.
 */
export function SqlConsole({
  orm,
  submit,
  ready,
}: {
  orm: BankOrm | null;
  submit: (name: string, params: unknown) => Promise<string | null>;
  ready: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(SAMPLES[0]!.sql);
  const [result, setResult] = useState<SqlResult>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isMutation = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|CREATE|VACUUM)\b/i.test(text);

  async function run(): Promise<void> {
    if (!orm || !ready) return;
    const trimmed = text.trim().replace(/;+\s*$/, "");
    if (!trimmed) return;
    setBusy(true);
    try {
      if (/^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed)) {
        const rows = await orm.driver.all<Record<string, unknown>>(trimmed);
        setResult({ kind: "rows", rows });
      } else {
        // Route through sql-git's action log so the statement replicates.
        const err = await submit("exec_sql", { sql: trimmed });
        if (err) setResult({ kind: "error", message: err });
        else setResult({ kind: "ok", action: "exec_sql" });
      }
    } catch (e) {
      setResult({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 shadow-lg"
        size="sm"
      >
        <Terminal className="h-3.5 w-3.5" /> SQL
      </Button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex max-h-[70vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col rounded-lg border bg-background shadow-2xl">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          <span className="text-sm font-medium">SQL console</span>
          <span className="text-[10px] text-muted-foreground">
            routed through <code className="rounded bg-muted px-1">orm.driver</code>
          </span>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setOpen(false)} title="Close">
          <ChevronsDown className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-1 border-b px-3 py-2">
        {SAMPLES.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => setText(s.sql)}
            className="rounded border bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {s.label}
          </button>
        ))}
      </div>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void run();
          }
        }}
        spellCheck={false}
        className="h-36 resize-none bg-muted/20 p-3 font-mono text-[12px] leading-relaxed outline-none"
      />

      <div className="flex items-center justify-between border-t px-3 py-2">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px]">⌘/Ctrl</kbd> +{" "}
          <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px]">Enter</kbd>
        </div>
        <Button size="sm" onClick={() => void run()} disabled={busy || !orm || !ready}>
          <Play className="h-3 w-3" /> {busy ? "Running…" : "Run"}
        </Button>
      </div>

      {isMutation ? (
        <Alert variant="info" className="mx-3 mb-2 flex items-start gap-1.5 text-[11px]">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Writes are submitted as an{" "}
            <code className="rounded bg-muted px-1">exec_sql</code> action — logged, rebased, and
            replicated to every peer like a built-in action. The statement must be deterministic
            (avoid <code>RANDOM()</code>, <code>datetime('now')</code>, etc.).
          </span>
        </Alert>
      ) : null}

      <ResultView result={result} />
    </div>
  );
}

function ResultView({ result }: { result: SqlResult }) {
  if (result.kind === "idle") {
    return (
      <div className="min-h-12 border-t px-3 py-3 text-xs text-muted-foreground">
        Run a SELECT to preview rows, or ⌘/Ctrl+Enter a mutation.
      </div>
    );
  }
  if (result.kind === "error") {
    return (
      <div className="min-h-12 overflow-auto border-t">
        <pre className="whitespace-pre-wrap px-3 py-3 text-xs text-destructive">
          {result.message}
        </pre>
      </div>
    );
  }
  if (result.kind === "ok") {
    return (
      <div className="min-h-12 border-t px-3 py-3 text-xs">
        <span className="font-medium text-[hsl(var(--success))]">✓ submitted</span>{" "}
        <span className="text-muted-foreground">
          as <code className="rounded bg-muted px-1">{result.action}</code> — action appended to
          your peer log; ORM refetched, UI above will reflect the change once sync lands it.
        </span>
      </div>
    );
  }
  const rows = result.rows;
  if (rows.length === 0) {
    return (
      <div className="min-h-12 border-t px-3 py-3 text-xs text-muted-foreground">
        Query returned 0 rows.
      </div>
    );
  }
  const cols = Object.keys(rows[0]!);
  return (
    <div className="min-h-12 max-h-[32vh] overflow-auto border-t">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
          <tr>
            {cols.map((c) => (
              <th key={c} className="px-2 py-1 text-left font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn("border-t border-border/60")}>
              {cols.map((c) => (
                <td key={c} className="px-2 py-0.5 tabular-nums text-muted-foreground">
                  {formatCell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}
