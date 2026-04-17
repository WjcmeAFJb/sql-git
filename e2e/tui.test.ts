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

/**
 * Seed master with schema + accounts + categories via the library directly.
 * E2E tests build up the cluster from this deterministic starting state so
 * auto-generated IDs from the TUI don't vary between runs.
 */
async function seedMaster(root: string): Promise<void> {
  const mod = await import("../src/index.ts");
  const { bankActions } = await import("../demo/actions.ts");
  const s = mod.Store.open({ root, peerId: "master", masterId: "master", actions: bankActions });
  try {
    s.submit("init_bank", {});
    s.submit("create_account", { id: "checking", name: "Checking", ts: "1970-01-01T00:00:00.000Z" });
    s.submit("create_account", { id: "savings", name: "Savings", ts: "1970-01-01T00:00:00.000Z" });
    s.submit("create_category", { id: "food", name: "Food", kind: "expense", ts: "1970-01-01T00:00:00.000Z" });
    s.submit("create_category", { id: "rent", name: "Rent", kind: "expense", ts: "1970-01-01T00:00:00.000Z" });
    s.submit("create_income", {
      id: "seed-chk",
      acc_to: "checking",
      amount: 100,
      category_id: null,
      memo: "initial",
      ts: "1970-01-01T00:00:00.000Z",
    });
    s.submit("create_income", {
      id: "seed-sav",
      acc_to: "savings",
      amount: 200,
      category_id: null,
      memo: "initial",
      ts: "1970-01-01T00:00:00.000Z",
    });
    await s.sync();
  } finally {
    s.close();
  }
}

// ─── wizard drivers ──────────────────────────────────────────────────────────

async function waitForField(t: Term, label: string): Promise<void> {
  await t.waitFor((s) => s.includes(`› ${label}`));
}
async function typeField(t: Term, value: string): Promise<void> {
  if (value.length > 0) await t.sendText(value);
  await t.sendKey("Enter");
}
async function pickOption(t: Term, optionIndex: number): Promise<void> {
  await t.sendKey(String(optionIndex));
}

async function newExpense(
  t: Term,
  opts: {
    amount: number;
    fromOption: number;
    categoryOption: number;
    memo?: string;
    id?: string;
  },
): Promise<void> {
  await t.sendKey("n");
  await t.waitFor((s) => s.includes("New transaction"));
  await t.sendKey("e");
  await waitForField(t, "Amount");
  await typeField(t, String(opts.amount));
  await waitForField(t, "From account");
  await pickOption(t, opts.fromOption);
  await waitForField(t, "Category");
  await pickOption(t, opts.categoryOption);
  await waitForField(t, "Memo");
  await typeField(t, opts.memo ?? "");
  await waitForField(t, "Tx id");
  await typeField(t, opts.id ?? "");
}
async function newTransfer(
  t: Term,
  opts: { amount: number; fromOption: number; toOption: number; memo?: string; id?: string },
): Promise<void> {
  await t.sendKey("n");
  await t.waitFor((s) => s.includes("New transaction"));
  await t.sendKey("x");
  await waitForField(t, "Amount");
  await typeField(t, String(opts.amount));
  await waitForField(t, "From");
  await pickOption(t, opts.fromOption);
  await waitForField(t, "To");
  await pickOption(t, opts.toOption);
  await waitForField(t, "Memo");
  await typeField(t, opts.memo ?? "");
  await waitForField(t, "Tx id");
  await typeField(t, opts.id ?? "");
}
async function editMemo(t: Term, opts: { txOption: number; memo: string }): Promise<void> {
  await t.sendKey("e");
  await t.waitFor((s) => s.includes("Edit transaction — pick field"));
  await t.sendKey("m");
  await waitForField(t, "Transaction");
  await pickOption(t, opts.txOption);
  await waitForField(t, "New memo");
  await typeField(t, opts.memo);
}
async function editCategory(
  t: Term,
  opts: { txOption: number; categoryOption: number },
): Promise<void> {
  await t.sendKey("e");
  await t.waitFor((s) => s.includes("Edit transaction — pick field"));
  await t.sendKey("c");
  await waitForField(t, "Transaction");
  await pickOption(t, opts.txOption);
  await waitForField(t, "Category");
  await pickOption(t, opts.categoryOption);
}

// ─────────────────────────────────────────────────────────────────────────────

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

    // alice: expense $60 from checking, category=food, id=alice-1
    await newExpense(a, {
      amount: 60,
      fromOption: 1, // checking
      categoryOption: 2, // index 1 = "— none —", 2 = food
      memo: "dinner",
      id: "alice-1",
    });
    await a.waitFor((s) => s.includes("TX alice-1") && s.includes("$60"));

    await syncerSync([masterRoot, aliceRoot]);
    await m.waitFor(
      (s) => s.includes("TX alice-1") && s.includes("[expense]") && s.includes("$40"),
      { timeoutMs: 15000 },
    );
    await syncerSync([masterRoot, aliceRoot]);
    await a.waitFor((s) => s.includes("TX alice-1") && s.includes("$40"), {
      timeoutMs: 15000,
    });
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

    await newExpense(a, {
      amount: 60,
      fromOption: 1,
      categoryOption: 1, // none
      id: "alice-1",
    });
    await newExpense(b, {
      amount: 50,
      fromOption: 1,
      categoryOption: 1,
      id: "bob-1",
    });
    await a.waitFor((s) => s.includes("TX alice-1"));
    await b.waitFor((s) => s.includes("TX bob-1"));

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) => s.includes("TX alice-1") && s.includes("ACCT checking") && s.includes("$40"),
      { timeoutMs: 15000 },
    );
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("CONFLICT") && s.includes("kind=error"), {
      timeoutMs: 15000,
    });
    await b.sendKey("d");
    await b.waitFor(
      (s) =>
        s.includes("ACCT checking") &&
        s.includes("$40") &&
        s.includes("TX alice-1") &&
        s.includes("pending (0)"),
      { timeoutMs: 15000 },
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

    await newExpense(a, { amount: 60, fromOption: 1, categoryOption: 1, id: "alice-1" });
    await newExpense(b, { amount: 50, fromOption: 1, categoryOption: 1, id: "bob-1" });

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) => s.includes("TX alice-1") && s.includes("ACCT checking") && s.includes("$40"),
      { timeoutMs: 15000 },
    );
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("CONFLICT") && s.includes("kind=error"), {
      timeoutMs: 15000,
    });

    // Retry: topup 20 from savings → checking (so 40 + 20 = 60 > 50).
    await b.sendKey("r");
    await b.waitFor((s) => s.includes("RETRY"));
    await b.sendText("20 savings checking topup");
    await b.sendKey("Enter");
    await b.waitFor(
      (s) =>
        s.includes("ACCT checking") &&
        s.includes("$10") &&
        s.includes("ACCT savings") &&
        s.includes("$180") &&
        s.includes("TX bob-1"),
      { timeoutMs: 15000 },
    );

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) =>
        s.includes("TX bob-1") &&
        s.includes("ACCT checking") &&
        s.includes("$10") &&
        s.includes("ACCT savings") &&
        s.includes("$180"),
      { timeoutMs: 15000 },
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

    await newExpense(a, {
      amount: 10,
      fromOption: 1,
      categoryOption: 1,
      id: "tx-shared",
    });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await a.waitFor((s) => s.includes("TX tx-shared") && s.includes("pending (0)"), {
      timeoutMs: 15000,
    });
    await b.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });

    // Which tx is "tx-shared" in the select ordering? Seed has seed-chk, seed-sav, then tx-shared.
    // Select list is last 20 txs; order is by ts. Seed ts="t0", tx-shared ts=nowTs() > "t0".
    // So tx-shared is LAST. seed-chk=1, seed-sav=2, tx-shared=3.
    const sharedIdx = 3;
    // Categories: [— none —, food, rent] → food at index 2.
    await editMemo(a, { txOption: sharedIdx, memo: "morning-latte" });
    await editCategory(b, { txOption: sharedIdx, categoryOption: 2 });
    await a.waitFor((s) => s.includes("morning-latte"));
    await b.waitFor((s) => s.includes("cat=Food"));

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) => s.includes("morning-latte") && s.includes("cat=Food"),
      { timeoutMs: 20000 },
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

    await newExpense(a, { amount: 10, fromOption: 1, categoryOption: 1, id: "tx-shared" });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await a.waitFor((s) => s.includes("pending (0)") && s.includes("TX tx-shared"), {
      timeoutMs: 15000,
    });

    const sharedIdx = 3;
    await editMemo(a, { txOption: sharedIdx, memo: "alice-memo" });
    await editMemo(b, { txOption: sharedIdx, memo: "bob-memo" });
    await a.waitFor((s) => s.includes("alice-memo"));
    await b.waitFor((s) => s.includes("bob-memo"));

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes("alice-memo"), { timeoutMs: 15000 });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("CONFLICT") && s.includes("kind=non_commutative"), {
      timeoutMs: 15000,
    });
    await b.sendKey("d");
    await b.waitFor(
      (s) => s.includes("alice-memo") && s.includes("pending (0)"),
      { timeoutMs: 15000 },
    );
  }, 60000);

  it("auto-init: a fresh master host gets schema on open; peer waits until sync delivers it", async () => {
    scene = new Scene();
    const masterRoot = scene.tmpDir("master");
    const aliceRoot = scene.tmpDir("alice");
    await createHost(masterRoot, "master");
    await createHost(aliceRoot, "master");
    // NO seedMaster. Master will auto-init on open.

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    await m.start(trackerCmd(masterRoot, "master", "--watch-debounce 100"));
    await a.start(trackerCmd(aliceRoot, "alice", "--watch-debounce 100"));

    // Master's Transactions tab shows empty state cleanly — no SQL error.
    await m.waitFor(
      (s) => s.includes("Transactions (0)") || s.includes("— none —"),
      { timeoutMs: 15000 },
    );
    // Alice, before any sync, sees the waiting banner (no schema yet).
    await a.waitFor((s) => s.includes("waiting for master"), { timeoutMs: 15000 });

    // syncer delivers master.jsonl (containing init_bank) → alice re-syncs and sees empty tables.
    await syncerSync([masterRoot, aliceRoot]);
    await a.waitFor(
      (s) => !s.includes("waiting for master") && s.includes("Transactions (0)"),
      { timeoutMs: 15000 },
    );
  }, 30000);
});
