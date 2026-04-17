#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import chokidar from "chokidar";
import { peerLogPath, snapshotPath } from "../src/paths.ts";

type Host = { root: string; peerId: string };

type Args = {
  command: "one-shot" | "watch";
  hosts: Host[];
  masterId: string;
  intervalMs: number;
  debounceMs: number;
  verbose: boolean;
};

function parseArgs(argv: string[]): Args {
  const hosts: Host[] = [];
  let command: "one-shot" | "watch" = "one-shot";
  let masterId = "";
  let intervalMs = 0;
  let debounceMs = 150;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "one-shot" || a === "watch") command = a;
    else if (a === "--host") {
      const spec = next();
      const eq = spec.indexOf("=");
      if (eq < 0) throw new Error(`--host expected peerId=/root/path, got "${spec}"`);
      hosts.push({ peerId: spec.slice(0, eq), root: spec.slice(eq + 1) });
    } else if (a === "--master") masterId = next();
    else if (a === "--interval") intervalMs = Number(next());
    else if (a === "--debounce") debounceMs = Number(next());
    else if (a === "--verbose" || a === "-v") verbose = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        `sql-git-sync one-shot|watch --host PEER=/root/path [--host …] --master PEER [--interval ms] [--debounce ms] [-v]
  one-shot: propagate once and exit
  watch:    long-running, propagates on file changes (or every --interval ms, if set)`,
      );
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  if (hosts.length < 2) throw new Error("need at least --host twice");
  if (!masterId) throw new Error("--master required");
  if (!hosts.some((h) => h.peerId === masterId)) {
    throw new Error(`--master ${masterId} does not match any --host`);
  }
  return { command, hosts, masterId, intervalMs, debounceMs, verbose };
}

/** Files each peer "owns" (is the sole writer of). */
function ownedFiles(host: Host, masterId: string): string[] {
  const files: string[] = [peerLogPath(host.root, host.peerId)];
  if (host.peerId === masterId) files.push(snapshotPath(host.root));
  return files;
}

function copyIfChanged(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  if (existsSync(dst)) {
    const a = statSync(src);
    const b = statSync(dst);
    if (a.size === b.size && a.mtimeMs <= b.mtimeMs) return false;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return true;
}

function propagate(args: Args): number {
  let copied = 0;
  for (const owner of args.hosts) {
    const srcFiles = ownedFiles(owner, args.masterId);
    for (const target of args.hosts) {
      if (target.peerId === owner.peerId) continue;
      for (const src of srcFiles) {
        const rel = src.slice(owner.root.length);
        const dst = target.root + rel;
        if (copyIfChanged(src, dst)) {
          copied++;
          if (args.verbose) {
            console.log(`  ${owner.peerId} -> ${target.peerId}: ${rel.replace(/^\//, "")}`);
          }
        }
      }
    }
  }
  return copied;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "one-shot") {
    const n = propagate(args);
    if (args.verbose) console.log(`propagated ${n} file(s)`);
    return;
  }

  // watch mode
  const watchers = args.hosts.map((h) =>
    chokidar.watch(h.root, {
      ignoreInitial: false,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 30, pollInterval: 20 },
    }),
  );

  let timer: NodeJS.Timeout | null = null;
  const schedule = (evt?: string, p?: string) => {
    if (args.verbose) console.log(`event ${evt ?? "?"} ${p ?? ""}`);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const n = propagate(args);
      if (args.verbose && n > 0) console.log(`[${new Date().toISOString()}] propagated ${n}`);
    }, args.debounceMs);
  };
  for (const w of watchers) w.on("all", (evt, p) => schedule(evt, p));

  if (args.intervalMs > 0) {
    setInterval(() => propagate(args), args.intervalMs);
  }

  // Do one pass immediately so initial state converges.
  propagate(args);
  if (args.verbose) console.log(`watching ${args.hosts.length} hosts…`);

  // Stay alive.
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      for (const w of watchers) void w.close();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
