import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // sqlite3-read-tracking is a UMD/CJS emscripten bundle. We pre-bundle it
  // through Vite's dep-optimizer so `import initSqliteTracked from …` gets a
  // proper ESM default export. The module's node-only branches live inside
  // runtime `if (ENVIRONMENT_IS_NODE)` checks — esbuild bundles them as
  // dead code for a browser target and never actually resolves node:fs.
  optimizeDeps: {
    include: ["sqlite3-read-tracking"],
  },
  // OPFS is a secure-context API; Vite's dev server already meets that for
  // localhost, no extra headers required for the single-threaded build.
  server: {
    host: '0.0.0.0',
    allowedHosts: [".code.internal.local"]
  }
});
