import { describe, expect, it } from "vitest";
import { INIT_SCHEMA, buildActions, makeRoot, openStore, readKV } from "./helpers.ts";
import type { Resolver } from "../src/types.ts";

/**
 * Convergence cases.
 *
 * Peer sync runs three convergence gates before invoking the resolver:
 *   0. Global pre-check — if applying ALL this peer's unincorporated actions
 *      starting from their baseMasterSeq produces exactly the rebased master
 *      state, the peer's entire intent was already realized by master. Drop
 *      everything, acknowledge, skip the per-action loop. This is what
 *      catches "both peers edit+delete the same row" — master and peer end
 *      up at the same final state, even though mid-sequence the `edit` trips
 *      on an already-deleted row.
 *   1. Per-action Tier 1 — R/W-set clustering. Disjoint clusters commute.
 *   2. Per-action Tier 2 — classical `base+A+suffix` vs `base+suffix+A`
 *      permutation. Different orderings with the same final state commute.
 *
 * Only when all three gates flag the action does the resolver see it.
 */
describe("convergence behavior", () => {
  it("disjoint writes to different keys: Tier 1 says commute, no resolver invoked", async () => {
    const root = makeRoot();
    const actions = buildActions();
    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    const bob = await openStore(root, "bob", "master", actions);

    await alice.submit("set", { k: "a", v: "1" });
    await bob.submit("set", { k: "b", v: "2" });
    // alphabetical: alice first → applied; bob's action reads/writes a
    // different row → Tier 1 disjoint → also applied without permutation.
    await master.sync();
    expect(readKV(master)).toEqual({ a: "1", b: "2" });

    master.close();
    alice.close();
    bob.close();
  });

  it("same-value same-key writes: Tier 2 permutation sees equal states and commutes", async () => {
    const root = makeRoot();
    const actions = buildActions();
    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    const bob = await openStore(root, "bob", "master", actions);

    // Both peers set the same key to the SAME value.
    await alice.submit("set", { k: "x", v: "same" });
    await bob.submit("set", { k: "x", v: "same" });
    await master.sync();

    // Master applies alice; bob's has overlapping writes (ww), but Tier 2
    // sees `base+A+B == base+B+A` (both land with x="same"). Commute.
    expect(readKV(master)).toEqual({ x: "same" });

    master.close();
    alice.close();
    bob.close();
  });

  it("two peers independently delete the same row: global pre-check recognizes convergence, no resolver invoked", async () => {
    /*
     * Scenario: alice and bob each do {UPDATE x, DELETE x}. Per-action
     * checks would flag bob's UPDATE as non_commutative (the reordering
     * `alice.set + alice.del + bob.set` ends with bob's value on row, while
     * `bob.set + alice.set + alice.del` ends with "gone"). But the global
     * pre-check notices that `base + bob.set + bob.del` produces EXACTLY
     * the same state as `base + alice.set + alice.del` (both: row gone) —
     * so bob's entire suffix is fully subsumed by master's. Drop all,
     * acknowledge, resolver never runs.
     */
    const root = makeRoot();
    const actions = buildActions();
    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    await master.submit("set", { k: "row", v: "seed" });
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    const bob = await openStore(root, "bob", "master", actions);

    await alice.submit("set", { k: "row", v: "alice-intermediate" });
    await alice.submit("del", { k: "row" });
    await bob.submit("set", { k: "row", v: "bob-intermediate" });
    await bob.submit("del", { k: "row" });

    // Alice wins alphabetically. After alice's two actions, row is deleted.
    await master.sync();
    expect(readKV(master)).toEqual({});

    // Bob now rebases. Global pre-check sees `bob.set+bob.del` on the base
    // yields "row gone" == rebased master state → drop both, never invoke
    // resolver.
    let resolverCalls = 0;
    const resolver: Resolver = () => {
      resolverCalls++;
      return "drop";
    };
    const report = await bob.sync({ onConflict: resolver });
    expect(resolverCalls).toBe(0);
    expect(report.convergent).toBe(2);
    expect(readKV(bob)).toEqual({});

    master.close();
    alice.close();
    bob.close();
  });

  it("bank scenario: both peers edit_tx_amount then delete_transaction — global pre-check absorbs", async () => {
    /*
     * Real-world analog from the demo: two peers both tweak a transaction's
     * amount then delete it. With triggers firing on amount changes, the
     * mid-sequence state of `accounts.balance` is exotic — but the net
     * effect is "tx gone, balances back to original". Global pre-check
     * should recognize this.
     */
    const { bankActions } = await import("../demo/actions.ts");
    const root = makeRoot();
    const master = await openStore(root, "master", "master", bankActions);
    await master.submit("init_bank", {});
    await master.submit("create_account", { id: "a", name: "A", ts: "t" });
    await master.submit("create_account", { id: "b", name: "B", ts: "t" });
    await master.submit("create_income", {
      id: "salary",
      acc_to: "a",
      amount: 100,
      category_id: null,
      memo: "seed",
      ts: "t",
    });
    await master.submit("create_transfer", {
      id: "tx1",
      acc_from: "a",
      acc_to: "b",
      amount: 10,
      memo: "orig",
      ts: "t",
    });
    await master.sync();

    const alice = await openStore(root, "alice", "master", bankActions);
    const bob = await openStore(root, "bob", "master", bankActions);

    await alice.submit("edit_tx_amount", { id: "tx1", amount: 15 });
    await alice.submit("delete_transaction", { id: "tx1" });
    await bob.submit("edit_tx_amount", { id: "tx1", amount: 20 });
    await bob.submit("delete_transaction", { id: "tx1" });

    // Master takes alice's two → tx deleted, balances revert.
    await master.sync();
    let accounts = master.db
      .prepare("SELECT id, balance FROM accounts ORDER BY id")
      .all() as { id: string; balance: number }[];
    expect(accounts).toEqual([
      { id: "a", balance: 100 },
      { id: "b", balance: 0 },
    ]);

    // Bob rebases — same final state for him, no resolver invocation.
    let resolverCalls = 0;
    const report = await bob.sync({
      onConflict: () => {
        resolverCalls++;
        return "drop";
      },
    });
    expect(resolverCalls).toBe(0);
    expect(report.convergent).toBe(2);

    accounts = bob.db
      .prepare("SELECT id, balance FROM accounts ORDER BY id")
      .all() as { id: string; balance: number }[];
    expect(accounts).toEqual([
      { id: "a", balance: 100 },
      { id: "b", balance: 0 },
    ]);

    master.close();
    alice.close();
    bob.close();
  });

  it("mixed suffix: conflict + convergent chain + conflict — only conflicts hit the resolver", async () => {
    /*
     * The user's scenario: peer's log is
     *   [c1-conflict, c2-conflict, v1+v2 convergent pair, c3-conflict, c4-conflict]
     * where (v1, v2) is `edit_tx_amount` + `delete_transaction` on the same tx
     * that master has already edited and deleted equivalently. The chain
     * pre-pass absorbs the (v1, v2) pair silently; the four single-action
     * conflicts still surface to the resolver, one at a time.
     */
    const { bankActions } = await import("../demo/actions.ts");
    const root = makeRoot();
    const master = await openStore(root, "master", "master", bankActions);
    await master.submit("init_bank", {});
    await master.submit("create_account", { id: "a", name: "A", ts: "t" });
    await master.submit("create_account", { id: "b", name: "B", ts: "t" });
    await master.submit("create_category", { id: "food", name: "Food", kind: "expense", ts: "t" });
    await master.submit("create_category", { id: "rent", name: "Rent", kind: "expense", ts: "t" });
    await master.submit("create_income", {
      id: "salary",
      acc_to: "a",
      amount: 1000,
      category_id: null,
      memo: "seed",
      ts: "t",
    });
    // Four separate expense txs (c1-c4 conflicts target these) + one (vx) the
    // convergent pair both edit and delete.
    const seed = (id: string, amount: number, memo: string) =>
      master.submit("create_expense", {
        id,
        acc_from: "a",
        amount,
        category_id: null,
        memo,
        ts: "t",
      });
    await seed("c1", 5, "c1-orig");
    await seed("c2", 6, "c2-orig");
    await seed("vx", 7, "vx-orig");
    await seed("c3", 8, "c3-orig");
    await seed("c4", 9, "c4-orig");
    await master.sync();

    const alice = await openStore(root, "alice", "master", bankActions);
    const bob = await openStore(root, "bob", "master", bankActions);

    // Conflicts: alice and bob set different memos on the same four txs.
    // Convergent pair: both edit vx's amount then delete it.
    const pushBoth = async (name: string, params: unknown) => {
      await alice.submit(name, params);
      await bob.submit(name, params);
    };
    await alice.submit("edit_tx_memo", { id: "c1", memo: "alice-c1" });
    await bob.submit("edit_tx_memo", { id: "c1", memo: "bob-c1" });
    await alice.submit("edit_tx_memo", { id: "c2", memo: "alice-c2" });
    await bob.submit("edit_tx_memo", { id: "c2", memo: "bob-c2" });
    await alice.submit("edit_tx_amount", { id: "vx", amount: 20 });
    await alice.submit("delete_transaction", { id: "vx" });
    await bob.submit("edit_tx_amount", { id: "vx", amount: 30 });
    await bob.submit("delete_transaction", { id: "vx" });
    await alice.submit("edit_tx_memo", { id: "c3", memo: "alice-c3" });
    await bob.submit("edit_tx_memo", { id: "c3", memo: "bob-c3" });
    await alice.submit("edit_tx_memo", { id: "c4", memo: "alice-c4" });
    await bob.submit("edit_tx_memo", { id: "c4", memo: "bob-c4" });
    void pushBoth; // silence the helper we inlined above

    await master.sync(); // alice wins alphabetically; bob's memo conflicts remain
    expect(
      (master.db.prepare("SELECT id, memo FROM transactions ORDER BY id").all() as {
        id: string;
        memo: string;
      }[]).filter((r) => ["c1", "c2", "c3", "c4"].includes(r.id)),
    ).toEqual([
      { id: "c1", memo: "alice-c1" },
      { id: "c2", memo: "alice-c2" },
      { id: "c3", memo: "alice-c3" },
      { id: "c4", memo: "alice-c4" },
    ]);
    // vx was edited+deleted by alice; master has tx gone.
    const vxMaster = master.db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE id='vx'")
      .get() as { n: number };
    expect(vxMaster.n).toBe(0);

    // Bob rebases. The chain pre-pass absorbs the (edit_tx_amount, delete)
    // pair on vx. The four memo conflicts each surface to the resolver.
    const seen: { name: string; id: string; kind: string }[] = [];
    const report = await bob.sync({
      onConflict: (ctx) => {
        const p = ctx.action.params as { id: string };
        seen.push({ name: ctx.action.name, id: p.id, kind: ctx.kind });
        return "drop";
      },
    });
    expect(seen).toEqual([
      { name: "edit_tx_memo", id: "c1", kind: "non_commutative" },
      { name: "edit_tx_memo", id: "c2", kind: "non_commutative" },
      { name: "edit_tx_memo", id: "c3", kind: "non_commutative" },
      { name: "edit_tx_memo", id: "c4", kind: "non_commutative" },
    ]);
    expect(report.convergent).toBe(2); // vx edit + delete absorbed
    expect(report.dropped).toBe(4);

    master.close();
    alice.close();
    bob.close();
  });

  it("R/W set clustering skips permutation for unrelated rows even with a long master suffix", async () => {
    /*
     * Regression-style guard for Tier 1: a peer proposing a write on row
     * "peer" should not need to permute against a pile of unrelated master
     * activity on rows "m0".."m9". Tier 1 sees no conflict edges → fast
     * path, no cloneDb + apply + apply dance.
     */
    const root = makeRoot();
    const actions = buildActions();
    const master = await openStore(root, "master", "master", actions);
    await master.submit(INIT_SCHEMA, {});
    for (let i = 0; i < 10; i++) master.submit("set", { k: `m${i}`, v: String(i) });
    await master.sync();

    const alice = await openStore(root, "alice", "master", actions);
    // Meanwhile master keeps writing its own rows.
    for (let i = 10; i < 20; i++) master.submit("set", { k: `m${i}`, v: String(i) });
    await alice.submit("set", { k: "peer", v: "p" });

    await master.sync();
    const kv = readKV(master);
    expect(kv.peer).toBe("p");
    expect(kv.m19).toBe("19");

    master.close();
    alice.close();
  });
});
