import { Orm } from "sql-reactive-orm";
import type { Driver, RunResult } from "sql-reactive-orm";
import type { Database as RawDb, SqlValue } from "sqlite3-read-tracking";
import type { Db } from "../../../src/db";
import type { BankDB } from "./orm-entities";

/**
 * Adapter between sql-git's live `Db` (wrapping a sqlite3-read-tracking
 * `Database`) and sql-reactive-orm's `Driver` interface.
 *
 * We look the db up via `getDb()` on every call instead of capturing a
 * reference, because sql-git's peer sync replaces `Store.db` when the local
 * state is rebuilt against a new master head. During a conflict the UI
 * reads from `conflict.ctx.rebasedDb` instead of `store.db` — pointing the
 * driver at a getter lets the same ORM instance serve both.
 */
export function createGitDriver(getDb: () => Db | null): Driver {
  const rawOrThrow = (): RawDb => {
    const db = getDb();
    if (!db) throw new Error("sql-reactive-orm driver: no db available");
    return db.raw;
  };

  return {
    exec: async (sql) => {
      rawOrThrow().exec(sql);
    },
    run: async (sql, params = []): Promise<RunResult> => {
      const raw = rawOrThrow();
      // `exec` is what sql-git itself uses under the hood; it takes the
      // params in one shot and internally prepares+steps+finalises. Using
      // the lower-level `prepare` + `stmt.step()` here reliably hangs on
      // read-tracking sql.js builds when another statement is live on the
      // same connection (as the sql-git Store.submit path can have).
      if (params.length > 0) raw.exec(sql, params as SqlValue[]);
      else raw.exec(sql);
      const changesRes = raw.exec("SELECT changes()");
      const changes = Number(changesRes[0]?.values[0]?.[0] ?? 0);
      const lastRes = raw.exec("SELECT last_insert_rowid()");
      const lastId = lastRes[0]?.values[0]?.[0];
      return {
        changes,
        lastInsertRowid:
          typeof lastId === "number" || typeof lastId === "bigint" ? lastId : 0,
      };
    },
    all: async <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
      const raw = rawOrThrow();
      const res = params.length > 0 ? raw.exec(sql, params as SqlValue[]) : raw.exec(sql);
      if (res.length === 0) return [];
      const { columns, values } = res[0];
      const rows: T[] = [];
      for (const row of values) {
        const obj: Record<string, SqlValue> = {};
        for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
        rows.push(obj as unknown as T);
      }
      return rows;
    },
  };
}

/** Tables the ORM watches. Used for blanket invalidation after `store.submit`
 *  calls (which bypass `orm.driver.run`, so the reactive wrapper doesn't
 *  detect them automatically). */
export const BANK_TABLES = ["accounts", "categories", "transactions"] as const;

/** Create an ORM instance against the current Store.db. We skip entity
 *  registration — the demo's Reads go through `orm.sqlQuery` with
 *  Kysely-typed builders, which only needs the `BankDB` generic to
 *  flow types through. */
export function createBankOrm(getDb: () => Db | null): Orm<BankDB> {
  const driver = createGitDriver(getDb);
  return new Orm<BankDB>(driver);
}

/**
 * Signal that every bank table may have changed. sql-git mutations go
 * through `Store.submit` → the underlying Db — the ORM's reactive driver
 * wrapper never sees them, so we nudge the mutation bus manually. This
 * deliberately doesn't call `clearQueryCache` / `clearCaches`: the first
 * disposes every cached SqlQuery (unsubscribing it from the very bus
 * we're about to ring), the second only matters for entity identity maps
 * which we don't use. A plain `invalidate` per table triggers the
 * subscribed queries to re-execute in place.
 */
export function invalidateBank(orm: Orm<BankDB>): void {
  for (const t of BANK_TABLES) orm.invalidate(t);
}

export type BankOrm = Orm<BankDB>;
