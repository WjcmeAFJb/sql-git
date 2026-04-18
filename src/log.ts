import { fs, path } from "./fs.ts";

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdirp(p);
}

export async function ensureFile(p: string): Promise<void> {
  await ensureDir(path.dirname(p));
  if (!(await fs.exists(p))) await fs.writeFile(p, "");
}

export async function readLog<T>(p: string): Promise<T[]> {
  if (!(await fs.exists(p))) return [];
  const raw = await fs.readTextFile(p);
  if (!raw) return [];
  // Only parse lines terminated by a newline. Any trailing content past the
  // last newline is a partial write (crash, or an upstream file syncer like
  // Syncthing delivering a mid-append file) and is intentionally dropped —
  // the writer will produce a complete version on its next flush.
  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline < 0) return [];
  const complete = raw.slice(0, lastNewline);
  if (!complete) return [];
  const out: T[] = [];
  for (const line of complete.split("\n")) {
    if (!line) continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

export async function appendEntry<T>(p: string, entry: T): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.appendFile(p, JSON.stringify(entry) + "\n");
}

export async function rewriteLog<T>(p: string, entries: T[]): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = p + ".tmp";
  await fs.writeFile(
    tmp,
    entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""),
  );
  await fs.rename(tmp, p);
}
