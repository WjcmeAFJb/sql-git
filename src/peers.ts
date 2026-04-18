import { fs } from "./fs.ts";
import { peersDir } from "./paths.ts";

export async function listPeerIds(root: string): Promise<string[]> {
  const dir = peersDir(root);
  if (!(await fs.exists(dir))) return [];
  const entries = await fs.readdir(dir);
  return entries
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
}
