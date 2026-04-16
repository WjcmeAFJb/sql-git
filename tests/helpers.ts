import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Store } from "../src/index.ts";
import type { ActionRegistry, StoreOptions } from "../src/types.ts";

const roots: string[] = [];

export function makeRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "sqlgit-"));
  roots.push(r);
  return r;
}

afterEach(() => {
  while (roots.length) {
    const r = roots.pop()!;
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

export function openStore(
  root: string,
  peerId: string,
  masterId: string,
  actions: ActionRegistry,
): Store {
  const opts: StoreOptions = { root, peerId, masterId, actions };
  return Store.open(opts);
}

/** Schema init action (idempotent). */
export const INIT_SCHEMA = "_init_schema";

export function buildActions(extra: ActionRegistry = {}): ActionRegistry {
  return {
    [INIT_SCHEMA]: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
        INSERT OR IGNORE INTO counter (id, n) VALUES (1, 0);
      `);
    },
    set: (db, p) => {
      const { k, v } = p as { k: string; v: string };
      db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    },
    del: (db, p) => {
      const { k } = p as { k: string };
      const r = db.prepare("DELETE FROM kv WHERE k = ?").run(k);
      if (r.changes === 0) throw new Error(`del: key '${k}' not found`);
    },
    insertOnce: (db, p) => {
      const { k, v } = p as { k: string; v: string };
      const r = db.prepare("INSERT INTO kv (k, v) VALUES (?, ?)").run(k, v);
      if (r.changes !== 1) throw new Error(`insertOnce: duplicate key '${k}'`);
    },
    inc: (db, p) => {
      const by = (p as { by?: number }).by ?? 1;
      db.prepare("UPDATE counter SET n = n + ? WHERE id = 1").run(by);
    },
    setCounter: (db, p) => {
      const { n } = p as { n: number };
      db.prepare("UPDATE counter SET n = ? WHERE id = 1").run(n);
    },
    ...extra,
  };
}

export function readKV(store: Store): Record<string, string> {
  const rows = store.db.prepare("SELECT k, v FROM kv ORDER BY k").all() as {
    k: string;
    v: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

export function readCounter(store: Store): number {
  const row = store.db.prepare("SELECT n FROM counter WHERE id = 1").get() as { n: number } | undefined;
  return row?.n ?? 0;
}
