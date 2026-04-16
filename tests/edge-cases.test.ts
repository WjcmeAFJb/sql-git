import { describe, expect, it } from "vitest";
import { INIT_SCHEMA, buildActions, makeRoot, openStore, readKV } from "./helpers.ts";

describe("edge cases", () => {
  it("master's own submits interleave with peer actions deterministically", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = openStore(root, "alice", "master", actions);
    const bob = openStore(root, "bob", "master", actions);

    master.submit("set", { k: "m1", v: "mv1" });
    alice.submit("set", { k: "a", v: "av" });
    bob.submit("set", { k: "b", v: "bv" });

    await master.sync();
    // Master's own submit happened before the master.sync picked up peers,
    // so m1 has a smaller seq than incorporated alice/bob actions.
    expect(readKV(master)).toEqual({ m1: "mv1", a: "av", b: "bv" });

    master.submit("set", { k: "m2", v: "mv2" });
    await master.sync(); // nothing new from peers
    expect(readKV(master)).toEqual({ m1: "mv1", a: "av", b: "bv", m2: "mv2" });

    await alice.sync();
    await bob.sync();
    expect(readKV(alice)).toEqual(readKV(master));
    expect(readKV(bob)).toEqual(readKV(master));

    master.close();
    alice.close();
    bob.close();
  });

  it("sync is idempotent: running it twice with no changes is a no-op", async () => {
    const root = makeRoot();
    const actions = buildActions();
    const master = openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    await master.sync();
    const r = await master.sync();
    expect(r).toEqual({ applied: 0, skipped: 0, dropped: 0, forced: 0 });

    const alice = openStore(root, "alice", "master", actions);
    alice.submit("set", { k: "a", v: "1" });
    await master.sync();
    const a1 = await alice.sync();
    const a2 = await alice.sync();
    expect(a1.applied).toBe(0);
    expect(a2).toEqual({ applied: 0, skipped: 0, dropped: 0, forced: 0 });

    master.close();
    alice.close();
  });

  it("master reopens from snapshot+log after squash and state is preserved", async () => {
    const root = makeRoot();
    const actions = buildActions();

    {
      const master = openStore(root, "master", "master", actions);
      master.submit(INIT_SCHEMA, {});
      master.submit("set", { k: "persist", v: "yes" });
      const alice = openStore(root, "alice", "master", actions);
      alice.submit("inc", { by: 7 });
      await master.sync();
      await alice.sync();
      await master.sync(); // squashes
      master.close();
      alice.close();
    }

    // Re-open — snapshot should contain the persisted state, and nextMasterSeq should
    // continue correctly so new submits don't collide with squashed seqs.
    const master = openStore(root, "master", "master", actions);
    expect(readKV(master)).toEqual({ persist: "yes" });
    master.submit("set", { k: "after-reopen", v: "1" });
    await master.sync();
    expect(readKV(master)).toEqual({ persist: "yes", "after-reopen": "1" });

    // Alice also reopens and catches up.
    const alice = openStore(root, "alice", "master", actions);
    expect(readKV(alice)).toEqual({ persist: "yes", "after-reopen": "1" });

    master.close();
    alice.close();
  });

  it("DB comparison detects row-content differences", async () => {
    const { compareDbs } = await import("../src/db.ts");
    const { default: Database } = await import("better-sqlite3");
    const a = new Database(":memory:");
    const b = new Database(":memory:");
    a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    b.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    a.prepare("INSERT INTO t VALUES (1, 'x')").run();
    b.prepare("INSERT INTO t VALUES (1, 'x')").run();
    expect(compareDbs(a, b)).toBe(true);

    b.prepare("UPDATE t SET v = 'y' WHERE id = 1").run();
    expect(compareDbs(a, b)).toBe(false);

    a.close();
    b.close();
  });

  it("DB comparison ignores insertion-order differences for unordered tables", async () => {
    const { compareDbs } = await import("../src/db.ts");
    const { default: Database } = await import("better-sqlite3");
    const a = new Database(":memory:");
    const b = new Database(":memory:");
    a.exec("CREATE TABLE t (k TEXT, v TEXT)");
    b.exec("CREATE TABLE t (k TEXT, v TEXT)");
    a.prepare("INSERT INTO t VALUES ('a', '1')").run();
    a.prepare("INSERT INTO t VALUES ('b', '2')").run();
    b.prepare("INSERT INTO t VALUES ('b', '2')").run();
    b.prepare("INSERT INTO t VALUES ('a', '1')").run();
    expect(compareDbs(a, b)).toBe(true);
    a.close();
    b.close();
  });

  it("peer sync without resolver throws on conflict", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = openStore(root, "alice", "master", actions);
    const bob = openStore(root, "bob", "master", actions);

    alice.submit("set", { k: "x", v: "alice" });
    bob.submit("set", { k: "x", v: "bob" });

    await master.sync(); // alice wins
    await expect(bob.sync()).rejects.toThrow(/onConflict resolver/);

    master.close();
    alice.close();
    bob.close();
  });
});
