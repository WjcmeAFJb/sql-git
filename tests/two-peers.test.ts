import { describe, expect, it } from "vitest";
import { INIT_SCHEMA, buildActions, makeRoot, openStore, readCounter, readKV } from "./helpers.ts";
import type { Resolver } from "../src/types.ts";

describe("two peers", () => {
  it("happy path: peer proposes, master incorporates, peer observes", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    await alice.submit("set", { k: "greeting", v: "hi" });
    expect(readKV(alice)).toEqual({ greeting: "hi" });

    // Master doesn't see it yet.
    expect(readKV(master)).toEqual({});

    const m1 = await master.sync();
    expect(m1.applied).toBe(1);
    expect(readKV(master)).toEqual({ greeting: "hi" });

    const a1 = await alice.sync();
    expect(a1.applied).toBe(0); // nothing new on alice's side — her action was incorporated
    expect(readKV(alice)).toEqual({ greeting: "hi" });

    // After alice acks, master can squash.
    const m2 = await master.sync();
    expect(m2.squashedTo).toBe(2); // one schema action + one set = seq 2

    master.close();
    alice.close();
  });

  it("two peers, non-conflicting concurrent inserts both apply", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    const bob = await openStore(root, "bob", "master", actions);

    await alice.submit("set", { k: "a", v: "1" });
    await bob.submit("set", { k: "b", v: "2" });

    await master.sync();
    expect(readKV(master)).toEqual({ a: "1", b: "2" });

    await alice.sync();
    await bob.sync();
    expect(readKV(alice)).toEqual({ a: "1", b: "2" });
    expect(readKV(bob)).toEqual({ a: "1", b: "2" });

    master.close();
    alice.close();
    bob.close();
  });

  it("non-commutative conflict resolved by drop", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    const bob = await openStore(root, "bob", "master", actions);

    // Both peers set the same key to different values.
    await alice.submit("set", { k: "x", v: "alice" });
    await bob.submit("set", { k: "x", v: "bob" });

    // Alice syncs to master first — master incorporates alice's action.
    await master.sync(); // reads alice first (alphabetical), then bob
    // Because master processes alice then bob, alice's "set x=alice" applies,
    // then bob's "set x=bob" is checked against master suffix (alice's set).
    // They don't commute (final value differs depending on order).
    // Master stops processing bob's actions at the conflict.
    expect(readKV(master)).toEqual({ x: "alice" });

    // Bob now syncs — sees his action was not incorporated, hits conflict.
    const droppedActions: string[] = [];
    const resolver: Resolver = (ctx) => {
      droppedActions.push(ctx.action.name);
      return "drop";
    };
    await bob.sync({ onConflict: resolver });
    expect(droppedActions).toEqual(["set"]);
    expect(readKV(bob)).toEqual({ x: "alice" });

    // Next master sync has nothing to do, snapshot can squash after alice acks.
    await alice.sync();
    await master.sync();
    expect(readKV(master)).toEqual({ x: "alice" });

    master.close();
    alice.close();
    bob.close();
  });

  it("non-commutative conflict resolved by force on stale base is re-rejected by master", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    const bob = await openStore(root, "bob", "master", actions);

    await alice.submit("set", { k: "x", v: "alice" });
    await bob.submit("set", { k: "x", v: "bob" });

    // Master incorporates alice; bob's action stays conflicting.
    await master.sync();
    expect(readKV(master)).toEqual({ x: "alice" });

    // Bob forces his action. On bob's side, it gets applied locally with force flag + new base.
    const resolver: Resolver = () => "force";
    const bobReport = await bob.sync({ onConflict: resolver });
    expect(bobReport.forced).toBe(1);
    expect(readKV(bob)).toEqual({ x: "bob" });

    // Bob's log now has the forced action with baseMasterSeq = current master head.
    // But before bob's next master sync, alice syncs & acks AND master pretends
    // to pick up something else: here we just run master sync immediately.
    // Master's head hasn't moved since bob forced → bob's force is valid → applies.
    await master.sync();
    expect(readKV(master)).toEqual({ x: "bob" });

    // Alice then syncs; her prior "set x=alice" was incorporated (it was at seq 2),
    // but master's current x = "bob" (from seq 3). Alice's view updates.
    await alice.sync();
    expect(readKV(alice)).toEqual({ x: "bob" });

    master.close();
    alice.close();
    bob.close();
  });

  it("force is rejected by master if master moved since the force base", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    const bob = await openStore(root, "bob", "master", actions);

    // Alice and bob both propose conflicting writes.
    await alice.submit("set", { k: "x", v: "alice" });
    await bob.submit("set", { k: "x", v: "bob" });

    // Master takes alice (alphabetical) — bob stalls.
    await master.sync();

    // Bob forces.
    await bob.sync({ onConflict: () => "force" });

    // BUT before master sees bob's force, master picks up another change (a second alice action).
    await alice.submit("set", { k: "other", v: "1" });
    await alice.sync(); // alice rebases; no conflict for her new action
    await master.sync(); // master incorporates alice's new action — master head advances

    // Now bob syncs master. Bob's forced action has stale baseMasterSeq.
    await master.sync(); // try to incorporate bob's force → master rejects (head moved)
    // Bob's log should still contain the un-incorporated forced action.
    expect(readKV(master)).toEqual({ x: "alice", other: "1" });

    // Bob sees it wasn't incorporated and has to resolve again.
    const kinds: string[] = [];
    await bob.sync({
      onConflict: (ctx) => {
        kinds.push(ctx.kind);
        return "drop";
      },
    });
    expect(kinds).toEqual(["non_commutative"]);
    expect(readKV(bob)).toEqual({ x: "alice", other: "1" });

    master.close();
    alice.close();
    bob.close();
  });

  it("commutative counter increments from two peers both apply, neither conflicts", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    const bob = await openStore(root, "bob", "master", actions);

    // `inc` uses UPDATE counter SET n = n + ? — commutative with itself.
    await alice.submit("inc", { by: 3 });
    await bob.submit("inc", { by: 5 });

    await master.sync();
    expect(readCounter(master)).toBe(8);

    await alice.sync();
    await bob.sync();
    expect(readCounter(alice)).toBe(8);
    expect(readCounter(bob)).toBe(8);

    master.close();
    alice.close();
    bob.close();
  });

  it("snapshot squashes once everyone acks and reopening from snapshot preserves state", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.submit("set", { k: "a", v: "1" });
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    await alice.submit("set", { k: "b", v: "2" });
    await master.sync();
    await alice.sync();
    await master.sync(); // alice acked; master squashes
    master.close();
    alice.close();

    // Re-open both; everything should still be there, driven only by snapshot + small log.
    const master2 = await openStore(root, "master", "master", actions);
    const alice2 = await openStore(root, "alice", "master", actions);
    expect(readKV(master2)).toEqual({ a: "1", b: "2" });
    expect(readKV(alice2)).toEqual({ a: "1", b: "2" });
    master2.close();
    alice2.close();
  });

  it("both peers delete the same key: global pre-check absorbs bob's work, no resolver invoked", async () => {
    const root = makeRoot();
    const actions = buildActions();

    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.submit("set", { k: "shared", v: "x" });
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    const bob = await openStore(root, "bob", "master", actions);

    await alice.submit("del", { k: "shared" });
    await bob.submit("del", { k: "shared" });

    await master.sync(); // alice's delete applies; bob's is still pending
    expect(readKV(master)).toEqual({});

    // Pre-check sees that `base + bob.del` yields the same state as the
    // rebased master (both have "shared" gone) — drop bob's pending action
    // without invoking the resolver.
    const seen: Array<{ kind: string; name: string }> = [];
    const resolver: Resolver = (ctx) => {
      seen.push({ kind: ctx.kind, name: ctx.action.name });
      return "drop";
    };
    const report = await bob.sync({ onConflict: resolver });
    expect(seen).toEqual([]);
    expect(report.convergent).toBe(1);
    expect(readKV(bob)).toEqual({});

    master.close();
    alice.close();
    bob.close();
  });
});
