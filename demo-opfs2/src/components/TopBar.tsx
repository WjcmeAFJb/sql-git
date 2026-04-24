import { Loader2, RefreshCcw, LogOut, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import type { Mode, Status } from "@/hooks/use-store";

export function TopBar({
  peerId,
  masterId,
  head,
  mode,
  status,
  pending,
  onSync,
  onOpenSyncMenu,
  onSwitchPeer,
}: {
  peerId: string;
  masterId: string;
  head: number;
  mode: Mode;
  status: Status;
  pending: number;
  onSync: () => void;
  onOpenSyncMenu: () => void;
  onSwitchPeer: () => void;
}) {
  const alertVariant =
    status.kind === "success"
      ? "success"
      : status.kind === "error"
        ? "destructive"
        : status.kind === "warning"
          ? "warning"
          : "info";
  return (
    <div className="border-b bg-muted/30">
      <div className="flex items-center gap-3 px-4 py-2">
        <h1 className="text-sm font-semibold">
          <span className="text-primary">sql-git</span>{" "}
          <span className="text-muted-foreground">·</span>{" "}
          <span className="font-mono text-xs text-muted-foreground">OPFS bank demo</span>
        </h1>
        <div className="h-5 w-px bg-border" />
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">peer</span>
          <Badge variant={peerId === masterId ? "warning" : "secondary"} className="font-mono">
            {peerId}
            {peerId === masterId ? " (master)" : ""}
          </Badge>
        </div>
        {peerId !== masterId ? (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">master</span>
            <Badge variant="outline" className="font-mono">
              {masterId}
            </Badge>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">head</span>
          <Badge variant="outline" className="font-mono">
            {head}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">mode</span>
          <span
            className={cn(
              "font-mono uppercase",
              mode === "idle" && "text-[hsl(var(--success))]",
              mode === "syncing" && "text-sky-400",
              mode === "conflict" && "text-destructive",
              mode === "error" && "text-destructive",
              mode === "opening" && "text-muted-foreground",
            )}
          >
            {mode === "syncing" ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> syncing
              </span>
            ) : (
              mode
            )}
          </span>
        </div>
        {pending > 0 ? (
          <Badge variant="warning" className="ml-1">
            {pending} pending
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={onSync}
            disabled={mode === "syncing" || mode === "opening"}
          >
            <RefreshCcw className="h-3 w-3" /> Sync
          </Button>
          <Button size="sm" variant="outline" onClick={onOpenSyncMenu}>
            <HardDrive className="h-3 w-3" /> File-sync
          </Button>
          <Button size="sm" variant="ghost" onClick={onSwitchPeer} title="Switch peer">
            <LogOut className="h-3 w-3" /> Switch
          </Button>
        </div>
      </div>
      <div className="px-4 pb-2">
        <Alert variant={alertVariant} className="text-xs">
          {status.message}
        </Alert>
      </div>
    </div>
  );
}
