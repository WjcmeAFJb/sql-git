import { path } from "./fs.ts";

export function snapshotPath(root: string): string {
  return path.join(root, "snapshot.db");
}

export function peerLogPath(root: string, peerId: string): string {
  return path.join(root, "peers", `${peerId}.jsonl`);
}

export function peersDir(root: string): string {
  return path.join(root, "peers");
}

/** Path for the debug-only squashed-log file. Lives in a sibling directory
 *  (`<root>/debug/`) rather than under `peers/` so listPeerIds() — which
 *  enumerates `<root>/peers/*.jsonl` — doesn't mistake it for a peer log
 *  and re-ingest every squashed action on the next sync. */
export function squashedLogPath(root: string, masterId: string): string {
  return path.join(root, "debug", `${masterId}.squashed.jsonl`);
}
