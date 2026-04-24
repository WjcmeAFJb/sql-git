import { AlertTriangle, SkipForward, Zap, RotateCcw, X as XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PendingConflict } from "@/hooks/use-store";
import type { Resolution } from "../../../src/types";

/**
 * Non-modal conflict strip docked at the bottom of the app.
 *
 * Unlike a modal, this leaves the rest of the UI interactive — any
 * action the user submits via the tabs while a conflict is pending is
 * routed through `ctx.submit` in the resolver, and the app reads from
 * `ctx.rebasedDb` so those mitigations preview live. The user can then
 * Drop / Force / Retry knowing exactly what state they're resolving into.
 */
export function ConflictBar({
  conflict,
  onResolve,
}: {
  conflict: PendingConflict;
  onResolve: (r: Resolution) => void;
}) {
  const { ctx, queued } = conflict;
  const canForce = ctx.kind !== "error";
  const canRetry = queued.length > 0;

  return (
    <div className="border-t border-destructive/40 bg-destructive/5">
      <div className="flex flex-wrap items-start gap-4 px-4 py-3">
        <div className="flex shrink-0 flex-col items-start gap-1">
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="h-3 w-3" /> conflict
          </Badge>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            kind: {ctx.kind}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-xs">
            <span className="text-muted-foreground">action</span>:{" "}
            <span className="font-mono font-semibold">{ctx.action.name}</span>{" "}
            <span className="text-muted-foreground">· baseMasterSeq</span>{" "}
            {ctx.action.baseMasterSeq}{" "}
            <span className="text-muted-foreground">· masterSuffix</span>{" "}
            {ctx.masterSuffix.length}
          </div>
          <ScrollArea className="mt-1 max-h-20 rounded-sm border bg-muted/40 p-1.5">
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-tight">
              {JSON.stringify(ctx.action.params, null, 2)}
            </pre>
          </ScrollArea>
          {ctx.error ? (
            <p className="mt-1 text-xs text-destructive">
              error: {ctx.error.message}
            </p>
          ) : null}
          <p className="mt-1 text-[11px] text-muted-foreground">
            Any action you submit from the tabs is queued as a mitigation and
            applied before retry. The conflicting action stays pending until you
            pick one of the resolutions below.
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-1.5">
          <div className="mb-1 text-right text-[10px] uppercase text-muted-foreground">
            {queued.length} queued mitigation{queued.length === 1 ? "" : "s"}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onResolve("drop")}
            title="Discard the conflicting action; keep any queued mitigations"
          >
            <SkipForward className="h-3 w-3" /> Drop
          </Button>
          <Button
            size="sm"
            variant="warning"
            onClick={() => onResolve("force")}
            disabled={!canForce}
            title={
              canForce
                ? "Apply anyway (marks action as forced)"
                : "Cannot force — action errors on current state"
            }
          >
            <Zap className="h-3 w-3" /> Force
          </Button>
          <Button
            size="sm"
            onClick={() => onResolve("retry")}
            disabled={!canRetry}
            title={
              canRetry
                ? "Apply queued mitigations, then retry the action"
                : "Queue at least one mitigation first"
            }
          >
            <RotateCcw className="h-3 w-3" /> Retry
          </Button>
        </div>
      </div>

      {queued.length > 0 ? (
        <div className="border-t border-destructive/20 px-4 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            queued mitigations (applied before retry)
          </div>
          <ScrollArea className="max-h-20">
            <ol className="space-y-0.5 font-mono text-[11px]">
              {queued.map((q, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="shrink-0 text-muted-foreground">#{i + 1}</span>
                  <span className="shrink-0 font-semibold">{q.name}</span>
                  <span className="truncate text-muted-foreground">
                    {JSON.stringify(q.params)}
                  </span>
                </li>
              ))}
            </ol>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
}

/** Tiny icon re-export for parents that want a visible "conflict active" hint. */
export { XIcon };
