import { useMemo } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Eye, History, PlayCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MasterLogEntry, PeerLogEntry } from "../../../src/types";
import type { WatchEvent } from "@/hooks/use-watcher";
import type { QueuedAction } from "@/hooks/use-store";

/**
 * Right-hand sidebar with two tabs:
 *   Actions — log of master + own-peer + queued mitigations, oldest-first
 *             inverted (newest on top, like a commit log).
 *   Events  — raw FsEvents from the OPFS adapter, same as before.
 */
export function HistorySidebar({
  masterLog,
  peerLog,
  queued,
  events,
  peerId,
}: {
  masterLog: MasterLogEntry[];
  peerLog: PeerLogEntry[];
  queued: QueuedAction[];
  events: WatchEvent[];
  peerId: string;
}) {
  const rows = useMemo(() => buildRows(masterLog, peerLog, queued, peerId), [
    masterLog,
    peerLog,
    queued,
    peerId,
  ]);

  return (
    <aside className="flex w-[320px] min-w-[320px] flex-col border-l">
      <Tabs defaultValue="actions" className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <TabsList className="h-7">
            <TabsTrigger value="actions" className="h-6 gap-1 px-2 text-xs">
              <History className="h-3 w-3" /> Actions
            </TabsTrigger>
            <TabsTrigger value="events" className="h-6 gap-1 px-2 text-xs">
              <Eye className="h-3 w-3" /> Events
            </TabsTrigger>
          </TabsList>
          <span className="text-[10px] font-normal uppercase text-muted-foreground">
            cross-tab live
          </span>
        </div>

        <TabsContent value="actions" className="mt-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <p className="p-3 text-xs italic text-muted-foreground">
              no actions yet — submit one from a tab
            </p>
          ) : (
            <ol className="divide-y text-xs">
              {rows.map((r, i) => (
                <ActionRow key={`${r.bucket}-${r.seq ?? i}`} row={r} peerId={peerId} />
              ))}
            </ol>
          )}
        </TabsContent>

        <TabsContent value="events" className="mt-0 flex-1 overflow-auto">
          {events.length === 0 ? (
            <p className="p-3 text-xs italic text-muted-foreground">
              no events yet — open another tab and act as a different peer,
              run a file-sync, or submit an action here
            </p>
          ) : (
            <ul className="divide-y text-xs font-mono">
              {events.map((e, i) => (
                <li key={i} className="p-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded px-1 text-[9px] uppercase",
                        e.origin === "local"
                          ? "bg-secondary text-secondary-foreground"
                          : "bg-amber-500/20 text-amber-400",
                      )}
                    >
                      {e.origin}
                    </span>
                    <span className="font-semibold">{e.type}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {new Date(e.at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-muted-foreground">
                    {"path" in e ? e.path : `${e.from} → ${e.to}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

type Bucket = "master" | "peer-pending" | "queued" | "ack" | "snapshot";
type Row = {
  bucket: Bucket;
  /** Seq in the bucket's numbering — master seq for master, peer seq for peer. */
  seq?: number;
  name?: string;
  params?: unknown;
  /** Who authored it (master row only). */
  sourcePeer?: string;
  sourceSeq?: number;
  forced?: boolean;
  force?: boolean;
  extra?: string;
};

function buildRows(
  masterLog: MasterLogEntry[],
  peerLog: PeerLogEntry[],
  queued: QueuedAction[],
  _peerId: string,
): Row[] {
  const rows: Row[] = [];

  // Master log — action + snapshot + peer_ack entries. Reverse so newest is
  // on top; that matches how a commit log reads.
  const masterRows: Row[] = [];
  for (const e of masterLog) {
    if (e.kind === "action") {
      masterRows.push({
        bucket: "master",
        seq: e.seq,
        name: e.name,
        params: e.params,
        sourcePeer: e.source.peer,
        sourceSeq: e.source.seq,
        forced: e.forced,
      });
    } else if (e.kind === "snapshot") {
      masterRows.push({
        bucket: "snapshot",
        seq: e.masterSeq,
        extra: `snapshot@${e.masterSeq}`,
      });
    } else if (e.kind === "peer_ack") {
      masterRows.push({
        bucket: "ack",
        seq: e.masterSeq,
        extra: `${e.peer} acked @${e.masterSeq}`,
      });
    }
  }

  // Peer pending log — live peer actions that haven't been incorporated yet.
  const peerRows: Row[] = [];
  for (const e of peerLog) {
    if (e.kind === "action") {
      peerRows.push({
        bucket: "peer-pending",
        seq: e.seq,
        name: e.name,
        params: e.params,
        force: e.force,
      });
    }
  }

  // Queued mitigations — transient, live during the active conflict only.
  const queuedRows: Row[] = queued.map((q, i) => ({
    bucket: "queued",
    seq: i + 1,
    name: q.name,
    params: q.params,
  }));

  // Newest on top: queued (most-recent), then peer pending, then master.
  rows.push(...queuedRows.slice().reverse());
  rows.push(...peerRows.slice().reverse());
  rows.push(...masterRows.slice().reverse());
  return rows;
}

function ActionRow({ row, peerId }: { row: Row; peerId: string }) {
  const selfAuthored =
    row.bucket === "master" && row.sourcePeer === peerId;
  return (
    <li className="p-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        <StatusBadge bucket={row.bucket} forced={row.forced || row.force} />
        {row.seq !== undefined ? (
          <span className="font-mono text-muted-foreground">
            {row.bucket === "master"
              ? `#${row.seq}`
              : row.bucket === "peer-pending"
                ? `p#${row.seq}`
                : row.bucket === "queued"
                  ? `q#${row.seq}`
                  : `@${row.seq}`}
          </span>
        ) : null}
        {row.name ? (
          <span className="font-mono font-semibold">{row.name}</span>
        ) : null}
        {row.sourcePeer && row.bucket === "master" ? (
          <span className="ml-auto rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
            {selfAuthored ? "self" : row.sourcePeer}/{row.sourceSeq}
          </span>
        ) : null}
      </div>
      {row.params !== undefined ? (
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
          {JSON.stringify(row.params)}
        </div>
      ) : row.extra ? (
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
          {row.extra}
        </div>
      ) : null}
    </li>
  );
}

function StatusBadge({
  bucket,
  forced,
}: {
  bucket: Bucket;
  forced?: boolean;
}) {
  if (bucket === "master") {
    return (
      <Badge variant={forced ? "warning" : "success"} className="h-4 gap-1 px-1 text-[9px]">
        <PlayCircle className="h-2.5 w-2.5" />
        {forced ? "forced" : "applied"}
      </Badge>
    );
  }
  if (bucket === "peer-pending") {
    return (
      <Badge variant={forced ? "warning" : "secondary"} className="h-4 px-1 text-[9px]">
        {forced ? "force-pending" : "pending"}
      </Badge>
    );
  }
  if (bucket === "queued") {
    return (
      <Badge variant="destructive" className="h-4 px-1 text-[9px]">
        queued
      </Badge>
    );
  }
  if (bucket === "snapshot") {
    return (
      <Badge variant="outline" className="h-4 px-1 text-[9px]">
        snapshot
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="h-4 px-1 text-[9px]">
      ack
    </Badge>
  );
}
