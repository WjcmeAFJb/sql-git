import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Store, FileSyncLagError } from "../src/index.ts";
import { readLog } from "../src/log.ts";
import { peerLogPath, peersDir, snapshotPath } from "../src/paths.ts";
import type { MasterLogEntry } from "../src/types.ts";
import { INIT_SCHEMA, buildActions, makeRoot, openStore, readKV } from "./helpers.ts";

describe("file-sync robustness", () => {
  it("readLog drops a truncated trailing line (mid-append / mid-file-sync artifact)", () => {
    const root = makeRoot();
    mkdirSync(peersDir(root), { recursive: true });
    const p = peerLogPath(root, "writer");
    const l1 = JSON.stringify({ kind: "action", seq: 1, name: "a", params: {}, baseMasterSeq: 0 });
    const l2 = JSON.stringify({ kind: "action", seq: 2, name: "b", params: {}, baseMasterSeq: 0 });
    const partial = '{"kind":"action","seq":3,"name":"c"'; // truncated: no closing brace, no newline
    writeFileSync(p, `${l1}\n${l2}\n${partial}`);

    const parsed = readLog<{ kind: string; seq?: number }>(p);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("readLog returns [] on a never-written log file (Syncthing placeholder)", () => {
    const root = makeRoot();
    mkdirSync(peersDir(root), { recursive: true });
    const p = peerLogPath(root, "empty");
    writeFileSync(p, "");
    expect(readLog(p)).toEqual([]);
  });

  it("peer open throws FileSyncLagError if master log declares a snapshot head the local snapshot.db hasn't caught up to", async () => {
    const root = makeRoot();
    mkdirSync(peersDir(root), { recursive: true });

    // Simulate Syncthing delivering a trimmed master.jsonl (with a snapshot
    // marker at seq 5) before the matching snapshot.db. We simply don't
    // write snapshot.db at all — its "head" is effectively 0.
    const masterLog: MasterLogEntry[] = [
      { kind: "snapshot", masterSeq: 5 },
      {
        kind: "action",
        seq: 6,
        name: INIT_SCHEMA,
        params: {},
        source: { peer: "master", seq: 6 },
      },
    ];
    writeFileSync(
      peerLogPath(root, "master"),
      masterLog.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const actions = buildActions();
    let caught: unknown;
    try {
      await openStore(root, "alice", "master", actions);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FileSyncLagError);
    const lag = caught as FileSyncLagError;
    expect(lag.code).toBe("SQLGIT_FILE_SYNC_LAG");
    expect(lag.declaredSnapshotHead).toBe(5);
    expect(lag.snapshotHead).toBe(0);
  });

  it("peer open succeeds once the snapshot catches up; after retry, state reconstructs cleanly", async () => {
    // Build a realistic (root, snapshot.db, master.jsonl) from a working
    // cluster that just squashed, then simulate a partial Syncthing
    // delivery.
    const source = makeRoot();
    const actions = buildActions();
    const master = await openStore(source, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    master.submit("set", { k: "persistent", v: "yes" });
    const alice = await openStore(source, "alice", "master", actions);
    alice.submit("set", { k: "alice-key", v: "1" });
    await master.sync();
    await alice.sync();
    await master.sync(); // squashes — snapshot.db now has head > 0
    master.close();
    alice.close();

    const staleDest = makeRoot();
    mkdirSync(peersDir(staleDest), { recursive: true });
    // Phase 1: Syncthing has delivered only master.jsonl (with snapshot marker).
    copyFileSync(peerLogPath(source, "master"), peerLogPath(staleDest, "master"));

    await expect(openStore(staleDest, "alice", "master", actions)).rejects.toBeInstanceOf(FileSyncLagError);

    // Phase 2: Syncthing catches up — snapshot.db arrives.
    copyFileSync(snapshotPath(source), snapshotPath(staleDest));

    const alice2 = await openStore(staleDest, "alice", "master", actions);
    expect(readKV(alice2)).toEqual({ persistent: "yes", "alice-key": "1" });
    alice2.close();
  });

  it("peer sync throws FileSyncLagError if a squash lands between open and sync (trimmed log arrives alone)", async () => {
    const root = makeRoot();
    const actions = buildActions();
    const master = await openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    master.submit("set", { k: "a", v: "1" });
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    alice.submit("set", { k: "a-local", v: "x" });

    // Simulate: after alice opened, a squash happens externally on master's
    // filesystem and Syncthing delivers the new trimmed master.jsonl to
    // alice — but NOT the matching snapshot.db yet.
    const masterLog = readLog<MasterLogEntry>(peerLogPath(root, "master"));
    const maxSeq = masterLog
      .filter((e): e is Extract<MasterLogEntry, { kind: "action" }> => e.kind === "action")
      .reduce((m, e) => Math.max(m, e.seq), 0);
    const futureHead = maxSeq + 5; // claim a snapshot ahead of anything on disk
    const trimmed: MasterLogEntry[] = [{ kind: "snapshot", masterSeq: futureHead }];
    writeFileSync(
      peerLogPath(root, "master"),
      trimmed.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await expect(alice.sync()).rejects.toBeInstanceOf(FileSyncLagError);

    alice.close();
    master.close();
  });

  it("peer only writing its own log: interleaved local appends and external reads are consistent", async () => {
    // Exercise the no-write-contention invariant: while master's sync reads
    // alice.jsonl, alice keeps writing to it. Each line is a complete JSON
    // record terminated by '\n'; master's reader always observes a
    // well-formed prefix.
    const root = makeRoot();
    const actions = buildActions();
    const master = await openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);

    // Alice submits several actions; between them master reads her log.
    alice.submit("set", { k: "one", v: "1" });
    let snap1 = readFileSync(peerLogPath(root, "alice"), "utf8");
    expect(snap1.endsWith("\n")).toBe(true);

    alice.submit("set", { k: "two", v: "2" });
    let snap2 = readFileSync(peerLogPath(root, "alice"), "utf8");
    expect(snap2.endsWith("\n")).toBe(true);
    expect(snap2.startsWith(snap1)).toBe(true); // append-only

    alice.submit("set", { k: "three", v: "3" });
    await master.sync();
    expect(readKV(master)).toEqual({ one: "1", two: "2", three: "3" });

    master.close();
    alice.close();
  });

  it("atomic rename of snapshot.db: stale .tmp does not shadow the real snapshot", async () => {
    const root = makeRoot();
    const actions = buildActions();
    const master = await openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    master.submit("set", { k: "real", v: "1" });
    const alice = await openStore(root, "alice", "master", actions);
    await master.sync();
    await alice.sync();
    await master.sync(); // squashes

    // Create a bogus .tmp that Syncthing might replicate if it syncs the tmp
    // before the rename. We just want to verify the real file is what open
    // reads.
    const tmpPath = snapshotPath(root) + ".tmp";
    writeFileSync(tmpPath, Buffer.from([0, 0, 0, 0]));

    master.close();
    alice.close();

    const reopened = await openStore(root, "alice", "master", actions);
    expect(readKV(reopened)).toEqual({ real: "1" });
    reopened.close();

    // The real snapshot.db is intact regardless of the stale .tmp.
    expect(existsSync(snapshotPath(root))).toBe(true);
  });

  it("master can incorporate a peer log that arrived via Syncthing between two master.sync calls", async () => {
    const root = makeRoot();
    const actions = buildActions();
    const master = await openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    await master.sync();

    // Alice's log is replicated in from another host — we simulate this by
    // constructing her log directly on disk (no local Store instance for
    // alice). Master picks it up on its next sync, just like Syncthing had
    // delivered it.
    const aliceLog = [
      {
        kind: "action",
        seq: 1,
        name: "set",
        params: { k: "from-remote-alice", v: "hi" },
        baseMasterSeq: 1,
      },
      { kind: "master_ack", masterSeq: 1 },
    ];
    writeFileSync(
      peerLogPath(root, "alice"),
      aliceLog.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const m1 = await master.sync();
    expect(m1.applied).toBe(1);
    expect(readKV(master)).toEqual({ "from-remote-alice": "hi" });

    master.close();
  });
});
