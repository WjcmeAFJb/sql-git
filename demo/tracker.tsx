#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import React from "react";
import { render } from "ink";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./app.tsx";

type Args = {
  path?: string;
  peerId?: string;
  masterId?: string;
  seed?: boolean;
  watchDebounce?: number;
  noWatch?: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--peer-id" || a === "--peer") out.peerId = next();
    else if (a === "--master-id" || a === "--master") out.masterId = next();
    else if (a === "--seed") out.seed = true;
    else if (a === "--watch-debounce") out.watchDebounce = Number(next());
    else if (a === "--no-watch") out.noWatch = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        `tracker — ink TUI money tracker backed by sql-git

USAGE
  tracker PATH --peer-id ID [--master ID] [--seed] [--watch-debounce ms] [--no-watch]

PATH is a host directory created with 'syncer create-host PATH'. The master id
is read from PATH/host.json unless overridden with --master.`,
      );
      process.exit(0);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (!out.path) {
      out.path = a;
    } else {
      throw new Error(`unexpected positional arg: ${a}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.path) {
  console.error("tracker: PATH required. Run 'tracker --help' for usage.");
  process.exit(2);
}
if (!args.peerId) {
  console.error("tracker: --peer-id is required.");
  process.exit(2);
}

let masterId = args.masterId;
if (!masterId) {
  const configPath = join(args.path, "host.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (typeof cfg.masterId === "string") masterId = cfg.masterId;
    } catch {
      /* fall through */
    }
  }
}
if (!masterId) {
  console.error(
    `tracker: cannot determine master id. Either create the host first ('syncer create-host ${args.path}') or pass --master.`,
  );
  process.exit(2);
}

render(
  <App
    root={args.path}
    peerId={args.peerId}
    masterId={masterId}
    seed={args.seed ?? false}
    watchDebounceMs={args.watchDebounce ?? 300}
    noWatch={args.noWatch ?? false}
  />,
);
