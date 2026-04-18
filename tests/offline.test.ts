import { describe, expect, it } from "vitest";
import { Store } from "../src/index.ts";
import type { Resolver } from "../src/types.ts";
import { INIT_SCHEMA, buildActions, readKV } from "./helpers.ts";
import { fileSyncAll, fileSyncDirected, fileSyncPush, makeCluster } from "./cluster-helpers.ts";

/**
 * These tests model the real deployment: each peer lives on its own host
 * with its own local `<root>` directory. The library does not sync files —
 * Syncthing (simulated by fileSync* helpers) does. A peer only ever sees
 * remote writes after an explicit `fileSync…(...)` call, matching debounced
 * Syncthing delivery in production.
 *
 * The pattern in each test: open → submit (local, offline) → fileSync
 * (Syncthing delivers) → sync (peer-sync, like `git rebase origin/master`).
 */
describe("offline / multi-host (separate roots + explicit file sync)", () => {
  it("alice submits fully offline; after Syncthing delivers, master incorporates", async () => {
    const cluster = makeCluster(["master", "alice"], "master");
    const actions = buildActions();

    // Master bootstraps. Its files exist only on master's host.
    const master = await Store.open({
      root: cluster.root("master"),
      peerId: "master",
      masterId: "master",
      actions,
    });
    await master.submit(INIT_SCHEMA, {});
    await master.sync();

    // Syncthing delivers master's files to alice's host.
    fileSyncPush(cluster, "master");

    // Alice opens on her host — auto-catches-up to master's state via her
    // local copy of master.jsonl + snapshot.db.
    const alice = await Store.open({
      root: cluster.root("alice"),
      peerId: "alice",
      masterId: "master",
      actions,
    });
    expect(readKV(alice)).toEqual({});

    // Alice goes offline (no file sync) and writes several actions.
    await alice.submit("set", { k: "offline-1", v: "x" });
    await alice.submit("set", { k: "offline-2", v: "y" });

    // Master still can't see alice's writes — her jsonl hasn't reached master's host.
    const m0 = await master.sync();
    expect(m0.applied).toBe(0);
    expect(readKV(master)).toEqual({});

    // Syncthing delivers alice's log to master's host.
    fileSyncPush(cluster, "alice");

    // Now master sees alice's work.
    const m1 = await master.sync();
    expect(m1.applied).toBe(2);
    expect(readKV(master)).toEqual({ "offline-1": "x", "offline-2": "y" });

    // Files flow back to alice.
    fileSyncPush(cluster, "master");
    await alice.sync();
    expect(readKV(alice)).toEqual({ "offline-1": "x", "offline-2": "y" });

    master.close();
    alice.close();
  });

  it("alice's local master-view is stale; her offline submit conflicts when Syncthing catches up", async () => {
    const cluster = makeCluster(["master", "alice", "bob"], "master");
    const actions = buildActions();

    const master = await Store.open({
      root: cluster.root("master"),
      peerId: "master",
      masterId: "master",
      actions,
    });
    await master.submit(INIT_SCHEMA, {});
    await master.submit("set", { k: "shared", v: "orig" });
    await master.sync();
    fileSyncAll(cluster);

    const alice = await Store.open({
      root: cluster.root("alice"),
      peerId: "alice",
      masterId: "master",
      actions,
    });
    const bob = await Store.open({
      root: cluster.root("bob"),
      peerId: "bob",
      masterId: "master",
      actions,
    });
    expect(readKV(alice).shared).toBe("orig");
    expect(readKV(bob).shared).toBe("orig");

    // Bob (online) submits and master incorporates — master's state moves on,
    // but only bob's and master's hosts know about it so far.
    await bob.submit("set", { k: "shared", v: "bob-wrote" });
    fileSyncPush(cluster, "bob");
    await master.sync();
    expect(readKV(master)).toEqual({ shared: "bob-wrote" });

    // Alice — meanwhile isolated — writes based on her stale view where shared=orig.
    await alice.submit("set", { k: "shared", v: "alice-wrote" });
    expect(readKV(alice)).toEqual({ shared: "alice-wrote" });

    // Syncthing finally delivers master's (and bob's) updates to alice.
    fileSyncPush(cluster, "master");

    // Alice rebases (peer-sync == git rebase origin/master). Her action
    // conflicts with the bob→master write; resolver is invoked.
    const kinds: string[] = [];
    const resolver: Resolver = (ctx) => {
      kinds.push(ctx.kind);
      return "drop";
    };
    await alice.sync({ onConflict: resolver });
    expect(kinds).toEqual(["non_commutative"]);
    expect(readKV(alice)).toEqual({ shared: "bob-wrote" });

    master.close();
    alice.close();
    bob.close();
  });

  it("two peers write offline concurrently; Syncthing delivers alice first, bob stalls until next round", async () => {
    const cluster = makeCluster(["master", "alice", "bob"], "master");
    const actions = buildActions();

    const master = await Store.open({
      root: cluster.root("master"),
      peerId: "master",
      masterId: "master",
      actions,
    });
    await master.submit(INIT_SCHEMA, {});
    await master.submit("set", { k: "counter", v: "start" });
    await master.sync();
    fileSyncAll(cluster);

    const alice = await Store.open({
      root: cluster.root("alice"),
      peerId: "alice",
      masterId: "master",
      actions,
    });
    const bob = await Store.open({
      root: cluster.root("bob"),
      peerId: "bob",
      masterId: "master",
      actions,
    });

    // Both offline; concurrent conflicting writes.
    await alice.submit("set", { k: "counter", v: "alice" });
    await bob.submit("set", { k: "counter", v: "bob" });

    // Syncthing delivers ONLY alice's log to master first (bob is still mid-sync).
    fileSyncPush(cluster, "alice");
    const m1 = await master.sync();
    expect(m1.applied).toBe(1);
    expect(readKV(master)).toEqual({ counter: "alice" });

    // Syncthing delivers bob's log and master's updated files.
    fileSyncPush(cluster, "bob");
    fileSyncPush(cluster, "master");

    // Master sees bob's pending action. Now that alice's write is already in
    // master, bob's conflicts — master stops processing bob.
    const m2 = await master.sync();
    expect(m2.applied).toBe(0);
    expect(m2.skipped).toBe(1);

    // Bob peer-syncs: hits the conflict, forces.
    await bob.sync({ onConflict: () => "force" });
    fileSyncPush(cluster, "bob");

    // Master sync: bob's force is valid (no other-peer activity between bob's
    // baseMasterSeq and master head since bob re-synced).
    await master.sync();
    expect(readKV(master)).toEqual({ counter: "bob" });

    master.close();
    alice.close();
    bob.close();
  });

  it("startup auto-catch-up: alice on a new host syncs in Syncthing-delivered files and immediately reflects cluster state", async () => {
    const cluster = makeCluster(["master", "alice"], "master");
    const actions = buildActions();

    // Master does meaningful work in isolation.
    const master = await Store.open({
      root: cluster.root("master"),
      peerId: "master",
      masterId: "master",
      actions,
    });
    await master.submit(INIT_SCHEMA, {});
    await master.submit("set", { k: "server-state", v: "42" });
    await master.submit("inc", { by: 7 });
    await master.sync();

    // Syncthing delivers to alice's host. Alice hasn't even opened yet.
    fileSyncPush(cluster, "master");

    // Alice opens for the first time. No local log; auto-catch-up picks up
    // everything from her local copies of master.jsonl + snapshot.db.
    const alice = await Store.open({
      root: cluster.root("alice"),
      peerId: "alice",
      masterId: "master",
      actions,
    });
    expect(readKV(alice)).toEqual({ "server-state": "42" });
    expect(
      (alice.db.prepare("SELECT n FROM counter WHERE id=1").get() as { n: number }).n,
    ).toBe(7);

    // Alice proposes her own action, offline.
    await alice.submit("inc", { by: 3 });

    // Syncthing pushes alice's log; master syncs, picks it up, snapshot can
    // squash once alice acks (which happens on her next peer-sync).
    fileSyncPush(cluster, "alice");
    await master.sync();
    expect(
      (master.db.prepare("SELECT n FROM counter WHERE id=1").get() as { n: number }).n,
    ).toBe(10);

    fileSyncPush(cluster, "master");
    await alice.sync();
    fileSyncPush(cluster, "alice");
    const mFinal = await master.sync();
    expect(mFinal.squashedTo).toBeGreaterThan(0);

    master.close();
    alice.close();
  });

  it("squash cycle reaches a peer in two Syncthing rounds: trimmed log first trips FileSyncLagError, snapshot arrives next", async () => {
    const cluster = makeCluster(["master", "alice"], "master");
    const actions = buildActions();

    const master = await Store.open({
      root: cluster.root("master"),
      peerId: "master",
      masterId: "master",
      actions,
    });
    await master.submit(INIT_SCHEMA, {});
    await master.submit("set", { k: "x", v: "1" });
    await master.sync();
    fileSyncAll(cluster);

    const alice = await Store.open({
      root: cluster.root("alice"),
      peerId: "alice",
      masterId: "master",
      actions,
    });
    await alice.sync();
    fileSyncPush(cluster, "alice");
    // Master squashes (snapshot.db + trimmed master.jsonl are now both new on master's host).
    const squashReport = await master.sync();
    expect(squashReport.squashedTo).toBeGreaterThan(0);
    alice.close();

    // Simulate Syncthing delivering the trimmed master.jsonl BUT NOT the
    // new snapshot.db to alice's host yet.
    const { copyFileSync: copy } = await import("node:fs");
    const { peerLogPath: lp, snapshotPath: sp } = await import("../src/paths.ts");
    copy(lp(cluster.root("master"), "master"), lp(cluster.root("alice"), "master"));
    // snapshot.db on alice's host is intentionally left at the pre-squash version.

    // Alice opening now observes the inconsistency and refuses.
    const { FileSyncLagError } = await import("../src/index.ts");
    await expect(
      Store.open({
        root: cluster.root("alice"),
        peerId: "alice",
        masterId: "master",
        actions,
      }),
    ).rejects.toBeInstanceOf(FileSyncLagError);

    // Later, Syncthing delivers snapshot.db too. Alice now opens cleanly.
    copy(sp(cluster.root("master")), sp(cluster.root("alice")));
    const alice2 = await Store.open({
      root: cluster.root("alice"),
      peerId: "alice",
      masterId: "master",
      actions,
    });
    expect(readKV(alice2)).toEqual({ x: "1" });

    master.close();
    alice2.close();
  });

  it("debounced file-watch pattern: peer re-syncs whenever cluster files change, catches up with no explicit application code", async () => {
    // This is the loop a file-watcher would run: whenever master.jsonl or
    // snapshot.db changes on disk, call alice.sync(). The library must
    // handle arbitrarily many such re-entrant syncs without drift.
    const cluster = makeCluster(["master", "alice"], "master");
    const actions = buildActions();

    const master = await Store.open({
      root: cluster.root("master"),
      peerId: "master",
      masterId: "master",
      actions,
    });
    await master.submit(INIT_SCHEMA, {});
    await master.sync();
    fileSyncPush(cluster, "master");

    const alice = await Store.open({
      root: cluster.root("alice"),
      peerId: "alice",
      masterId: "master",
      actions,
    });

    // Simulate multiple Syncthing deliveries with peer-sync run after each.
    for (let i = 0; i < 5; i++) {
      await master.submit("set", { k: `k${i}`, v: String(i) });
      await master.sync();
      fileSyncPush(cluster, "master");
      await alice.sync(); // debounced file-watch triggered peer-sync
    }
    expect(Object.keys(readKV(alice))).toHaveLength(5);

    // Now alice writes while offline; a later file-watch tick catches master up.
    await alice.submit("set", { k: "from-alice", v: "offline-write" });
    fileSyncPush(cluster, "alice");
    await master.sync();
    expect(readKV(master)["from-alice"]).toBe("offline-write");

    master.close();
    alice.close();
  });
});
