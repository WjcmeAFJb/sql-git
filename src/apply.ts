import type { Db } from "./db.ts";
import type {
  ActionRegistry,
  ActionTrace,
  MasterActionEntry,
  PeerActionEntry,
} from "./types.ts";

export function applyAction(
  db: Db,
  actions: ActionRegistry,
  name: string,
  params: unknown,
): void {
  const fn = actions[name];
  if (!fn) throw new Error(`Unknown action: ${name}`);
  fn(db, params);
}

export function applyEntry(
  db: Db,
  actions: ActionRegistry,
  entry: MasterActionEntry | PeerActionEntry,
): void {
  applyAction(db, actions, entry.name, entry.params);
}

/**
 * Apply `name(params)` against `db` with VDBE-level read/write tracking
 * turned on for the duration of the call. Throws if the action throws (the
 * captured logs are still returned via `traceOnError` when available).
 */
export function applyActionTracked(
  db: Db,
  actions: ActionRegistry,
  name: string,
  params: unknown,
): ActionTrace {
  const fn = actions[name];
  if (!fn) throw new Error(`Unknown action: ${name}`);
  db.beginTracking();
  try {
    fn(db, params);
    const trace = snapshotTrace(db);
    return trace;
  } finally {
    db.endTracking();
  }
}

/** Run `fn` with tracking enabled; return trace regardless of outcome. */
export function traceRun<T>(db: Db, fn: () => T): { value: T; trace: ActionTrace } {
  db.beginTracking();
  try {
    const value = fn();
    const trace = snapshotTrace(db);
    return { value, trace };
  } finally {
    db.endTracking();
  }
}

function snapshotTrace(db: Db): ActionTrace {
  return {
    reads: db.getReadLog(),
    writes: db.getWriteLog(),
    predicates: db.getPredicateLog(),
    idxWrites: db.getIndexWriteLog(),
  };
}

export function tryApply(
  db: Db,
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
