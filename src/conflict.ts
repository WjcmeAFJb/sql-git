import type { Database as Db } from "better-sqlite3";
import { cloneDb, compareDbs } from "./db.ts";
import { applyAction } from "./apply.ts";
import type { ActionRegistry, MasterActionEntry, PeerActionEntry } from "./types.ts";

export type ConflictResult =
  | { ok: true }
  | { ok: false; kind: "error"; error: Error }
  | { ok: false; kind: "non_commutative" };

/**
 * Check if applying `action` on top of `currentDb` preserves peer's intent
 * (commutes with `masterSuffix`, where suffix = master actions applied since `baseDb`).
 *
 *   intent = baseDb + action + suffix
 *   actual = baseDb + suffix + action = currentDb + action
 *
 * Non-conflicting iff apply-on-current doesn't throw AND the two states match.
 * If suffix is empty, commutativity is trivial — only the error check runs.
 */
export function checkConflict(args: {
  currentDb: Db;
  baseDb: Db;
  masterSuffix: MasterActionEntry[];
  actions: ActionRegistry;
  action: PeerActionEntry;
}): ConflictResult {
  const { currentDb, baseDb, masterSuffix, actions, action } = args;

  const onCurrent = cloneDb(currentDb);
  try {
    applyAction(onCurrent, actions, action.name, action.params);
  } catch (err) {
    onCurrent.close();
    return {
      ok: false,
      kind: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  if (masterSuffix.length === 0) {
    onCurrent.close();
    return { ok: true };
  }

  const onBase = cloneDb(baseDb);
  try {
    applyAction(onBase, actions, action.name, action.params);
    for (const e of masterSuffix) {
      applyAction(onBase, actions, e.name, e.params);
    }
  } catch {
    onBase.close();
    onCurrent.close();
    return { ok: false, kind: "non_commutative" };
  }

  const equal = compareDbs(onCurrent, onBase);
  onBase.close();
  onCurrent.close();
  return equal ? { ok: true } : { ok: false, kind: "non_commutative" };
}
