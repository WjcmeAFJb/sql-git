import type { Database } from "better-sqlite3";
import type { ActionRegistry, MasterActionEntry, PeerActionEntry } from "./types.ts";

export function applyAction(
  db: Database,
  actions: ActionRegistry,
  name: string,
  params: unknown,
): void {
  const fn = actions[name];
  if (!fn) throw new Error(`Unknown action: ${name}`);
  fn(db, params);
}

export function applyEntry(
  db: Database,
  actions: ActionRegistry,
  entry: MasterActionEntry | PeerActionEntry,
): void {
  applyAction(db, actions, entry.name, entry.params);
}

export function tryApply(
  db: Database,
  actions: ActionRegistry,
  name: string,
  params: unknown,
): { ok: true } | { ok: false; error: Error } {
  try {
    applyAction(db, actions, name, params);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
