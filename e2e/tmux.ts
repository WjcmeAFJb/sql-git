import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

export function tmpRoot(prefix = "sqlgit-e2e-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function tmuxAvailable(): boolean {
  try {
    const { execFileSync } = require("node:child_process");
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A single detached tmux session running one command. */
export class Term {
  readonly name: string;
  private killed = false;

  constructor(label: string) {
    this.name = `sqlgit-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async start(command: string, opts: { cols?: number; rows?: number; cwd?: string } = {}): Promise<void> {
    const cols = opts.cols ?? 180;
    const rows = opts.rows ?? 50;
    const args = ["new-session", "-d", "-s", this.name, "-x", String(cols), "-y", String(rows)];
    if (opts.cwd) args.push("-c", opts.cwd);
    args.push(command);
    await execFileP("tmux", args);
    // Detached tmux sessions spawn with a default 80×24 pty regardless of
    // -x/-y; resize-window actually sizes the pty so inner Ink apps see the
    // intended width.
    await execFileP("tmux", ["resize-window", "-t", this.name, "-x", String(cols), "-y", String(rows)]);
  }

  async sendText(text: string): Promise<void> {
    await execFileP("tmux", ["send-keys", "-t", this.name, "-l", text]);
  }

  async sendKey(key: string): Promise<void> {
    await execFileP("tmux", ["send-keys", "-t", this.name, key]);
  }

  async sendKeys(...keys: string[]): Promise<void> {
    for (const k of keys) await this.sendKey(k);
  }

  async screen(): Promise<string> {
    const { stdout } = await execFileP("tmux", [
      "capture-pane",
      "-t",
      this.name,
      "-p",
      "-S",
      "-200",
    ]);
    return stdout;
  }

  async waitFor(
    predicate: (screen: string) => boolean,
    opts: { timeoutMs?: number; pollMs?: number; label?: string } = {},
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 10000;
    const pollMs = opts.pollMs ?? 120;
    const started = Date.now();
    let last = "";
    while (Date.now() - started < timeoutMs) {
      last = await this.screen();
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
      `waitFor${opts.label ? " [" + opts.label + "]" : ""} timed out after ${timeoutMs}ms. Last screen:\n${last}`,
    );
  }

  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    try {
      await execFileP("tmux", ["kill-session", "-t", this.name]);
    } catch {
      /* already gone */
    }
  }
}

/** Tracks Terms and temp dirs for afterEach cleanup. */
export class Scene {
  readonly terms: Term[] = [];
  readonly tmpDirs: string[] = [];

  tmpDir(sub?: string): string {
    const r = tmpRoot();
    this.tmpDirs.push(r);
    const full = sub ? join(r, sub) : r;
    if (sub) require("node:fs").mkdirSync(full, { recursive: true });
    return full;
  }

  spawn(label: string): Term {
    const t = new Term(label);
    this.terms.push(t);
    return t;
  }

  async teardown(): Promise<void> {
    for (const t of this.terms) await t.kill();
    this.terms.length = 0;
    for (const d of this.tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    this.tmpDirs.length = 0;
  }
}
