/**
 * Pluggable asynchronous FS / path adapter layer.
 *
 * sql-git's on-disk model is: each peer writes small files under `<root>/`,
 * relying on atomic (tmp-then-rename) semantics so peers on other hosts
 * never see partial writes. This module decouples *which* filesystem is
 * storing those files — Node `node:fs/promises`, the browser OPFS adapter,
 * an in-memory fake for unit tests, etc.
 *
 * A consumer installs an adapter once at boot via {@link setFs} /
 * {@link setPath}, after which every Store and its helpers go through the
 * singleton. Node callers can `import "sql-git/fs-node"` to get the Node
 * adapter self-registered; browser callers install their own.
 *
 * Invariants the adapter must provide:
 * - All I/O methods return Promises; `writeFile` / `rename` must be atomic
 *   per file so readers on other hosts never observe partial content.
 * - `mkdirp` creates intermediate dirs as needed; idempotent.
 * - `readdir` returns immediate children only (no recursion).
 * - `exists` never rejects; `readFile` / `readTextFile` reject for
 *   non-existent paths (matches node:fs semantics).
 * - `watch` is optional. When present it subscribes to mutations at or
 *   under `path` and returns an unsubscribe function.
 */

/** A filesystem mutation event, surfaced by adapters that implement watch. */
export type FsEvent =
  | { type: "write"; path: string }
  | { type: "mkdir"; path: string }
  | { type: "rename"; from: string; to: string }
  | { type: "delete"; path: string };

/** Asynchronous filesystem primitives. Paths are opaque strings; the adapter
 *  decides its own path semantics via the matching {@link PathAdapter}. */
export interface FsAdapter {
  /** Binary read. Rejects if the path doesn't exist. */
  readFile(path: string): Promise<Uint8Array>;
  /** UTF-8 text read. Rejects if the path doesn't exist. */
  readTextFile(path: string): Promise<string>;
  /** Atomic write. Creates the file if missing. */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Append to file. Creates the file if missing. */
  appendFile(path: string, data: string): Promise<void>;
  /** True iff the path exists (file or directory). Must not reject. */
  exists(path: string): Promise<boolean>;
  /** Recursive `mkdir -p`. Idempotent; resolves if the dir already exists. */
  mkdirp(path: string): Promise<void>;
  /** Atomic rename. Overwrites the destination if present. */
  rename(src: string, dst: string): Promise<void>;
  /** Lists immediate children of a directory. Rejects if not a directory. */
  readdir(path: string): Promise<string[]>;
  /** Optional: remove a file or directory (recursively). sql-git's own code
   *  never deletes; consumers that need delete semantics (the OPFS demo,
   *  test teardown, manual tooling) can call through. */
  remove?(path: string): Promise<void>;
  /** Optional: subscribe to mutations at or under `path`. Returns an
   *  unsubscribe function. The callback's `origin` argument distinguishes
   *  mutations made through this adapter instance (`"local"`) from ones
   *  surfaced via cross-process or cross-tab signalling (`"remote"`).
   *  Adapters that can't observe their own mutations should omit this
   *  field; callers should treat absence as "unsupported". */
  watch?(
    path: string,
    cb: (e: FsEvent, origin: "local" | "remote") => void,
  ): () => void;
}

/** Minimal path manipulation. An adapter that uses a unique separator can
 *  stay internally consistent as long as `join` and `dirname` agree. */
export interface PathAdapter {
  join(...parts: string[]): string;
  dirname(path: string): string;
}

const notConfigured = (name: string): never => {
  throw new Error(
    `sql-git ${name} adapter not configured. Import "sql-git/fs-node" in Node ` +
      `or install a browser adapter via setFs()/setPath() before opening a Store.`,
  );
};

const reject = (name: string) => async (): Promise<never> => notConfigured(name);

let _fs: FsAdapter = {
  readFile: reject("fs"),
  readTextFile: reject("fs"),
  writeFile: reject("fs"),
  appendFile: reject("fs"),
  exists: reject("fs"),
  mkdirp: reject("fs"),
  rename: reject("fs"),
  readdir: reject("fs"),
};

let _path: PathAdapter = {
  join: () => notConfigured("path"),
  dirname: () => notConfigured("path"),
};

/** Replace the global FS adapter. Subsequent sql-git ops route through it. */
export function setFs(fs: FsAdapter): void {
  _fs = fs;
}

/** Replace the global path adapter. */
export function setPath(path: PathAdapter): void {
  _path = path;
}

/** Returns the currently-installed FS adapter (for advanced callers that
 *  want to layer or introspect). */
export function getFs(): FsAdapter {
  return _fs;
}

/** Returns the currently-installed path adapter. */
export function getPath(): PathAdapter {
  return _path;
}

/**
 * Stable facade that always routes to the *current* `_fs`. All sql-git
 * internals call through this, so consumers can swap adapters mid-process
 * (e.g., tests that reset between cases).
 */
export const fs = {
  readFile: (p: string): Promise<Uint8Array> => _fs.readFile(p),
  readTextFile: (p: string): Promise<string> => _fs.readTextFile(p),
  writeFile: (p: string, d: Uint8Array | string): Promise<void> => _fs.writeFile(p, d),
  appendFile: (p: string, d: string): Promise<void> => _fs.appendFile(p, d),
  exists: (p: string): Promise<boolean> => _fs.exists(p),
  mkdirp: (p: string): Promise<void> => _fs.mkdirp(p),
  rename: (s: string, d: string): Promise<void> => _fs.rename(s, d),
  readdir: (p: string): Promise<string[]> => _fs.readdir(p),
  remove: (p: string): Promise<void> => {
    if (!_fs.remove) throw new Error("Installed FS adapter does not support remove()");
    return _fs.remove(p);
  },
  watch: (
    p: string,
    cb: (e: FsEvent, origin: "local" | "remote") => void,
  ): (() => void) => {
    if (!_fs.watch) throw new Error("Installed FS adapter does not support watch()");
    return _fs.watch(p, cb);
  },
};

export const path = {
  join: (...parts: string[]): string => _path.join(...parts),
  dirname: (p: string): string => _path.dirname(p),
};
