import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  closeSync,
  openSync,
} from "node:fs";
import { dirname } from "node:path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function ensureFile(path: string): void {
  ensureDir(dirname(path));
  if (!existsSync(path)) closeSync(openSync(path, "a"));
}

export function readLog<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (!raw) return [];
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

export function appendEntry<T>(path: string, entry: T): void {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

export function rewriteLog<T>(path: string, entries: T[]): void {
  ensureDir(dirname(path));
  const tmp = path + ".tmp";
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  renameSync(tmp, path);
}
