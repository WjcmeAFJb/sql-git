import { readdirSync, existsSync } from "node:fs";
import { peersDir } from "./paths.ts";

export function listPeerIds(root: string): string[] {
  const dir = peersDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
}
