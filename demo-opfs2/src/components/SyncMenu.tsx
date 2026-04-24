import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ArrowLeftRight,
  ArrowLeftToLine,
  ArrowRightToLine,
  FileText,
  FolderOpen,
  GitCompare,
  RefreshCcw,
} from "lucide-react";
import type { OpfsFs } from "../../../src/fs-opfs";
import {
  applySyncPlan,
  diffPeers,
  listPeerDirs,
  listPeerFiles,
  type FileEntry,
  type SyncPlan,
} from "@/lib/peer-dirs";

type PerPeer = { peerId: string; dir: string; files: FileEntry[] };

export function SyncMenu({
  open,
  onClose,
  opfs,
  currentPeerId,
  masterId,
  onTransferAffectsCurrent,
}: {
  open: boolean;
  onClose: () => void;
  opfs: OpfsFs | null;
  currentPeerId: string;
  masterId: string;
  /** Called after a transfer if the plan wrote into the current peer's dir,
   *  so the parent can kick off a store.sync() to pick up the new files. */
  onTransferAffectsCurrent: () => void;
}) {
  const [peers, setPeers] = useState<PerPeer[]>([]);
  const [loading, setLoading] = useState(false);
  const [peerA, setPeerA] = useState<string>("");
  const [peerB, setPeerB] = useState<string>("");
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [lastMsg, setLastMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!opfs) return;
    setLoading(true);
    setError(null);
    try {
      const ids = await listPeerDirs(opfs.fs, opfs.path, "/");
      const enriched: PerPeer[] = [];
      for (const id of ids) {
        const dir = `/${id}`;
        const files = await listPeerFiles(opfs.fs, opfs.path, dir);
        enriched.push({ peerId: id, dir, files });
      }
      setPeers(enriched);
      // Initialise A/B: prefer current peer as A, pick another as B.
      if (!peerA && ids.includes(currentPeerId)) setPeerA(currentPeerId);
      else if (!peerA && ids[0]) setPeerA(ids[0]);
      if (!peerB) {
        const other = ids.find((x) => x !== (peerA || currentPeerId));
        if (other) setPeerB(other);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [opfs, currentPeerId, peerA, peerB]);

  // Refresh when the menu opens so we always show fresh state.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Recompute plan when peers or their file lists change.
  useEffect(() => {
    if (!peerA || !peerB || peerA === peerB) {
      setPlan(null);
      return;
    }
    const a = peers.find((p) => p.peerId === peerA);
    const b = peers.find((p) => p.peerId === peerB);
    if (!a || !b) {
      setPlan(null);
      return;
    }
    setPlan(diffPeers(a.files, b.files, peerA, peerB, masterId));
  }, [peerA, peerB, peers, masterId]);

  const runSync = async () => {
    if (!opfs || !plan || !peerA || !peerB) return;
    setTransferring(true);
    setLastMsg(null);
    setError(null);
    try {
      await applySyncPlan(opfs.fs, opfs.path, `/${peerA}`, `/${peerB}`, plan);
      const total = plan.aToB.length + plan.bToA.length;
      setLastMsg(
        total === 0
          ? "nothing to transfer — dirs already in sync"
          : `transferred ${total} file(s): ${plan.aToB.length} ${peerA}→${peerB}, ${plan.bToA.length} ${peerB}→${peerA}`,
      );
      await refresh();
      // If this tab's peer had files written into (or out of) its dir, its
      // in-memory Store needs to re-read the logs. Our watcher ignores
      // same-tab writes (they fire with origin: "local"), so we notify
      // imperatively.
      const wroteIntoCurrent =
        (peerA === currentPeerId && plan.bToA.length > 0) ||
        (peerB === currentPeerId && plan.aToB.length > 0);
      if (wroteIntoCurrent) onTransferAffectsCurrent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferring(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent className="max-w-4xl sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5" /> File-sync operations
          </DialogTitle>
          <DialogDescription>
            Inspect every peer's OPFS folder and manually propagate files
            between two of them. Equivalent to running{" "}
            <code className="rounded bg-muted px-1 text-xs">
              syncer sync dir-a dir-b
            </code>{" "}
            — newest-wins bidirectional copy — but entirely in-browser.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive" className="text-xs">
            {error}
          </Alert>
        ) : null}
        {lastMsg ? (
          <Alert variant="success" className="text-xs">
            {lastMsg}
          </Alert>
        ) : null}

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              Peer directories{" "}
              <span className="text-muted-foreground">({peers.length})</span>
            </h3>
            <Button size="sm" variant="ghost" onClick={() => void refresh()}>
              <RefreshCcw className="h-3 w-3" /> Refresh
            </Button>
          </div>
          {loading ? (
            <p className="text-xs text-muted-foreground">scanning OPFS…</p>
          ) : peers.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No peer dirs yet — open another tab and pick a different peer.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {peers.map((p) => (
                <PeerCard key={p.peerId} peer={p} isCurrent={p.peerId === currentPeerId} />
              ))}
            </div>
          )}
        </section>

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Sync two peers</h3>
          <div className="grid grid-cols-[1fr_auto_1fr_auto] items-end gap-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Peer A</label>
              <Select value={peerA} onValueChange={setPeerA}>
                <SelectTrigger>
                  <SelectValue placeholder="pick…" />
                </SelectTrigger>
                <SelectContent>
                  {peers.map((p) => (
                    <SelectItem key={p.peerId} value={p.peerId}>
                      {p.peerId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="pb-1 text-muted-foreground">
              <ArrowLeftRight className="h-4 w-4" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Peer B</label>
              <Select value={peerB} onValueChange={setPeerB}>
                <SelectTrigger>
                  <SelectValue placeholder="pick…" />
                </SelectTrigger>
                <SelectContent>
                  {peers.map((p) => (
                    <SelectItem key={p.peerId} value={p.peerId}>
                      {p.peerId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => void runSync()}
              disabled={
                transferring ||
                !plan ||
                peerA === peerB ||
                plan.aToB.length + plan.bToA.length === 0
              }
            >
              <GitCompare className="h-3 w-3" /> Sync
            </Button>
          </div>

          {peerA && peerB && peerA !== peerB && plan ? (
            <SyncPlanView peerA={peerA} peerB={peerB} plan={plan} masterId={masterId} />
          ) : peerA === peerB ? (
            <p className="text-xs text-muted-foreground">
              pick two different peers to compare
            </p>
          ) : null}
        </section>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PeerCard({ peer, isCurrent }: { peer: PerPeer; isCurrent: boolean }) {
  const totalBytes = peer.files.reduce((sum, f) => sum + f.size, 0);
  return (
    <Card className={isCurrent ? "border-primary/40" : ""}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <FolderOpen className="h-3 w-3 text-amber-400" />
          <span className="font-mono">{peer.dir}</span>
          {isCurrent ? (
            <Badge variant="outline" className="ml-auto h-4 text-[9px]">
              this tab
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="mb-2 text-[10px] uppercase text-muted-foreground">
          {peer.files.length} files · {formatBytes(totalBytes)}
        </p>
        <ScrollArea className="max-h-28">
          <ul className="space-y-0.5 font-mono text-[11px]">
            {peer.files.length === 0 ? (
              <li className="italic text-muted-foreground">empty</li>
            ) : (
              peer.files.map((f) => (
                <li key={f.rel} className="flex items-center gap-1.5">
                  <FileText className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{f.rel}</span>
                  <span className="ml-auto text-muted-foreground">
                    {formatBytes(f.size)}
                  </span>
                </li>
              ))
            )}
          </ul>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function SyncPlanView({
  peerA,
  peerB,
  plan,
  masterId,
}: {
  peerA: string;
  peerB: string;
  plan: SyncPlan;
  masterId: string;
}) {
  const totalMoves = plan.aToB.length + plan.bToA.length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <GitCompare className="h-3 w-3" /> Transfer plan
          <Badge variant={totalMoves > 0 ? "warning" : "success"} className="ml-2 h-5">
            {totalMoves === 0 ? "in sync" : `${totalMoves} file(s) will move`}
          </Badge>
          <span className="text-[10px] font-normal text-muted-foreground">
            snapshot.db is master-write-only; peer logs flow only from their owner
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 pt-0 sm:grid-cols-2">
        <DirectionList
          title={`${peerA}${peerA === masterId ? " (master)" : ""} → ${peerB}${peerB === masterId ? " (master)" : ""}`}
          icon={<ArrowRightToLine className="h-3 w-3 text-sky-400" />}
          items={plan.aToB}
        />
        <DirectionList
          title={`${peerB}${peerB === masterId ? " (master)" : ""} → ${peerA}${peerA === masterId ? " (master)" : ""}`}
          icon={<ArrowLeftToLine className="h-3 w-3 text-emerald-400" />}
          items={plan.bToA}
        />
        {plan.skipped.length > 0 ? (
          <div className="col-span-full space-y-0.5 pt-2 text-[11px]">
            <div className="mb-1 font-medium text-[hsl(var(--warning))]">
              {plan.skipped.length} skipped by ownership rules
            </div>
            <ul className="space-y-0.5 font-mono">
              {plan.skipped.map((s) => (
                <li key={s.rel} className="text-muted-foreground">
                  <span className="text-[hsl(var(--warning))]">skip</span>{" "}
                  <span className="font-semibold">{s.rel}</span>{" "}
                  <span className="text-[10px]">({s.direction})</span> — {s.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {plan.same.length > 0 ? (
          <div className="col-span-full pt-1 text-[11px] text-muted-foreground">
            {plan.same.length} file(s) identical on both sides —{" "}
            <span className="truncate font-mono">{plan.same.join(", ")}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DirectionList({
  title,
  icon,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  items: Array<{ rel: string; reason: "new" | "newer"; size: number }>;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">
        {icon}
        <span className="font-mono">{title}</span>
        <span className="ml-auto text-muted-foreground">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">no files</p>
      ) : (
        <ul className="space-y-0.5 font-mono text-[11px]">
          {items.map((f) => (
            <li key={f.rel} className="flex items-center gap-1.5">
              <FileText className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{f.rel}</span>
              <Badge
                variant={f.reason === "new" ? "secondary" : "outline"}
                className="h-3.5 px-1 text-[9px]"
              >
                {f.reason}
              </Badge>
              <span className="ml-auto text-muted-foreground">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}
