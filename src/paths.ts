import { join } from "node:path";

export function snapshotPath(root: string): string {
  return join(root, "snapshot.db");
}

export function peerLogPath(root: string, peerId: string): string {
  return join(root, "peers", `${peerId}.jsonl`);
}

export function peersDir(root: string): string {
  return join(root, "peers");
}
