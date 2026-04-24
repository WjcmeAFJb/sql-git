import { useMemo } from "react";
import type { BankOrm } from "@/lib/orm";
import type { BankDB } from "@/lib/orm-entities";
import type { Compilable } from "kysely";
import type { Kysely } from "kysely";

/**
 * React 18-friendly wrapper around `orm.sqlQuery`.
 *
 * The ORM exposes `Query` / `SqlQuery` objects whose `.status`, `.value`,
 * and `.reason` are MobX observables. Consumers must wrap with
 * `observer()` from `mobx-react-lite` so those reads are tracked — we
 * intentionally don't wrap here, leaving the choice of boundary to the
 * caller.
 *
 * The builder callback is memoized on its `deps`, so the returned
 * `SqlQuery` instance is stable across renders and the ORM de-duplicates
 * repeated calls with the same SQL string.
 */
export function useBankQuery<Output>(
  orm: BankOrm | null,
  build: (db: Kysely<BankDB>) => Compilable<Output>,
  deps: unknown[],
): { status: "idle" | "pending" | "fulfilled" | "rejected"; rows: Output[]; error?: unknown } {
  const query = useMemo(
    () => {
      if (!orm) return null;
      const q = orm.sqlQuery<Output>(build);
      // SqlQuery re-throws out of its internal `_execute` on error; if no
      // consumer awaits it, the rejection bubbles up as an unhandled
      // promise. We observe status synchronously via MobX below, so swallow
      // here (callers render `.rows = []` and `.status = "rejected"`).
      q.catch(() => {});
      return q;
    },
    // `build` intentionally omitted — caller controls stability via `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orm, ...deps],
  );

  if (!query) return { status: "idle", rows: [] };
  const status = query.status as "pending" | "fulfilled" | "rejected";
  if (status === "fulfilled") {
    const value = query.value as unknown as Output[] | undefined;
    return { status, rows: value ?? [] };
  }
  if (status === "rejected") return { status, rows: [], error: query.reason };
  // MobX observable array starts empty; components render the pending
  // state until the first fulfillment. Subsequent mutations patch the
  // existing array in place so no Suspense-like flash.
  const value = query.value as unknown as Output[] | undefined;
  return { status, rows: value ?? [] };
}
