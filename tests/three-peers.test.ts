import { describe, expect, it } from "vitest";
import { INIT_SCHEMA, buildActions, makeRoot, openStore, readCounter, readKV } from "./helpers.ts";
import type { Resolver } from "../src/types.ts";

describe("three peers", () => {
  it("master + two peers: all commutative counter increments land", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    master.submit("inc", { by: 1 });
    await master.sync();

    const alice = openStore(root, "alice", "master", actions);
    const bob = openStore(root, "bob", "master", actions);

    alice.submit("inc", { by: 10 });
    bob.submit("inc", { by: 100 });
    master.submit("inc", { by: 1000 });

    await master.sync();
    expect(readCounter(master)).toBe(1111);

    await alice.sync();
    await bob.sync();
    expect(readCounter(alice)).toBe(1111);
    expect(readCounter(bob)).toBe(1111);

    // Everyone has acked, master can squash.
    await master.sync();
    expect(readCounter(master)).toBe(1111);

    master.close();
    alice.close();
    bob.close();
  });

  it("one peer offline blocks squash, catching up works once they return", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    master.submit("set", { k: "seed", v: "0" });

    // Create bob's log file so master knows he exists, but then "offline" him
    // by not syncing him after initial creation.
    const bob = openStore(root, "bob", "master", actions);
    bob.close();

    await master.sync();

    const alice = openStore(root, "alice", "master", actions);
    alice.submit("set", { k: "a", v: "alice-val" });
    await master.sync();
    await alice.sync();

    // Even though alice has acked, master cannot squash because bob hasn't.
    const m = await master.sync();
    expect(m.squashedTo).toBeUndefined();

    // Bob comes back online — opens, sees current state, acks.
    const bob2 = openStore(root, "bob", "master", actions);
    expect(readKV(bob2)).toEqual({ seed: "0", a: "alice-val" });
    await bob2.sync();

    // Now master can squash.
    const m2 = await master.sync();
    expect(m2.squashedTo).toBeGreaterThan(0);

    master.close();
    alice.close();
    bob2.close();
  });

  it("force accepted when master head hasn't moved since peer's force base", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = openStore(root, "alice", "master", actions);
    const bob = openStore(root, "bob", "master", actions);

    alice.submit("set", { k: "x", v: "alice" });
    bob.submit("set", { k: "x", v: "bob" });

    await master.sync(); // alice wins alphabetically
    expect(readKV(master)).toEqual({ x: "alice" });

    // Bob forces — alice's incorporation already advanced master head to 2,
    // so bob's force records base=2.
    await bob.sync({ onConflict: () => "force" });
    await alice.sync(); // alice acks (nothing pending)

    // Master hasn't moved since bob's force (only acks happened). Force applies.
    await master.sync();
    expect(readKV(master)).toEqual({ x: "bob" });

    master.close();
    alice.close();
    bob.close();
  });

  it("force rejected when master advances between peer's force and master's next sync", async () => {
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
    // Bob force-syncs — records force with base=master head now (seq 2).
    await bob.sync({ onConflict: () => "force" });

    // Master submits an independent action BEFORE the next master sync picks up bob's force.
    // This advances master head past bob's recorded force base.
    master.submit("set", { k: "y", v: "from-master" });

    // Now master syncs — bob's force has base=2 but current master head=3 → stale, reject.
    await master.sync();
    expect(readKV(master)).toEqual({ x: "alice", y: "from-master" });

    // Bob has to re-resolve. On his next sync, he sees master advanced; his forced action's base
    // is now stale from his own POV too. He forces again with the new base.
    const conflictKinds: string[] = [];
    await bob.sync({
      onConflict: (ctx) => {
        conflictKinds.push(ctx.kind);
        return "force";
      },
    });
    expect(conflictKinds).toEqual(["non_commutative"]);

    // With fresh base, master now accepts bob's force.
    await master.sync();
    expect(readKV(master)).toEqual({ x: "bob", y: "from-master" });

    master.close();
    alice.close();
    bob.close();
  });

  it("chained dependency: peer2 updates what peer1 created", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = openStore(root, "alice", "master", actions);
    // Alice creates a record.
    alice.submit("insertOnce", { k: "doc1", v: "draft" });
    await alice.sync(); // nothing to rebase yet, but writes ack
    await master.sync(); // master picks up alice's action

    const bob = openStore(root, "bob", "master", actions);
    // Bob sees alice's record (via auto-catch-up) and updates it.
    expect(readKV(bob)).toEqual({ doc1: "draft" });
    bob.submit("set", { k: "doc1", v: "published" });

    await master.sync();
    expect(readKV(master)).toEqual({ doc1: "published" });

    await alice.sync();
    await bob.sync();
    expect(readKV(alice)).toEqual({ doc1: "published" });

    master.close();
    alice.close();
    bob.close();
  });

  it("master rejects peer's second action if it depends on a conflicting first action", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = openStore(root, "alice", "master", actions);
    const bob = openStore(root, "bob", "master", actions);

    // Alice races to insert the key.
    alice.submit("insertOnce", { k: "only", v: "alice" });
    // Bob also inserts (will fail against alice after master picks alice).
    bob.submit("insertOnce", { k: "only", v: "bob" });
    // Bob's second action operates on the key — if first is rejected, second is skipped too.
    bob.submit("set", { k: "only", v: "bob-2" });

    await master.sync();
    // Master applies alice's insert, then tries bob: first fails (duplicate), stops.
    expect(readKV(master)).toEqual({ only: "alice" });

    // Bob resolves: drops first action. Second action still wants to set "only=bob-2"
    // but its baseMasterSeq is pre-alice — after rebase onto master containing alice's row,
    // the set succeeds (it's non-commutative with alice's insert, so still a conflict that
    // needs resolution, but a "set" after "insertOnce" works).
    const kinds: string[] = [];
    await bob.sync({
      onConflict: (ctx) => {
        kinds.push(`${ctx.action.name}:${ctx.kind}`);
        if (ctx.action.name === "insertOnce") return "drop";
        return "force";
      },
    });
    expect(kinds).toContain("insertOnce:error");
    // After bob drops first and forces second, master head hasn't moved since bob's last ack,
    // so master accepts bob's forced set.
    await master.sync();
    expect(readKV(master)).toEqual({ only: "bob-2" });

    master.close();
    alice.close();
    bob.close();
  });

  it("rewrite-and-retry: peer drops conflicting action, submits a new one, master incorporates it", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = openStore(root, "master", "master", actions);
    master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = openStore(root, "alice", "master", actions);
    const bob = openStore(root, "bob", "master", actions);

    alice.submit("set", { k: "shared", v: "alice" });
    bob.submit("set", { k: "shared", v: "bob" });

    await master.sync(); // alice in, bob stalls
    await alice.sync();
    expect(readKV(master)).toEqual({ shared: "alice" });

    // Bob drops, then submits a new action that doesn't conflict.
    await bob.sync({ onConflict: () => "drop" });
    bob.submit("set", { k: "bob-only", v: "here" });

    await master.sync();
    expect(readKV(master)).toEqual({ shared: "alice", "bob-only": "here" });

    await alice.sync();
    await bob.sync();
    expect(readKV(alice)).toEqual({ shared: "alice", "bob-only": "here" });
    expect(readKV(bob)).toEqual({ shared: "alice", "bob-only": "here" });

    master.close();
    alice.close();
    bob.close();
  });
});
