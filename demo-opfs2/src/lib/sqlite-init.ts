import { setSqliteInitConfig } from "../../../src/db";
// Vite treats any ?url import as a copied asset with a hashed URL. The
// sqlite3-read-tracking package exports its .wasm file under the "./wasm"
// condition (see its package.json `exports`), so this resolves directly to
// the file inside node_modules without needing to stage a copy in /public.
import wasmUrl from "sqlite3-read-tracking/wasm?url";

let configured = false;

export function configureSqlite(): void {
  if (configured) return;
  setSqliteInitConfig({
    locateFile: (name) => (name === "sqlite3-tracked.wasm" ? wasmUrl : name),
  });
  configured = true;
}
