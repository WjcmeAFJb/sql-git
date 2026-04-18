/**
 * Node.js FS adapter. Self-registering on import — `import "sql-git/fs-node"`
 * in a Node entry point and every sql-git call that needs filesystem I/O
 * picks up the Node implementation.
 *
 * Browser builds must *not* import this file; use the OPFS adapter shipped
 * with the consumer app instead.
 */
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  appendFile as fsAppendFile,
  access as fsAccess,
  mkdir as fsMkdir,
  rename as fsRename,
  readdir as fsReaddir,
  rm as fsRm,
} from "node:fs/promises";
import { join as pathJoin, dirname as pathDirname } from "node:path";
import { setFs, setPath, type FsAdapter, type PathAdapter } from "./fs.ts";

export const nodeFsAdapter: FsAdapter = {
  readFile: async (p) => {
    const buf = await fsReadFile(p);
    // readFile returns a Node Buffer, which IS a Uint8Array subclass, but
    // callers asking for a portable Uint8Array are happier with a plain
    // view that doesn't carry Node's extra prototype methods.
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  },
  readTextFile: (p) => fsReadFile(p, "utf8"),
  writeFile: (p, d) => fsWriteFile(p, d),
  appendFile: (p, d) => fsAppendFile(p, d),
  exists: async (p) => {
    try {
      await fsAccess(p);
      return true;
    } catch {
      return false;
    }
  },
  mkdirp: async (p) => {
    await fsMkdir(p, { recursive: true });
  },
  rename: (s, d) => fsRename(s, d),
  readdir: (p) => fsReaddir(p),
  remove: (p) => fsRm(p, { recursive: true, force: true }),
};

export const nodePathAdapter: PathAdapter = {
  join: (...parts) => pathJoin(...parts),
  dirname: (p) => pathDirname(p),
};

setFs(nodeFsAdapter);
setPath(nodePathAdapter);
