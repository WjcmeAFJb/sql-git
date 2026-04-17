#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";

type Args = {
  root?: string;
  peer?: string;
  master?: string;
  seed?: boolean;
  watchDebounce?: number;
  noWatch?: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--root") out.root = next();
    else if (a === "--peer") out.peer = next();
    else if (a === "--master") out.master = next();
    else if (a === "--seed") out.seed = true;
    else if (a === "--watch-debounce") out.watchDebounce = Number(next());
    else if (a === "--no-watch") out.noWatch = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "sql-git-demo --root <dir> --peer <id> --master <id> [--seed] [--watch-debounce ms] [--no-watch]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.root || !args.peer || !args.master) {
  console.error("--root, --peer, --master are required");
  process.exit(2);
}

render(
  <App
    root={args.root}
    peerId={args.peer}
    masterId={args.master}
    seed={args.seed ?? false}
    watchDebounceMs={args.watchDebounce ?? 300}
    noWatch={args.noWatch ?? false}
  />,
);
