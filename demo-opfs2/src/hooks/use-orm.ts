import { useEffect, useRef, useState } from "react";
import type { Store } from "../../../src/index";
import type { Db } from "../../../src/db";
import type { PendingConflict } from "@/hooks/use-store";
import { createBankOrm, invalidateBank, type BankOrm } from "@/lib/orm";

/**
 * Create one ORM per Store. The driver captures a getter, so the same ORM
 * instance transparently serves both `store.db` (normal reads) and
 * `conflict.ctx.rebasedDb` (during conflict resolution) without any
 * re-creation dance.
 *
 * `tick` is bumped by the store hook on every submit/sync — on each bump we
 * clear the ORM caches so queries refetch. sql-git actions go directly
 * through `Store.submit` (bypassing `orm.driver.run`), so the reactive
 * wrapper can't auto-detect writes; manual invalidation is our fallback.
 */
export function useOrm(
  store: Store | null,
  conflict: PendingConflict | null,
  tick: number,
  head: number,
): BankOrm | null {
  const dbRef = useRef<Db | null>(null);
  dbRef.current = conflict ? conflict.ctx.rebasedDb : (store?.db ?? null);

  const [orm, setOrm] = useState<BankOrm | null>(null);

  useEffect(() => {
    if (!store) {
      setOrm(null);
      return;
    }
    const o = createBankOrm(() => dbRef.current);
    setOrm(o);
    return () => {
      void o.close();
    };
  }, [store]);

  useEffect(() => {
    if (orm) invalidateBank(orm);
  }, [orm, tick, head]);

  return orm;
}
