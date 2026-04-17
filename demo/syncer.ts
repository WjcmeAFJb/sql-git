#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { peersDir, snapshotPath } from "../src/paths.ts";

const HOST_JSON = "host.json";

function usage(): never {
  console.log(
    `syncer — manual file-sync utility for sql-git host directories
         (not Syncthing — a one-shot demo tool; run it whenever you want to "fetch")

USAGE
  syncer create-host PATH [--master PEER_ID]  create a host dir (default master: "master")
  syncer sync A B [C …] [-v]                  bidirectional file sync, newest wins

NOTES
  - Each peer only writes its own peers/<peerId>.jsonl; only master writes snapshot.db.
    'syncer sync' is safe between arbitrarily many hosts because every file has one writer.
  - 'create-host' writes host.json with the masterId; 'tracker' reads it on launch.
`,
  );
  process.exit(0);
}

type HostConfig = { masterId: string };

function readHostConfig(path: string): HostConfig | null {
  const file = join(path, HOST_JSON);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HostConfig;
  } catch {
    return null;
  }
}

function writeHostConfig(path: string, config: HostConfig): void {
  mkdirSync(path, { recursive: true });
  const tmp = join(path, `${HOST_JSON}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  renameSync(tmp, join(path, HOST_JSON));
}

function createHost(args: string[]): void {
  let path: string | undefined;
  let master = "master";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--master") master = args[++i];
    else if (!path) path = a;
    else throw new Error(`create-host: unexpected arg '${a}'`);
  }
  if (!path) throw new Error("create-host: PATH required");

  mkdirSync(peersDir(path), { recursive: true });
  const existing = readHostConfig(path);
  if (existing && existing.masterId !== master) {
    throw new Error(
      `create-host: ${path}/${HOST_JSON} already exists with master="${existing.masterId}" (requested "${master}"). Delete it to recreate.`,
    );
  }
  writeHostConfig(path, { masterId: master });
  console.log(`created host at ${path} (master=${master})`);
}

type SyncFile = { rel: string; abs: string; mtimeMs: number; size: number };

function listSyncableFiles(host: string): SyncFile[] {
  const files: SyncFile[] = [];
  const snap = snapshotPath(host);
  if (existsSync(snap)) {
    const s = statSync(snap);
    files.push({ rel: "snapshot.db", abs: snap, mtimeMs: s.mtimeMs, size: s.size });
  }
  const pd = peersDir(host);
  if (existsSync(pd)) {
    for (const f of readdirSync(pd)) {
      if (!f.endsWith(".jsonl")) continue;
      const abs = join(pd, f);
      const s = statSync(abs);
      files.push({ rel: `peers/${f}`, abs, mtimeMs: s.mtimeMs, size: s.size });
    }
  }
  return files;
}

function copyAtomic(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-syncer`;
  copyFileSync(src, tmp);
  renameSync(tmp, dst);
}

/** Bidirectional propagation: for each file seen in any host, copy the newest to the rest. */
function propagate(hosts: string[], verbose = false): number {
  const best = new Map<string, SyncFile>();
  for (const h of hosts) {
    for (const f of listSyncableFiles(h)) {
      const existing = best.get(f.rel);
      if (!existing || f.mtimeMs > existing.mtimeMs) best.set(f.rel, f);
    }
  }
  let copied = 0;
  for (const [rel, winner] of best) {
    for (const h of hosts) {
      const target = join(h, rel);
      if (target === winner.abs) continue;
      if (existsSync(target)) {
        const d = statSync(target);
        if (d.size === winner.size && d.mtimeMs >= winner.mtimeMs) continue;
      }
      copyAtomic(winner.abs, target);
      copied++;
      if (verbose) console.log(`  ${winner.abs} -> ${target}`);
    }
  }
  return copied;
}

function syncCmd(args: string[]): void {
  const verbose = args.includes("-v") || args.includes("--verbose");
  const hosts = args.filter((a) => !a.startsWith("-"));
  if (hosts.length < 2) throw new Error("sync: need at least two host paths");
  for (const h of hosts) {
    if (!existsSync(h)) throw new Error(`sync: host path does not exist: ${h}`);
  }
  const n = propagate(hosts, verbose);
  if (verbose) console.log(`propagated ${n} file(s)`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (!cmd || cmd === "-h" || cmd === "--help") usage();
  switch (cmd) {
    case "create-host":
      createHost(rest);
      break;
    case "sync":
      syncCmd(rest);
      break;
    default:
      throw new Error(`unknown command: '${cmd}'. Run 'syncer --help'.`);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
