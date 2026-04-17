import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Scene, Term, tmuxAvailable } from "./tmux.ts";

const execFileP = promisify(execFile);
const REPO = process.cwd();
const TSX = "./node_modules/.bin/tsx";

function trackerCmd(root: string, peerId: string, extra = ""): string {
  return `${TSX} ${REPO}/demo/tracker.tsx ${root} --peer-id ${peerId} ${extra}`;
}

async function createHost(path: string, masterId: string): Promise<void> {
  await execFileP(TSX, [`${REPO}/demo/syncer.ts`, "create-host", path, "--master", masterId]);
}

async function syncerSync(hosts: string[]): Promise<void> {
  await execFileP(TSX, [`${REPO}/demo/syncer.ts`, "sync", ...hosts]);
}

async function seedMaster(root: string): Promise<void> {
  const mod = await import("../src/index.ts");
  const { bankActions } = await import("../demo/actions.ts");
  const s = mod.Store.open({ root, peerId: "master", masterId: "master", actions: bankActions });
  try {
    s.submit("init_bank", {});
    s.submit("create_account", { id: "checking", name: "Checking", ts: "t0" });
    s.submit("create_account", { id: "savings", name: "Savings", ts: "t0" });
    s.submit("create_category", { id: "food", name: "Food", kind: "expense", ts: "t0" });
    s.submit("create_category", { id: "rent", name: "Rent", kind: "expense", ts: "t0" });
    // seed balances
    s.submit("create_income", {
      id: "seed-chk",
      acc_to: "checking",
      amount: 100,
      category_id: null,
      memo: "initial",
      ts: "t0",
    });
    s.submit("create_income", {
      id: "seed-sav",
      acc_to: "savings",
      amount: 200,
      category_id: null,
      memo: "initial",
      ts: "t0",
    });
    await s.sync();
  } finally {
    s.close();
  }
}

// ─── UI drivers ──────────────────────────────────────────────────────────────
async function submitExpense(t: Term, line: string): Promise<void> {
  await t.sendKey("n");
  await t.waitFor((s) => s.includes("New transaction"));
  await t.sendKey("e");
  await t.waitFor((s) => s.includes("New expense"));
  await t.sendText(line);
  await t.sendKey("Enter");
}
async function submitTransfer(t: Term, line: string): Promise<void> {
  await t.sendKey("n");
  await t.waitFor((s) => s.includes("New transaction"));
  await t.sendKey("x");
  await t.waitFor((s) => s.includes("New transfer"));
  await t.sendText(line);
  await t.sendKey("Enter");
}
async function editMemo(t: Term, line: string): Promise<void> {
  await t.sendKey("e");
  await t.waitFor((s) => s.includes("Edit transaction — pick field"));
  await t.sendKey("m");
  await t.waitFor((s) => s.includes("Edit transaction memo"));
  await t.sendText(line);
  await t.sendKey("Enter");
}
async function editCategory(t: Term, line: string): Promise<void> {
  await t.sendKey("e");
  await t.waitFor((s) => s.includes("Edit transaction — pick field"));
  await t.sendKey("c");
  await t.waitFor((s) => s.includes("Edit transaction category"));
  await t.sendText(line);
  await t.sendKey("Enter");
}
async function retryWithTransfer(t: Term, line: string): Promise<void> {
  await t.sendKey("r");
  await t.waitFor((s) => s.includes("RETRY"));
  await t.sendText(line);
  await t.sendKey("Enter");
}

describe.skipIf(!tmuxAvailable())("e2e: tracker TUI + manual syncer sync", () => {
  let scene: Scene;
  afterEach(async () => {
    await scene.teardown();
  });

  it("happy path: alice submits an expense, syncer propagates, master incorporates", async () => {
    scene = new Scene();
    const masterRoot = scene.tmpDir("master");
    const aliceRoot = scene.tmpDir("alice");
    await createHost(masterRoot, "master");
    await createHost(aliceRoot, "master");
    await seedMaster(masterRoot);
    await syncerSync([masterRoot, aliceRoot]);

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    await m.start(trackerCmd(masterRoot, "master", "--watch-debounce 100"));
    await a.start(trackerCmd(aliceRoot, "alice", "--watch-debounce 100"));
    await m.waitFor((s) => s.includes("ACCT checking") && s.includes("$100"));
    await a.waitFor((s) => s.includes("ACCT checking") && s.includes("$100"));

    await submitExpense(a, "alice-1 checking 60 food morning-latte");
    await a.waitFor((s) => s.includes("TX alice-1") && s.includes("$60"));

    await syncerSync([masterRoot, aliceRoot]);
    await m.waitFor(
      (s) => s.includes("TX alice-1") && s.includes("[expense]") && s.includes("$40"),
      { label: "master incorporated alice-1 (expense)", timeoutMs: 15000 },
    );
    await syncerSync([masterRoot, aliceRoot]);
    await a.waitFor(
      (s) => s.includes("TX alice-1") && s.includes("ACCT checking") && s.includes("$40"),
      { label: "alice caught up with master", timeoutMs: 15000 },
    );
  }, 30000);

  it("overdraft: bob drops the conflicting expense", async () => {
    scene = new Scene();
    const masterRoot = scene.tmpDir("master");
    const aliceRoot = scene.tmpDir("alice");
    const bobRoot = scene.tmpDir("bob");
    await createHost(masterRoot, "master");
    await createHost(aliceRoot, "master");
    await createHost(bobRoot, "master");
    await seedMaster(masterRoot);
    await syncerSync([masterRoot, aliceRoot, bobRoot]);

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    const b = scene.spawn("bob");
    await m.start(trackerCmd(masterRoot, "master", "--watch-debounce 100"));
    await a.start(trackerCmd(aliceRoot, "alice", "--watch-debounce 100"));
    await b.start(trackerCmd(bobRoot, "bob", "--watch-debounce 100"));
    await a.waitFor((s) => s.includes("$100"));
    await b.waitFor((s) => s.includes("$100"));

    await submitExpense(a, "alice-1 checking 60");
    await a.waitFor((s) => s.includes("TX alice-1"));
    await submitExpense(b, "bob-1 checking 50");
    await b.waitFor((s) => s.includes("TX bob-1"));

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) => s.includes("TX alice-1") && s.includes("ACCT checking") && s.includes("$40"),
      { label: "master applied alice's expense", timeoutMs: 15000 },
    );
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("CONFLICT") && s.includes("kind=error"), {
      label: "bob hit the overdraft conflict",
      timeoutMs: 15000,
    });
    await b.sendKey("d");
    await b.waitFor(
      (s) =>
        s.includes("ACCT checking") &&
        s.includes("$40") &&
        s.includes("TX alice-1") &&
        s.includes("pending (0)"),
      { label: "bob converged after dropping", timeoutMs: 15000 },
    );
    expect(await m.screen()).toMatch(/\$40/);
  }, 45000);

  it("overdraft: bob tops up from savings (retry with ctx.submit)", async () => {
    scene = new Scene();
    const masterRoot = scene.tmpDir("master");
    const aliceRoot = scene.tmpDir("alice");
    const bobRoot = scene.tmpDir("bob");
    await createHost(masterRoot, "master");
    await createHost(aliceRoot, "master");
    await createHost(bobRoot, "master");
    await seedMaster(masterRoot);
    await syncerSync([masterRoot, aliceRoot, bobRoot]);

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    const b = scene.spawn("bob");
    await m.start(trackerCmd(masterRoot, "master", "--watch-debounce 100"));
    await a.start(trackerCmd(aliceRoot, "alice", "--watch-debounce 100"));
    await b.start(trackerCmd(bobRoot, "bob", "--watch-debounce 100"));
    await a.waitFor((s) => s.includes("$100"));
    await b.waitFor((s) => s.includes("$100"));

    await submitExpense(a, "alice-1 checking 60");
    await submitExpense(b, "bob-1 checking 50");
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) => s.includes("TX alice-1") && s.includes("ACCT checking") && s.includes("$40"),
      { timeoutMs: 15000 },
    );
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("CONFLICT") && s.includes("kind=error"), {
      timeoutMs: 15000,
    });

    // Retry: topup 20 from savings → checking (making 60), then retry bob's 50 expense (→ 10).
    await retryWithTransfer(b, "bob-topup savings checking 20");
    await b.waitFor(
      (s) =>
        s.includes("TX bob-topup") &&
        s.includes("TX bob-1") &&
        s.includes("ACCT checking") &&
        s.includes("$10") &&
        s.includes("ACCT savings") &&
        s.includes("$180"),
      { label: "bob's local state after topup+retry", timeoutMs: 15000 },
    );

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) =>
        s.includes("TX bob-topup") &&
        s.includes("TX bob-1") &&
        s.includes("ACCT checking") &&
        s.includes("$10") &&
        s.includes("ACCT savings") &&
        s.includes("$180"),
      { label: "master incorporated topup + bob-1", timeoutMs: 15000 },
    );
  }, 60000);

  it("commuting edits: alice updates memo, bob updates category on same tx — both land", async () => {
    scene = new Scene();
    const masterRoot = scene.tmpDir("master");
    const aliceRoot = scene.tmpDir("alice");
    const bobRoot = scene.tmpDir("bob");
    await createHost(masterRoot, "master");
    await createHost(aliceRoot, "master");
    await createHost(bobRoot, "master");
    await seedMaster(masterRoot);
    await syncerSync([masterRoot, aliceRoot, bobRoot]);

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    const b = scene.spawn("bob");
    await m.start(trackerCmd(masterRoot, "master", "--watch-debounce 100"));
    await a.start(trackerCmd(aliceRoot, "alice", "--watch-debounce 100"));
    await b.start(trackerCmd(bobRoot, "bob", "--watch-debounce 100"));
    await a.waitFor((s) => s.includes("$100"));
    await b.waitFor((s) => s.includes("$100"));

    // Seed a shared expense and let it converge everywhere.
    await submitExpense(a, "tx-shared checking 10");
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await a.waitFor((s) => s.includes("TX tx-shared") && s.includes("pending (0)"), {
      timeoutMs: 15000,
    });
    await b.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });

    // Different-field edits → commute.
    await editMemo(a, "tx-shared morning-latte");
    await editCategory(b, "tx-shared food");
    await a.waitFor((s) => s.includes("morning-latte"));
    await b.waitFor((s) => s.includes("cat=Food"));

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) => s.includes("morning-latte") && s.includes("cat=Food"),
      { label: "master has both commuting edits", timeoutMs: 20000 },
    );
  }, 60000);

  it("same-field edits conflict: both peers change the memo; one drops", async () => {
    scene = new Scene();
    const masterRoot = scene.tmpDir("master");
    const aliceRoot = scene.tmpDir("alice");
    const bobRoot = scene.tmpDir("bob");
    await createHost(masterRoot, "master");
    await createHost(aliceRoot, "master");
    await createHost(bobRoot, "master");
    await seedMaster(masterRoot);
    await syncerSync([masterRoot, aliceRoot, bobRoot]);

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    const b = scene.spawn("bob");
    await m.start(trackerCmd(masterRoot, "master", "--watch-debounce 100"));
    await a.start(trackerCmd(aliceRoot, "alice", "--watch-debounce 100"));
    await b.start(trackerCmd(bobRoot, "bob", "--watch-debounce 100"));
    await a.waitFor((s) => s.includes("$100"));
    await b.waitFor((s) => s.includes("$100"));

    await submitExpense(a, "tx-shared checking 10");
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await a.waitFor((s) => s.includes("pending (0)") && s.includes("TX tx-shared"), {
      timeoutMs: 15000,
    });

    // Both change the memo to different values.
    await editMemo(a, "tx-shared alice-memo");
    await editMemo(b, "tx-shared bob-memo");
    await a.waitFor((s) => s.includes("alice-memo"));
    await b.waitFor((s) => s.includes("bob-memo"));

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes("alice-memo"), {
      label: "master picked alice's memo",
      timeoutMs: 15000,
    });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("CONFLICT") && s.includes("kind=non_commutative"), {
      label: "bob's rebase hit non-commutative",
      timeoutMs: 15000,
    });
    await b.sendKey("d");
    await b.waitFor(
      (s) => s.includes("alice-memo") && s.includes("pending (0)"),
      { label: "bob converged to alice's memo", timeoutMs: 15000 },
    );
  }, 60000);

  it("CRUD: create/rename/delete for accounts and categories; delete transaction", async () => {
    scene = new Scene();
    const masterRoot = scene.tmpDir("master");
    const aliceRoot = scene.tmpDir("alice");
    await createHost(masterRoot, "master");
    await createHost(aliceRoot, "master");
    await seedMaster(masterRoot);
    await syncerSync([masterRoot, aliceRoot]);

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    await m.start(trackerCmd(masterRoot, "master", "--watch-debounce 100"));
    await a.start(trackerCmd(aliceRoot, "alice", "--watch-debounce 100"));
    await a.waitFor((s) => s.includes("$100"));

    // Alice: create a new account, rename it.
    await a.sendKey("a"); // accounts tab
    await a.waitFor((s) => s.includes("[a] Accounts"));
    await a.sendKey("n");
    await a.waitFor((s) => s.includes("New account"));
    await a.sendText("cash Wallet");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("ACCT cash") && s.includes("Wallet"));

    await a.sendKey("r");
    await a.waitFor((s) => s.includes("Rename account"));
    await a.sendText("cash Pocket-Cash");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("Pocket-Cash"));

    // Create a category (transport).
    await a.sendKey("c");
    await a.waitFor((s) => s.includes("Categories"));
    await a.sendKey("n");
    await a.waitFor((s) => s.includes("New category"));
    await a.sendText("transport Transport expense");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("CAT transport") && s.includes("[expense]"));

    // Rename category.
    await a.sendKey("r");
    await a.waitFor((s) => s.includes("Rename category"));
    await a.sendText("transport Travel");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("CAT transport") && s.includes("Travel"));

    // Make a transaction that uses the new category, then delete it.
    await a.sendKey("t"); // transactions tab
    await a.waitFor((s) => s.includes("[t] Transactions"));
    await submitExpense(a, "gas-1 checking 20 transport fuel");
    await a.waitFor((s) => s.includes("TX gas-1") && s.includes("cat=Travel"));
    await a.sendKey("d");
    await a.waitFor((s) => s.includes("Delete transaction"));
    await a.sendText("gas-1");
    await a.sendKey("Enter");
    await a.waitFor(
      (s) => !s.includes("TX gas-1") && s.includes("ACCT checking"),
      { label: "gas-1 deleted; balance restored" },
    );

    // Propagate everything.
    await syncerSync([masterRoot, aliceRoot]);
    // Verify on master by visiting each tab.
    await m.sendKey("a");
    await m.waitFor(
      (s) => s.includes("ACCT cash") && s.includes("Pocket-Cash"),
      { label: "master sees renamed account", timeoutMs: 15000 },
    );
    await m.sendKey("c");
    await m.waitFor(
      (s) => s.includes("CAT transport") && s.includes("Travel"),
      { label: "master sees renamed category", timeoutMs: 15000 },
    );
    await m.sendKey("t");
    await m.waitFor(
      (s) => !s.includes("TX gas-1"),
      { label: "gas-1 deletion propagated to master", timeoutMs: 15000 },
    );
  }, 45000);
});
