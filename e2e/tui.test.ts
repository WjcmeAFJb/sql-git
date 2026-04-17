import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Scene, tmuxAvailable } from "./tmux.ts";

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
    s.submit("open_account", { id: "checking", initial: 100 });
    s.submit("open_account", { id: "savings", initial: 200 });
    s.submit("open_account", { id: "external", initial: 0 });
    await s.sync();
  } finally {
    s.close();
  }
}

describe.skipIf(!tmuxAvailable())("e2e: tracker TUI + manual syncer sync", () => {
  let scene: Scene;

  afterEach(async () => {
    await scene.teardown();
  });

  it("happy path: alice submits a transfer, syncer sync propagates, master incorporates", async () => {
    scene = new Scene();
    const masterRoot = scene.tmpDir("master");
    const aliceRoot = scene.tmpDir("alice");
    await createHost(masterRoot, "master");
    await createHost(aliceRoot, "master");
    await seedMaster(masterRoot);

    // Push seeded master state to alice first so her initial open sees it.
    await syncerSync([masterRoot, aliceRoot]);

    const masterTerm = scene.spawn("master");
    await masterTerm.start(trackerCmd(masterRoot, "master", "--watch-debounce 100"));
    await masterTerm.waitFor((s) => s.includes("PEER=master") && s.includes("ACCT checking 100"));

    const aliceTerm = scene.spawn("alice");
    await aliceTerm.start(trackerCmd(aliceRoot, "alice", "--watch-debounce 100"));
    await aliceTerm.waitFor((s) => s.includes("ACCT checking 100"));

    // Alice submits a transfer locally (offline — master has no idea yet).
    await aliceTerm.sendKey("t");
    await aliceTerm.waitFor((s) => s.includes("TRANSFER-FORM"));
    await aliceTerm.sendText("alice-1 checking external 60");
    await aliceTerm.sendKey("Enter");
    await aliceTerm.waitFor((s) => s.includes("submitted alice-1"));

    // Manual sync: "Syncthing delivers". The tracker's debounced watcher then re-syncs.
    await syncerSync([masterRoot, aliceRoot]);

    await masterTerm.waitFor(
      (s) => s.includes("TX alice-1") && s.includes("ACCT checking 40"),
      { label: "master incorporated alice-1 after syncer sync", timeoutMs: 15000 },
    );

    // Bounce master's state back to alice so she sees the incorporation.
    await syncerSync([masterRoot, aliceRoot]);
    await aliceTerm.waitFor(
      (s) => s.includes("TX alice-1") && s.includes("ACCT checking 40"),
      { label: "alice caught up with master", timeoutMs: 15000 },
    );
  }, 30000);

  it("overdraft: bob drops the conflicting transfer", async () => {
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
    await a.waitFor((s) => s.includes("ACCT checking 100"));
    await b.waitFor((s) => s.includes("ACCT checking 100"));

    // Both submit competing transfers — individually fine, together overdraft.
    await a.sendKey("t");
    await a.waitFor((s) => s.includes("TRANSFER-FORM"));
    await a.sendText("alice-1 checking external 60");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("submitted alice-1"));
    await b.sendKey("t");
    await b.waitFor((s) => s.includes("TRANSFER-FORM"));
    await b.sendText("bob-1 checking external 50");
    await b.sendKey("Enter");
    await b.waitFor((s) => s.includes("submitted bob-1"));

    // Manual sync: alice's & bob's logs reach master; master's watcher triggers
    // peer-sync which runs as master-side incorporation (alphabetical → alice wins,
    // bob skipped).
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes("TX alice-1") && s.includes("ACCT checking 40"), {
      label: "master applied alice",
      timeoutMs: 15000,
    });

    // Master's updated log bounces back to bob; bob's watcher re-syncs, hits conflict.
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("CONFLICT kind=error"), {
      label: "bob's rebase hit the overdraft conflict",
      timeoutMs: 15000,
    });
    await b.sendKey("d");
    await b.waitFor(
      (s) =>
        s.includes("ACCT checking 40") &&
        s.includes("TX alice-1") &&
        s.includes("-- pending (0) --"),
      { label: "bob converged after dropping", timeoutMs: 15000 },
    );
    expect(await m.screen()).toMatch(/ACCT checking 40/);
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
    await a.waitFor((s) => s.includes("ACCT checking 100"));
    await b.waitFor((s) => s.includes("ACCT checking 100"));

    await a.sendKey("t");
    await a.waitFor((s) => s.includes("TRANSFER-FORM"));
    await a.sendText("alice-1 checking external 60");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("submitted alice-1"));
    await b.sendKey("t");
    await b.waitFor((s) => s.includes("TRANSFER-FORM"));
    await b.sendText("bob-1 checking external 50");
    await b.sendKey("Enter");
    await b.waitFor((s) => s.includes("submitted bob-1"));

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes("TX alice-1") && s.includes("ACCT checking 40"), {
      timeoutMs: 15000,
    });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("CONFLICT kind=error"), { timeoutMs: 15000 });

    // Retry with a topup from savings.
    await b.sendKey("r");
    await b.waitFor((s) => s.includes("RETRY-FORM"));
    await b.sendText("bob-topup savings checking 20");
    await b.sendKey("Enter");
    await b.waitFor(
      (s) =>
        s.includes("ACCT checking 10") &&
        s.includes("ACCT savings 180") &&
        s.includes("TX bob-topup") &&
        s.includes("TX bob-1"),
      { label: "bob's local state after topup + retry", timeoutMs: 15000 },
    );

    // Final sync round: master picks up bob's two new entries.
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) =>
        s.includes("TX bob-topup") &&
        s.includes("TX bob-1") &&
        s.includes("ACCT checking 10") &&
        s.includes("ACCT savings 180") &&
        s.includes("ACCT external 110"),
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
    await a.waitFor((s) => s.includes("ACCT checking 100"));
    await b.waitFor((s) => s.includes("ACCT checking 100"));

    // Seed a shared transaction everyone sees.
    await a.sendKey("t");
    await a.waitFor((s) => s.includes("TRANSFER-FORM"));
    await a.sendText("tx-shared checking external 10");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("submitted tx-shared"));
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await a.waitFor((s) => s.includes("TX tx-shared") && s.includes("-- pending (0) --"), {
      timeoutMs: 15000,
    });
    await b.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });

    // Alice edits memo, bob edits category — different fields → commute.
    await a.sendKey("m");
    await a.waitFor((s) => s.includes("MEMO-FORM"));
    await a.sendText("tx-shared groceries and snacks");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes(`memo=${JSON.stringify("groceries and snacks")}`));

    await b.sendKey("c");
    await b.waitFor((s) => s.includes("CATEGORY-FORM"));
    await b.sendText("tx-shared food");
    await b.sendKey("Enter");
    await b.waitFor((s) => s.includes("cat=food"));

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor(
      (s) =>
        s.includes(`memo=${JSON.stringify("groceries and snacks")}`) &&
        s.includes("cat=food"),
      { label: "master incorporated both commuting edits", timeoutMs: 20000 },
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
    await a.waitFor((s) => s.includes("ACCT checking 100"));
    await b.waitFor((s) => s.includes("ACCT checking 100"));

    await a.sendKey("t");
    await a.waitFor((s) => s.includes("TRANSFER-FORM"));
    await a.sendText("tx-shared checking external 10");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("submitted"));
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await a.waitFor((s) => s.includes("-- pending (0) --") && s.includes("TX tx-shared"), {
      timeoutMs: 15000,
    });

    // Both edit the same memo to different values.
    await a.sendKey("m");
    await a.waitFor((s) => s.includes("MEMO-FORM"));
    await a.sendText("tx-shared alice-memo");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes(`memo=${JSON.stringify("alice-memo")}`));
    await b.sendKey("m");
    await b.waitFor((s) => s.includes("MEMO-FORM"));
    await b.sendText("tx-shared bob-memo");
    await b.sendKey("Enter");
    await b.waitFor((s) => s.includes(`memo=${JSON.stringify("bob-memo")}`));

    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await m.waitFor((s) => s.includes(`memo=${JSON.stringify("alice-memo")}`), {
      label: "master picked alice's memo",
      timeoutMs: 15000,
    });
    await syncerSync([masterRoot, aliceRoot, bobRoot]);
    await b.waitFor((s) => s.includes("CONFLICT kind=non_commutative"), {
      label: "bob's rebase hit non-commutative",
      timeoutMs: 15000,
    });
    await b.sendKey("d");
    await b.waitFor(
      (s) =>
        s.includes(`memo=${JSON.stringify("alice-memo")}`) &&
        s.includes("-- pending (0) --"),
      { label: "bob converged to alice's memo", timeoutMs: 15000 },
    );
  }, 60000);
});
