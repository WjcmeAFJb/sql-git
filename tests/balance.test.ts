import { describe, expect, it } from "vitest";
import { Store, type Db } from "../src/index.ts";
import type { ActionRegistry, Resolver } from "../src/types.ts";
import { makeRoot } from "./helpers.ts";

/**
 * Bank schema with a CHECK constraint (balance >= 0) and a trigger that
 * auto-updates balances on every inserted transaction row. This means the
 * action only INSERTs into `transactions` — the trigger enforces the
 * invariant. Race scenarios where two peers each debit an account in
 * amounts individually valid but jointly overdrawing will surface as
 * SQLite CHECK failures during master incorporation.
 */
const bankActions: ActionRegistry = {
  init_bank: (db: Db) => {
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL CHECK (balance >= 0)
      );
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        acc_from TEXT NOT NULL REFERENCES accounts(id),
        acc_to TEXT NOT NULL REFERENCES accounts(id),
        amount INTEGER NOT NULL CHECK (amount > 0)
      );
      CREATE TRIGGER txn_apply AFTER INSERT ON transactions
      BEGIN
        UPDATE accounts SET balance = balance - NEW.amount WHERE id = NEW.acc_from;
        UPDATE accounts SET balance = balance + NEW.amount WHERE id = NEW.acc_to;
      END;
    `);
  },
  open_account: (db, p) => {
    const { id, initial } = p as { id: string; initial: number };
    db.prepare("INSERT INTO accounts (id, balance) VALUES (?, ?)").run(id, initial);
  },
  transfer: (db, p) => {
    const { txId, from, to, amount } = p as {
      txId: string;
      from: string;
      to: string;
      amount: number;
    };
    db.prepare(
      "INSERT INTO transactions (id, acc_from, acc_to, amount) VALUES (?, ?, ?, ?)",
    ).run(txId, from, to, amount);
  },
};

function readAccounts(store: Store): Record<string, number> {
  const rows = store.db
    .prepare("SELECT id, balance FROM accounts ORDER BY id")
    .all() as { id: string; balance: number }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.balance]));
}

function readTransactions(store: Store): Array<{ id: string; from: string; to: string; amount: number }> {
  const rows = store.db
    .prepare(
      "SELECT id, acc_from AS 'from', acc_to AS 'to', amount FROM transactions ORDER BY id",
    )
    .all() as Array<{ id: string; from: string; to: string; amount: number }>;
  return rows;
}

describe("balance constraint with auto-balancing trigger", () => {
  it("alice and bob each overdraw when combined — bob drops his action", async () => {
    const root = makeRoot();
    const master = await Store.open({ root, peerId: "master", masterId: "master", actions: bankActions });
    master.submit("init_bank", {});
    master.submit("open_account", { id: "checking", initial: 100 });
    master.submit("open_account", { id: "savings", initial: 200 });
    master.submit("open_account", { id: "external", initial: 0 });
    await master.sync();

    const alice = await Store.open({ root, peerId: "alice", masterId: "master", actions: bankActions });
    const bob = await Store.open({ root, peerId: "bob", masterId: "master", actions: bankActions });

    // Individually valid for each peer's local view (checking=100).
    alice.submit("transfer", { txId: "alice-1", from: "checking", to: "external", amount: 60 });
    bob.submit("transfer", { txId: "bob-1", from: "checking", to: "external", amount: 50 });

    // Alice wins alphabetically. Bob's transfer then errors on current master state
    // (balance CHECK would fail: 40 - 50 = -10), so master stops processing bob.
    await master.sync();
    expect(readAccounts(master)).toEqual({ checking: 40, savings: 200, external: 60 });
    expect(readTransactions(master)).toEqual([
      { id: "alice-1", from: "checking", to: "external", amount: 60 },
    ]);

    // Bob sees the conflict and drops.
    const seen: Array<{ kind: string; msg?: string }> = [];
    const resolver: Resolver = (ctx) => {
      seen.push({
        kind: ctx.kind,
        msg: ctx.error?.message,
      });
      return "drop";
    };
    await bob.sync({ onConflict: resolver });
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("error");
    expect(seen[0].msg).toMatch(/CHECK constraint failed/);

    // Bob's view now equals master.
    expect(readAccounts(bob)).toEqual({ checking: 40, savings: 200, external: 60 });

    // Alice acks and master squashes.
    await alice.sync();
    await master.sync();
    expect(readAccounts(master)).toEqual({ checking: 40, savings: 200, external: 60 });

    master.close();
    alice.close();
    bob.close();
  });

  it("bob tops up from savings during resolution and retries the original transfer", async () => {
    const root = makeRoot();
    const master = await Store.open({ root, peerId: "master", masterId: "master", actions: bankActions });
    master.submit("init_bank", {});
    master.submit("open_account", { id: "checking", initial: 100 });
    master.submit("open_account", { id: "savings", initial: 200 });
    master.submit("open_account", { id: "external", initial: 0 });
    await master.sync();

    const alice = await Store.open({ root, peerId: "alice", masterId: "master", actions: bankActions });
    const bob = await Store.open({ root, peerId: "bob", masterId: "master", actions: bankActions });

    alice.submit("transfer", { txId: "alice-1", from: "checking", to: "external", amount: 60 });
    bob.submit("transfer", { txId: "bob-1", from: "checking", to: "external", amount: 50 });

    await master.sync(); // alice incorporated; bob errors and stalls

    // Bob resolves: inspect rebasedDb, figure out the shortfall, submit a topup from
    // savings, then retry. After retry, the original transfer has the funds it needs.
    const resolver: Resolver = (ctx) => {
      if (ctx.kind !== "error") return "drop";
      const params = ctx.action.params as { amount: number; from: string };
      const currentBalance = (
        ctx.rebasedDb
          .prepare("SELECT balance FROM accounts WHERE id = ?")
          .get(params.from) as { balance: number } | undefined
      )?.balance ?? 0;
      const shortfall = params.amount - currentBalance;
      if (shortfall <= 0) return "drop"; // shouldn't happen here, but defensively
      ctx.submit("transfer", {
        txId: "bob-topup",
        from: "savings",
        to: params.from,
        amount: shortfall + 10, // a little buffer
      });
      return "retry";
    };

    const report = await bob.sync({ onConflict: resolver });
    expect(report.applied).toBeGreaterThanOrEqual(2); // topup + original
    expect(report.dropped).toBe(0);
    expect(report.forced).toBe(0);

    // Bob's local view: checking = 100 - 60 (alice) + 20 (topup for the 10 shortfall + buffer) - 50 = 10; savings = 200 - 20 = 180.
    expect(readAccounts(bob)).toEqual({ checking: 10, savings: 180, external: 110 });

    // Master picks up bob's two new entries (topup + retried transfer).
    await master.sync();
    expect(readAccounts(master)).toEqual({ checking: 10, savings: 180, external: 110 });
    expect(readTransactions(master).map((t) => t.id).sort()).toEqual([
      "alice-1",
      "bob-1",
      "bob-topup",
    ]);

    await alice.sync();
    expect(readAccounts(alice)).toEqual(readAccounts(master));

    master.close();
    alice.close();
    bob.close();
  });

  it("three-peer overdraft: two peers must each resolve differently (one drops, one tops up)", async () => {
    const root = makeRoot();
    const master = await Store.open({ root, peerId: "master", masterId: "master", actions: bankActions });
    master.submit("init_bank", {});
    master.submit("open_account", { id: "checking", initial: 100 });
    master.submit("open_account", { id: "savings", initial: 200 });
    master.submit("open_account", { id: "external", initial: 0 });
    await master.sync();

    const alice = await Store.open({ root, peerId: "alice", masterId: "master", actions: bankActions });
    const bob = await Store.open({ root, peerId: "bob", masterId: "master", actions: bankActions });
    const carol = await Store.open({ root, peerId: "carol", masterId: "master", actions: bankActions });

    // Each individually OK (80/60/70 on 100 balance). Any two combined overdraft.
    alice.submit("transfer", { txId: "alice-1", from: "checking", to: "external", amount: 80 });
    bob.submit("transfer", { txId: "bob-1", from: "checking", to: "external", amount: 60 });
    carol.submit("transfer", { txId: "carol-1", from: "checking", to: "external", amount: 70 });

    // Master processes alphabetically: alice applies (checking=20), bob errors (20-60<0),
    // carol errors (20-70<0). Both bob and carol stall.
    await master.sync();
    expect(readAccounts(master)).toEqual({ checking: 20, savings: 200, external: 80 });

    // Bob drops.
    await bob.sync({ onConflict: () => "drop" });

    // Carol tops up from savings and retries.
    const carolResolver: Resolver = (ctx) => {
      if (ctx.kind !== "error") return "drop";
      ctx.submit("transfer", {
        txId: "carol-topup",
        from: "savings",
        to: "checking",
        amount: 100,
      });
      return "retry";
    };
    await carol.sync({ onConflict: carolResolver });

    // Bob and carol both wrote their resolutions. Master picks them up.
    // Master order: alice (already in), bob (no new actions), carol (topup + retried).
    await master.sync();
    expect(readAccounts(master)).toEqual({ checking: 50, savings: 100, external: 150 });
    expect(readTransactions(master).map((t) => t.id).sort()).toEqual([
      "alice-1",
      "carol-1",
      "carol-topup",
    ]);

    master.close();
    alice.close();
    bob.close();
    carol.close();
  });

  it("'retry' without any ctx.submit(...) throws to prevent infinite loops", async () => {
    const root = makeRoot();
    const master = await Store.open({ root, peerId: "master", masterId: "master", actions: bankActions });
    master.submit("init_bank", {});
    master.submit("open_account", { id: "checking", initial: 100 });
    master.submit("open_account", { id: "external", initial: 0 });
    await master.sync();

    const alice = await Store.open({ root, peerId: "alice", masterId: "master", actions: bankActions });
    const bob = await Store.open({ root, peerId: "bob", masterId: "master", actions: bankActions });

    alice.submit("transfer", { txId: "alice-1", from: "checking", to: "external", amount: 60 });
    bob.submit("transfer", { txId: "bob-1", from: "checking", to: "external", amount: 50 });
    await master.sync();

    await expect(
      bob.sync({ onConflict: () => "retry" }),
    ).rejects.toThrow(/without any ctx.submit/);

    master.close();
    alice.close();
    bob.close();
  });

  it("reopened log after retry replays in log order (not seq order) — regression", async () => {
    // Regression from the TUI walkthrough: after `retry`, the kept log order
    // is [prepend (high seq), original (low seq)]. If peer-sync processed
    // ownActions by seq instead of log order, it would replay the original
    // *before* its topup on reopen/re-sync and re-trip the very CHECK that
    // the retry just fixed.
    //
    // Reproduction uses two hosts so master's drain doesn't reach alice
    // before she submits her conflicting transfer.
    const { mkdirSync, copyFileSync, existsSync } = await import("node:fs");
    const { peerLogPath, snapshotPath, peersDir } = await import("../src/paths.ts");
    const masterRoot = makeRoot();
    const aliceRoot = makeRoot();
    mkdirSync(peersDir(aliceRoot), { recursive: true });

    const master = await Store.open({ root: masterRoot, peerId: "master", masterId: "master", actions: bankActions });
    master.submit("init_bank", {});
    master.submit("open_account", { id: "checking", initial: 100 });
    master.submit("open_account", { id: "savings", initial: 200 });
    master.submit("open_account", { id: "external", initial: 0 });
    await master.sync();

    // "Syncthing" propagates master's files to alice before she opens.
    copyFileSync(peerLogPath(masterRoot, "master"), peerLogPath(aliceRoot, "master"));
    if (existsSync(snapshotPath(masterRoot))) {
      copyFileSync(snapshotPath(masterRoot), snapshotPath(aliceRoot));
    }

    const alice = await Store.open({ root: aliceRoot, peerId: "alice", masterId: "master", actions: bankActions });
    alice.submit("transfer", {
      txId: "alice-splurge",
      from: "checking",
      to: "external",
      amount: 50,
      ts: "t",
    });
    alice.close();

    // Master then drains checking, BEFORE alice's log reaches master and
    // before master's log reaches alice's host — exactly the window the TUI
    // walkthrough exposed.
    master.submit("transfer", {
      txId: "master-drain",
      from: "checking",
      to: "external",
      amount: 85,
      ts: "t",
    });
    await master.sync();
    copyFileSync(peerLogPath(masterRoot, "master"), peerLogPath(aliceRoot, "master"));

    // Alice reopens, sees master's drain via her log, tries to rebase her
    // pending transfer. Resolver tops up via savings and retries.
    const alice2 = await Store.open({ root: aliceRoot, peerId: "alice", masterId: "master", actions: bankActions });
    await alice2.sync({
      onConflict: (ctx) => {
        ctx.submit("transfer", {
          txId: "alice-topup",
          from: "savings",
          to: "checking",
          amount: 80,
          ts: "t",
        });
        return "retry";
      },
    });
    alice2.close();

    // Another reopen re-derives db from the rewritten log. Log order now has
    // topup (seq 2) before the retried original (seq 1). Calling sync again
    // while master's log has NOT yet been updated with alice's entries
    // exercises the bug: seq-order processing would replay the forced
    // original on state_at(master-drain) before applying the topup and trip
    // CHECK (balance >= 0).
    const alice3 = await Store.open({ root: aliceRoot, peerId: "alice", masterId: "master", actions: bankActions });
    await alice3.sync({ onConflict: () => "drop" });
    const bal = (
      alice3.db.prepare("SELECT balance FROM accounts WHERE id = 'checking'").get() as {
        balance: number;
      }
    ).balance;
    expect(bal).toBeGreaterThanOrEqual(0);
    alice3.close();

    master.close();
  });

  it("retry preserves prepended actions even if resolver then chooses to drop the original", async () => {
    const root = makeRoot();
    const master = await Store.open({ root, peerId: "master", masterId: "master", actions: bankActions });
    master.submit("init_bank", {});
    master.submit("open_account", { id: "checking", initial: 100 });
    master.submit("open_account", { id: "savings", initial: 200 });
    master.submit("open_account", { id: "external", initial: 0 });
    await master.sync();

    const alice = await Store.open({ root, peerId: "alice", masterId: "master", actions: bankActions });
    const bob = await Store.open({ root, peerId: "bob", masterId: "master", actions: bankActions });

    alice.submit("transfer", { txId: "alice-1", from: "checking", to: "external", amount: 60 });
    bob.submit("transfer", { txId: "bob-1", from: "checking", to: "external", amount: 50 });
    await master.sync();

    // Bob topups but then decides to drop the original anyway. The topup should persist.
    const resolver: Resolver = (ctx) => {
      ctx.submit("transfer", {
        txId: "bob-topup",
        from: "savings",
        to: "checking",
        amount: 30,
      });
      return "drop";
    };
    await bob.sync({ onConflict: resolver });

    await master.sync();
    // checking = 40 + 30 (topup) = 70; savings = 170; external = 60.
    expect(readAccounts(master)).toEqual({ checking: 70, savings: 170, external: 60 });
    expect(readTransactions(master).map((t) => t.id).sort()).toEqual(["alice-1", "bob-topup"]);

    master.close();
    alice.close();
    bob.close();
  });

  it("edit salary amount after most of it has been spent (net-delta trigger regression)", async () => {
    /*
     * Regression: a naive `txn_update` trigger unapplies OLD then applies
     * NEW in two steps. The unapply step can drive balance negative and
     * trip `CHECK (balance >= 0)` even when the net edit is valid. The
     * trigger is now a single net-delta UPDATE per affected account.
     */
    const { bankActions } = await import("../demo/actions.ts");
    const root = makeRoot();
    const master = await Store.open({
      root,
      peerId: "master",
      masterId: "master",
      actions: bankActions,
    });
    master.submit("init_bank", {});
    master.submit("create_account", { id: "checking", name: "Checking", ts: "t" });
    master.submit("create_income", {
      id: "salary",
      acc_to: "checking",
      amount: 100,
      category_id: null,
      memo: "pay",
      ts: "t",
    });
    master.submit("create_expense", {
      id: "rent",
      acc_from: "checking",
      amount: 80,
      category_id: null,
      memo: "rent",
      ts: "t",
    });
    // balance(checking) = 100 - 80 = 20 < OLD salary amount (100).
    master.submit("edit_tx_amount", { id: "salary", amount: 80 });
    // Old trigger would have tripped: step 1 = balance - 100 = -80 → CHECK.
    // New trigger: balance += NEW - OLD = 80 - 100 = -20 → balance = 0. ✓
    const bal = (
      master.db.prepare("SELECT balance FROM accounts WHERE id='checking'").get() as {
        balance: number;
      }
    ).balance;
    expect(bal).toBe(0);
    master.close();
  });
});
