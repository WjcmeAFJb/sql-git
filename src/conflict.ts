import { cloneDb, compareDbs, type Db } from "./db.ts";
import { applyAction } from "./apply.ts";
import type {
  ActionRegistry,
  ActionTrace,
  MasterActionEntry,
  PeerActionEntry,
} from "./types.ts";
import type {
  IndexWriteLogEntry,
  PredicateLogEntry,
  ReadLogEntry,
  SqlValue,
  WriteLogEntry,
} from "sqlite3-read-tracking";

export type ConflictResult =
  | { ok: true; reason: "disjoint" | "permutation-equal" }
  | { ok: false; kind: "error"; error: Error }
  | { ok: false; kind: "non_commutative" };

/*
 * Two-tier conflict detector:
 *
 *   Tier 1 (read/write-set cluster): run the peer action and every master
 *     suffix action under tracking, compute rw/ww/phantom edges between the
 *     peer action's trace and each suffix trace (using the same rules as
 *     examples/cluster-demo.mjs from sqlite3-read-tracking). If no edges
 *     exist, the two branches are causally disjoint and commute for free —
 *     we only need to confirm the peer action applies cleanly on the
 *     current rebased db.
 *
 *   Tier 2 (permutation): if Tier 1 sees overlap, fall back to the classic
 *     check — run `base + action + suffix` and `base + suffix + action`
 *     and compare final states. If both succeed and match, the action is
 *     convergent. Otherwise we hand it to the resolver.
 *
 * Soundness note: Tier 1 is a sound *over*-approximation of interaction
 * (single-branch clusters can never conflict). Tier 2 is the classical
 * commutativity test. Neither catches "occasional convergence" via deletion
 * (two branches independently UPDATE then DELETE the same row): that ends
 * with both orderings reaching "row gone", but Tier 2's midstream UPDATE on
 * the already-deleted row errors in one ordering. Recognizing that case
 * requires per-row net-effect semantics beyond opaque actions + R/W sets
 * (see README for the sketch).
 */

type TraceResult =
  | { ok: true; trace: ActionTrace }
  | { ok: false; trace: ActionTrace; error: Error };

/** Run `name(params)` on a clone of `db` with tracking on; don't mutate `db`. */
function traceOnClone(
  db: Db,
  actions: ActionRegistry,
  name: string,
  params: unknown,
): TraceResult {
  const scratch = cloneDb(db);
  scratch.beginTracking();
  try {
    applyAction(scratch, actions, name, params);
    const trace: ActionTrace = {
      reads: scratch.getReadLog(),
      writes: scratch.getWriteLog(),
      predicates: scratch.getPredicateLog(),
      idxWrites: scratch.getIndexWriteLog(),
    };
    scratch.endTracking();
    scratch.close();
    return { ok: true, trace };
  } catch (err) {
    const trace: ActionTrace = {
      reads: scratch.getReadLog(),
      writes: scratch.getWriteLog(),
      predicates: scratch.getPredicateLog(),
      idxWrites: scratch.getIndexWriteLog(),
    };
    scratch.endTracking();
    scratch.close();
    return {
      ok: false,
      trace,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Drop preservation reads. SQLite's UPDATE opcodes emit OP_Column events for
 * every column of the target row (even ones not in the SET list), because
 * the rewrite stages need them to rebuild the row image. Those reads are
 * semantically irrelevant — the SQL only depends on columns mentioned in
 * the WHERE clause or the SET expression. We keep:
 *   - reads on rows / tables not being updated here,
 *   - the "rowid" probe that drove the WHERE,
 *   - reads of columns that appear in the UPDATE's write mask (the SET
 *     expression read them).
 */
function logicalReads(trace: ActionTrace): ReadLogEntry[] {
  if (!trace.writes.some((w) => w.op === "update" && w.columns)) return trace.reads;
  const maskByRow = new Map<string, Set<string>>();
  for (const w of trace.writes) {
    if (w.op === "update" && w.columns) {
      maskByRow.set(`${w.table}:${w.rowid}`, new Set(w.columns));
    }
  }
  return trace.reads.filter((r) => {
    const mask = maskByRow.get(`${r.table}:${r.rowid}`);
    if (!mask) return true; // not an UPDATE target
    if (r.column === "rowid") return true; // WHERE probe
    return mask.has(r.column); // in SET → used by SET expression
  });
}

function keyInRange(writeKey: SqlValue[], range: ReconstructedRange): boolean {
  const v = writeKey[0] as string | number | null;
  if (range.low !== null && range.low.length > 0) {
    const lo = range.low[0] as string | number | null;
    if (compareKey(v, lo) < 0) return false;
    if (compareKey(v, lo) === 0 && range.lowIncl === false) return false;
  }
  if (range.high !== null && range.high.length > 0) {
    const hi = range.high[0] as string | number | null;
    if (compareKey(v, hi) > 0) return false;
    if (compareKey(v, hi) === 0 && range.highIncl === false) return false;
  }
  return true;
}

function compareKey(a: unknown, b: unknown): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

type ReconstructedRange = {
  table: string;
  index: string | null;
  low: SqlValue[] | null;
  lowIncl: boolean;
  high: SqlValue[] | null;
  highIncl: boolean;
};

function reconstructRanges(preds: PredicateLogEntry[]): ReconstructedRange[] {
  const out: ReconstructedRange[] = [];
  let pending:
    | {
        table: string;
        index: string | null;
        low: SqlValue[] | null;
        lowIncl: boolean;
      }
    | null = null;
  for (const p of preds) {
    if (p.kind === "s") {
      if (pending) {
        out.push({ ...pending, high: null, highIncl: false });
      }
      pending = {
        table: p.table,
        index: p.index,
        low: p.key,
        lowIncl: p.op === "G" || p.op === "L",
      };
    } else if (
      p.kind === "e" &&
      pending &&
      pending.table === p.table &&
      pending.index === p.index
    ) {
      out.push({
        ...pending,
        high: p.key,
        highIncl: p.op === "L" || p.op === "g",
      });
      pending = null;
    } else if (p.kind === "r") {
      out.push({
        table: p.table,
        index: p.index,
        low: null,
        high: null,
        lowIncl: true,
        highIncl: true,
      });
    }
  }
  if (pending) out.push({ ...pending, high: null, highIncl: false });
  return out;
}

/**
 * True iff `a` and `b` have at least one point-rw / ww / phantom conflict
 * edge per the cluster-demo rules. Two pure readers never conflict.
 */
export function tracesConflict(a: ActionTrace, b: ActionTrace): boolean {
  const aReads = logicalReads(a);
  const bReads = logicalReads(b);

  const pointRW = (readerLog: ReadLogEntry[], writer: ActionTrace): boolean => {
    for (const w of writer.writes) {
      if (w.op === "truncate") {
        if (readerLog.some((r) => r.table === w.table)) return true;
        continue;
      }
      for (const r of readerLog) {
        if (r.table !== w.table || r.rowid !== w.rowid) continue;
        if (w.op === "update" && w.columns) {
          const writeCols = new Set(w.columns);
          if (r.column === "rowid") {
            if (writeCols.has("rowid")) return true;
          } else if (writeCols.has(r.column)) {
            return true;
          }
        } else {
          return true;
        }
      }
    }
    return false;
  };
  if (pointRW(aReads, b)) return true;
  if (pointRW(bReads, a)) return true;

  for (const wa of a.writes) {
    for (const wb of b.writes) {
      if (wa.table !== wb.table) continue;
      const rowOverlap =
        wa.op === "truncate" || wb.op === "truncate" || wa.rowid === wb.rowid;
      if (!rowOverlap) continue;
      if (wa.op === "update" && wb.op === "update" && wa.columns && wb.columns) {
        const sa = new Set(wa.columns);
        if (wb.columns.some((c) => sa.has(c))) return true;
      } else {
        return true;
      }
    }
  }

  const phantom = (scanner: ActionTrace, inserter: ActionTrace): boolean => {
    const ranges = reconstructRanges(scanner.predicates);
    for (const r of ranges) {
      for (const iw of inserter.idxWrites as IndexWriteLogEntry[]) {
        if (iw.table !== r.table) continue;
        if ((iw.index ?? null) !== (r.index ?? null)) continue;
        if (keyInRange(iw.key, r)) return true;
      }
    }
    return false;
  };
  if (phantom(a, b)) return true;
  if (phantom(b, a)) return true;

  return false;
}

/**
 * Check if applying `action` on top of `currentDb` preserves peer's intent
 * (commutes with `masterSuffix`, where suffix = master actions applied since `baseDb`).
 *
 * The answer depends on both tracking-based cluster analysis and the
 * classical permutation test — see the module header comment for details.
 */
export function checkConflict(args: {
  currentDb: Db;
  baseDb: Db;
  masterSuffix: MasterActionEntry[];
  actions: ActionRegistry;
  action: PeerActionEntry;
}): ConflictResult {
  const { currentDb, baseDb, masterSuffix, actions, action } = args;

  // Tier 1: R/W set cluster check. Trace each action on a clone of baseDb.
  // If the peer action's trace has no conflict edge with any suffix trace,
  // we still need to verify the action applies cleanly on the current
  // (rebased) state — a tracing-clean action can still trip an error when
  // run on a different base (e.g., an unrelated check constraint).
  const peerTrace = traceOnClone(baseDb, actions, action.name, action.params);
  if (peerTrace.ok && masterSuffix.length > 0) {
    const suffixTraces = masterSuffix.map((e) =>
      traceOnClone(baseDb, actions, e.name, e.params),
    );
    const allSuffixClean = suffixTraces.every((t) => t.ok);
    if (allSuffixClean) {
      const overlap = suffixTraces.some((t) => tracesConflict(peerTrace.trace, t.trace));
      if (!overlap) {
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
        onCurrent.close();
        return { ok: true, reason: "disjoint" };
      }
    }
  }

  // Tier 2: permutation check.
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
    return { ok: true, reason: "permutation-equal" };
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
  return equal ? { ok: true, reason: "permutation-equal" } : { ok: false, kind: "non_commutative" };
}
