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
  const s = await mod.Store.open({ root, peerId: "master", masterId: "master", actions: bankActions });
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
  opts: { amount: number; fromOption: number; categoryOption: number; memo?: string },
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
}
async function newTransfer(
  t: Term,
  opts: { amount: number; fromOption: number; toOption: number; memo?: string },
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
}
/**
 * Edit transaction walks amount → memo → category in one wizard. Blank Enter
 * on text fields, pick [1] "— keep current —" on the category select, means
 * "don't change this field". `categoryOption` uses the option numbers:
 * 1 = keep current, 2 = — none —, 3+ = actual categories (created-at order).
 */
async function editTx(
  t: Term,
  opts: { txOption: number; newAmount?: string; newMemo?: string; categoryOption?: number },
): Promise<void> {
  await t.sendKey("e");
  await t.waitFor((s) => s.includes("Edit transaction — pick one"));
  await waitForField(t, "Transaction");
  await pickOption(t, opts.txOption);
  await waitForField(t, "Amount");
  if (opts.newAmount !== undefined) await t.sendText(opts.newAmount);
  await t.sendKey("Enter");
  await waitForField(t, "Memo");
  if (opts.newMemo !== undefined) await t.sendText(opts.newMemo);
  await t.sendKey("Enter");
  await waitForField(t, "Category");
  await pickOption(t, opts.categoryOption ?? 1);
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

    // alice: expense $60 from checking, category=food, memo=dinner.
    await newExpense(a, { amount: 60, fromOption: 1, categoryOption: 2, memo: "dinner" });
    await a.waitFor((s) => s.includes('memo="dinner"') && s.includes("[expense]"));

    await syncerSync([masterRoot, aliceRoot]);
    await m.waitFor(
      (s) => s.includes('memo="dinner"') && s.includes("[expense]") && s.includes("$40"),
      { timeoutMs: 15000 },
    );
    await syncerSync([masterRoot, aliceRoot]);
    await a.waitFor((s) => s.includes('memo="dinner"') && s.includes("$40"), {
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

    await newExpense(a, { amount: 60, fromOption: 1, categoryOption: 1, memo: "alice-spend" });
    await newExpense(b, { amount: 50, fromOption: 1, categoryOption: 1, memo: "bob-spend" });
    await a.waitFor((s) => s.includes('memo="alice-spend"'));
    await b.waitFor((s) => s.includes('memo="bob-spend"'));

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) => s.includes('memo="alice-spend"') && s.includes("$40"),
      { timeoutMs: 15000 },
    );
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("CONFLICT") && s.includes("kind=error"), {
      timeoutMs: 15000,
    });
    await b.sendKey("d");
    await b.waitFor(
      (s) =>
        s.includes("$40") &&
        s.includes('memo="alice-spend"') &&
        !s.includes('memo="bob-spend"') &&
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

    await newExpense(a, { amount: 60, fromOption: 1, categoryOption: 1, memo: "alice-spend" });
    await newExpense(b, { amount: 50, fromOption: 1, categoryOption: 1, memo: "bob-spend" });

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) => s.includes('memo="alice-spend"') && s.includes("$40"),
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
        s.includes("$10") &&
        s.includes("$180") &&
        s.includes('memo="bob-spend"'),
      { timeoutMs: 15000 },
    );

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) =>
        s.includes('memo="bob-spend"') &&
        s.includes("$10") &&
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
      memo: "shared",
    });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes('memo="shared"'), { timeoutMs: 15000 });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await a.waitFor((s) => s.includes('memo="shared"') && s.includes("pending (0)"), {
      timeoutMs: 15000,
    });
    await b.waitFor((s) => s.includes('memo="shared"'), { timeoutMs: 15000 });

    // Tx ordering by ts: seeded rows first (ts=1970), then alice's new expense
    // at position 3. Alice's seed in seedMaster is at indices 1 (salary-1) and
    // 2 (seed-sav); the shared expense is 3.
    const sharedIdx = 3;
    // Categories available in edit: [1] keep current, [2] — none —, [3] Food,
    // [4] Rent.
    // Alice edits memo only; keeps amount + category.
    await editTx(a, { txOption: sharedIdx, newMemo: "morning-latte", categoryOption: 1 });
    // Bob edits category only; keeps amount + memo.
    await editTx(b, { txOption: sharedIdx, categoryOption: 3 });
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

    await newExpense(a, {
      amount: 10,
      fromOption: 1,
      categoryOption: 1,
      memo: "shared",
    });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes('memo="shared"'), { timeoutMs: 15000 });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes('memo="shared"'), { timeoutMs: 15000 });
    await a.waitFor((s) => s.includes("pending (0)") && s.includes('memo="shared"'), {
      timeoutMs: 15000,
    });

    const sharedIdx = 3;
    await editTx(a, { txOption: sharedIdx, newMemo: "alice-memo" });
    await editTx(b, { txOption: sharedIdx, newMemo: "bob-memo" });
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
