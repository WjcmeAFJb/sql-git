/// <reference lib="dom" />
/**
 * OPFS (Origin Private File System) adapter.
 *
 * Plain async adapter — no in-memory mirror. Every `FsAdapter` call walks
 * the OPFS directory tree via `getDirectoryHandle` / `getFileHandle`, so
 * changes made by other tabs (or by the browser's storage subsystem) are
 * observed on the next call.
 *
 * Cross-tab watch uses {@link BroadcastChannel}: every mutating call emits a
 * {@link FsEvent} on a channel scoped to the OPFS root name. Other tabs that
 * have called {@link OpfsFs.init} against the same root receive the event
 * and fan it out to their own subscribers. Local mutations also fire
 * locally, so callers register a single listener and receive both.
 *
 * OPFS itself has no filesystem-level change notification; if a third-party
 * writes to OPFS without going through this adapter, subscribers will not
 * be notified. For sql-git's model that's fine — the whole point of the
 * adapter is to funnel every write through one place.
 */
import {
  setFs,
  setPath,
  type FsAdapter,
  type FsEvent,
  type PathAdapter,
} from "./fs.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

function segments(p: string): string[] {
  return normalize(p).split("/").filter(Boolean);
}

export const opfsPathAdapter: PathAdapter = {
  join: (...parts) => normalize(parts.join("/")),
  dirname: (p) => {
    const segs = segments(p);
    segs.pop();
    return segs.length === 0 ? "/" : "/" + segs.join("/");
  },
};

type Watcher = {
  prefix: string;
  cb: (e: FsEvent, origin: "local" | "remote") => void;
};

export interface OpfsInitOptions {
  /** Optional subdirectory of OPFS to sandbox the adapter under. Created
   *  if missing. Defaults to using OPFS root directly. */
  rootName?: string;
  /** BroadcastChannel name for cross-tab events. Defaults to
   *  `"sql-git:opfs:<rootName ?? '/'>"`. Tabs that want independent watch
   *  streams under the same OPFS root can override this. */
  channelName?: string;
}

export interface OpfsFs {
  readonly fs: FsAdapter;
  readonly path: PathAdapter;
  /** Async-initialize. Resolves the root directory handle and opens the
   *  cross-tab BroadcastChannel. Safe to call again to re-point at a
   *  different subdirectory. */
  init(opts?: OpfsInitOptions): Promise<void>;
  /** Replace the global sql-git FS + path adapters with this one. */
  install(): void;
  /** Close the BroadcastChannel. No further cross-tab events are sent
   *  or received. Local watchers remain attached. */
  close(): void;
}

// Writable-stream handle — not consistently typed across lib.dom versions
// we might encounter, so narrow it here rather than fight the global defs.
interface WritableHandle {
  createWritable(): Promise<{
    write(data: BufferSource | Blob | string): Promise<void>;
    close(): Promise<void>;
  }>;
}

interface DirectoryEntries {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

export function createOpfsFs(): OpfsFs {
  const watchers: Watcher[] = [];
  let rootHandle: FileSystemDirectoryHandle | null = null;
  let channel: BroadcastChannel | null = null;

  const requireRoot = (): FileSystemDirectoryHandle => {
    if (!rootHandle) throw new Error("OPFS adapter not initialized — call init() first");
    return rootHandle;
  };

  const walkToDir = async (
    path: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> => {
    let dir = requireRoot();
    for (const seg of segments(path)) {
      try {
        dir = await dir.getDirectoryHandle(seg, { create });
      } catch {
        return null;
      }
    }
    return dir;
  };

  const fanout = (e: FsEvent, origin: "local" | "remote"): void => {
    const target = "from" in e ? e.to : e.path;
    for (const w of watchers) {
      const match =
        w.prefix === "/" ||
        target === w.prefix ||
        target.startsWith(w.prefix + "/") ||
        ("from" in e && (e.from === w.prefix || e.from.startsWith(w.prefix + "/")));
      if (!match) continue;
      try {
        w.cb(e, origin);
      } catch {
        // a buggy watcher must not break the mutation that triggered it
      }
    }
  };

  const emit = (e: FsEvent): void => {
    fanout(e, "local");
    channel?.postMessage(e);
  };

  const splitLeaf = (p: string): { dir: string; name: string } => {
    const segs = segments(p);
    const name = segs.pop();
    if (!name) throw new Error(`EINVAL: ${p}`);
    return { dir: "/" + segs.join("/"), name };
  };

  const fsAdapter: FsAdapter = {
    async readFile(p) {
      const { dir, name } = splitLeaf(p);
      const d = await walkToDir(dir, false);
      if (!d) throw new Error(`ENOENT: ${p}`);
      let fh: FileSystemFileHandle;
      try {
        fh = await d.getFileHandle(name);
      } catch {
        throw new Error(`ENOENT: ${p}`);
      }
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async readTextFile(p) {
      return decoder.decode(await fsAdapter.readFile(p));
    },
    async writeFile(p, d) {
      const np = normalize(p);
      const { dir, name } = splitLeaf(np);
      const parent = await walkToDir(dir, true);
      if (!parent) throw new Error(`EINVAL: ${np}`);
      const fh = await parent.getFileHandle(name, { create: true });
      const writable = await (fh as unknown as WritableHandle).createWritable();
      // Hand Uint8Array over as a standalone ArrayBuffer — `createWritable`'s
      // input types only accept `ArrayBuffer` (not `ArrayBufferLike`), and
      // `.slice()` gives us an isolated copy that won't mutate under us.
      const payload: BufferSource | string =
        typeof d === "string" ? d : d.slice().buffer;
      await writable.write(payload);
      await writable.close();
      emit({ type: "write", path: np });
    },
    async appendFile(p, d) {
      const np = normalize(p);
      let existing: Uint8Array;
      try {
        existing = await fsAdapter.readFile(np);
      } catch {
        existing = new Uint8Array(0);
      }
      const add = encoder.encode(d);
      const combined = new Uint8Array(existing.length + add.length);
      combined.set(existing, 0);
      combined.set(add, existing.length);
      await fsAdapter.writeFile(np, combined);
    },
    async exists(p) {
      const np = normalize(p);
      if (np === "/") return true;
      const { dir, name } = splitLeaf(np);
      const parent = await walkToDir(dir, false);
      if (!parent) return false;
      try {
        await parent.getFileHandle(name);
        return true;
      } catch {
        // fall through to directory check
      }
      try {
        await parent.getDirectoryHandle(name);
        return true;
      } catch {
        return false;
      }
    },
    async mkdirp(p) {
      const np = normalize(p);
      const existed = await fsAdapter.exists(np);
      const made = await walkToDir(np, true);
      if (!made) throw new Error(`EINVAL: ${np}`);
      if (!existed) emit({ type: "mkdir", path: np });
    },
    async rename(src, dst) {
      const nsrc = normalize(src);
      const ndst = normalize(dst);
      const srcLeaf = splitLeaf(nsrc);
      const srcParent = await walkToDir(srcLeaf.dir, false);
      if (!srcParent) throw new Error(`ENOENT: ${nsrc}`);

      // OPFS has `move()`, but browser support is uneven — file-on-file
      // rename is widely available, rename of a directory less so. Do a
      // copy+delete so the same code path works everywhere.
      let isFile = true;
      let fileHandle: FileSystemFileHandle | null = null;
      try {
        fileHandle = await srcParent.getFileHandle(srcLeaf.name);
      } catch {
        isFile = false;
      }
      if (isFile && fileHandle) {
        const file = await fileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const dstLeaf = splitLeaf(ndst);
        const dstParent = await walkToDir(dstLeaf.dir, true);
        if (!dstParent) throw new Error(`EINVAL: ${ndst}`);
        const out = await dstParent.getFileHandle(dstLeaf.name, { create: true });
        const writable = await (out as unknown as WritableHandle).createWritable();
        await writable.write(bytes.slice().buffer);
        await writable.close();
        await srcParent.removeEntry(srcLeaf.name);
        emit({ type: "rename", from: nsrc, to: ndst });
        return;
      }

      // Directory rename: recursive copy, then recursive remove.
      let srcDir: FileSystemDirectoryHandle;
      try {
        srcDir = await srcParent.getDirectoryHandle(srcLeaf.name);
      } catch {
        throw new Error(`ENOENT: ${nsrc}`);
      }
      const copyTree = async (
        from: FileSystemDirectoryHandle,
        toPath: string,
      ): Promise<void> => {
        const to = await walkToDir(toPath, true);
        if (!to) throw new Error(`EINVAL: ${toPath}`);
        for await (const [name, handle] of (from as unknown as DirectoryEntries).entries()) {
          if (handle.kind === "file") {
            const file = await (handle as FileSystemFileHandle).getFile();
            const bytes = new Uint8Array(await file.arrayBuffer());
            const out = await to.getFileHandle(name, { create: true });
            const writable = await (out as unknown as WritableHandle).createWritable();
            await writable.write(bytes.slice().buffer);
            await writable.close();
          } else {
            await copyTree(handle as FileSystemDirectoryHandle, toPath + "/" + name);
          }
        }
      };
      await copyTree(srcDir, ndst);
      await srcParent.removeEntry(srcLeaf.name, { recursive: true });
      emit({ type: "rename", from: nsrc, to: ndst });
    },
    async readdir(p) {
      const dir = await walkToDir(normalize(p), false);
      if (!dir) throw new Error(`ENOENT: ${p}`);
      const names: string[] = [];
      for await (const [name] of (dir as unknown as DirectoryEntries).entries()) {
        names.push(name);
      }
      return names;
    },
    async remove(p) {
      const np = normalize(p);
      if (np === "/") throw new Error("refusing to remove OPFS root");
      const { dir, name } = splitLeaf(np);
      const parent = await walkToDir(dir, false);
      if (!parent) return;
      try {
        await parent.removeEntry(name, { recursive: true });
        emit({ type: "delete", path: np });
      } catch {
        // already gone — idempotent
      }
    },
    watch(p, cb) {
      const w: Watcher = { prefix: normalize(p), cb };
      watchers.push(w);
      return () => {
        const i = watchers.indexOf(w);
        if (i >= 0) watchers.splice(i, 1);
      };
    },
  };

  return {
    fs: fsAdapter,
    path: opfsPathAdapter,
    async init(opts) {
      if (typeof navigator === "undefined" || !navigator.storage?.getDirectory)
        throw new Error("OPFS not available in this environment");
      const root = await navigator.storage.getDirectory();
      rootHandle = opts?.rootName
        ? await root.getDirectoryHandle(opts.rootName, { create: true })
        : root;
      // (Re-)open the BC on init so rename within the same origin is fine.
      channel?.close();
      const channelName = opts?.channelName ?? `sql-git:opfs:${opts?.rootName ?? "/"}`;
      if (typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel(channelName);
        channel.onmessage = (ev: MessageEvent<FsEvent>) =>
          fanout(ev.data, "remote");
      }
    },
    install() {
      setFs(fsAdapter);
      setPath(opfsPathAdapter);
    },
    close() {
      channel?.close();
      channel = null;
    },
  };
}
