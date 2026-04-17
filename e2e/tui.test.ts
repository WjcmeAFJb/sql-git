import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Scene, Term, tmuxAvailable } from "./tmux.ts";

const REPO = process.cwd();
const TSX = "./node_modules/.bin/tsx";

function demoCmd(root: string, peerId: string, masterId: string, extra = ""): string {
  return `${TSX} ${REPO}/demo/cli.tsx --root ${root} --peer ${peerId} --master ${masterId} ${extra}`;
}

function syncCmd(
  hosts: Array<{ peer: string; root: string }>,
  masterId: string,
  mode: "watch" | "one-shot" = "watch",
  extra = "",
): string {
  const hostArgs = hosts.map((h) => `--host ${h.peer}=${h.root}`).join(" ");
  return `${TSX} ${REPO}/demo/sync.ts ${mode} ${hostArgs} --master ${masterId} --debounce 100 -v ${extra}`;
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

describe.skipIf(!tmuxAvailable())("e2e: ink TUI + syncer", () => {
  let scene: Scene;

  afterEach(async () => {
    await scene.teardown();
  });

  it("happy path: alice submits a transfer, syncer propagates, master incorporates", async () => {
    scene = new Scene();
    const masterRoot = scene.tmpDir("master");
    const aliceRoot = scene.tmpDir("alice");
    mkdirSync(masterRoot, { recursive: true });
    mkdirSync(aliceRoot, { recursive: true });
    await seedMaster(masterRoot);

    const masterTerm = scene.spawn("master");
    await masterTerm.start(demoCmd(masterRoot, "master", "master", "--watch-debounce 100"));
    await masterTerm.waitFor((s) => s.includes("PEER=master") && s.includes("ACCT checking 100"));

    const syncer = scene.spawn("syncer");
    await syncer.start(
      syncCmd([{ peer: "master", root: masterRoot }, { peer: "alice", root: aliceRoot }], "master"),
    );

    const aliceTerm = scene.spawn("alice");
    await aliceTerm.start(demoCmd(aliceRoot, "alice", "master", "--watch-debounce 100"));
    await aliceTerm.waitFor((s) => s.includes("ACCT checking 100"), {
      label: "alice auto-catches-up via syncer",
    });

    // Submit a transfer on alice: t → form → "alice-1 checking external 60" → Enter.
    await aliceTerm.sendKey("t");
    await aliceTerm.waitFor((s) => s.includes("TRANSFER-FORM"));
    await aliceTerm.sendText("alice-1 checking external 60");
    await aliceTerm.sendKey("Enter");

    await aliceTerm.waitFor((s) => s.includes("submitted alice-1"), {
      label: "alice submitted locally",
    });

    await masterTerm.waitFor((s) => s.includes("TX alice-1") && s.includes("ACCT checking 40"), {
      label: "master incorporated alice-1 via syncer+watch",
      timeoutMs: 15000,
    });
    await aliceTerm.waitFor((s) => s.includes("TX alice-1") && s.includes("ACCT checking 40"), {
      label: "alice sees master's incorporation",
      timeoutMs: 15000,
    });
  }, 30000);

  it("overdraft: bob drops the conflicting transfer", async () => {
    scene = new Scene();
    const masterRoot = scene.tmpDir("master");
    const aliceRoot = scene.tmpDir("alice");
    const bobRoot = scene.tmpDir("bob");
    await seedMaster(masterRoot);

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    const b = scene.spawn("bob");
    const sy = scene.spawn("syncer");

    await m.start(demoCmd(masterRoot, "master", "master", "--watch-debounce 150"));
    await sy.start(
      syncCmd(
        [
          { peer: "master", root: masterRoot },
          { peer: "alice", root: aliceRoot },
          { peer: "bob", root: bobRoot },
        ],
        "master",
      ),
    );
    await a.start(demoCmd(aliceRoot, "alice", "master", "--watch-debounce 150"));
    await b.start(demoCmd(bobRoot, "bob", "master", "--watch-debounce 150"));
    await a.waitFor((s) => s.includes("ACCT checking 100"), { label: "alice caught up" });
    await b.waitFor((s) => s.includes("ACCT checking 100"), { label: "bob caught up" });

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

    // Syncer + watchers auto-sync: master picks up alice, bob conflicts.
    await m.waitFor((s) => s.includes("TX alice-1") && s.includes("ACCT checking 40"), {
      label: "master applied alice",
      timeoutMs: 15000,
    });

    // Bob's auto-sync (after master.jsonl arrives) enters conflict mode on his own action.
    await b.waitFor((s) => s.includes("CONFLICT kind=error"), {
      label: "bob's auto-sync entered conflict mode",
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
    await seedMaster(masterRoot);

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    const b = scene.spawn("bob");
    const sy = scene.spawn("syncer");
    await m.start(demoCmd(masterRoot, "master", "master", "--watch-debounce 150"));
    await sy.start(
      syncCmd(
        [
          { peer: "master", root: masterRoot },
          { peer: "alice", root: aliceRoot },
          { peer: "bob", root: bobRoot },
        ],
        "master",
      ),
    );
    await a.start(demoCmd(aliceRoot, "alice", "master", "--watch-debounce 150"));
    await b.start(demoCmd(bobRoot, "bob", "master", "--watch-debounce 150"));

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

    // Wait for master to incorporate alice.
    await m.waitFor((s) => s.includes("TX alice-1") && s.includes("ACCT checking 40"), {
      label: "master applied alice",
      timeoutMs: 15000,
    });
    // Bob's auto-sync enters conflict mode on his own action.
    await b.waitFor((s) => s.includes("CONFLICT kind=error"), {
      label: "bob in conflict",
      timeoutMs: 15000,
    });
    // Bob retries: 'r' → prepend a topup → Enter → resolver returns "retry"
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
      { label: "bob's local state reflects topup + retry", timeoutMs: 15000 },
    );

    // Watchers propagate: master incorporates topup + retried bob-1.
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
    await seedMaster(masterRoot);

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    const b = scene.spawn("bob");
    const sy = scene.spawn("syncer");
    await m.start(demoCmd(masterRoot, "master", "master", "--watch-debounce 150"));
    await sy.start(
      syncCmd(
        [
          { peer: "master", root: masterRoot },
          { peer: "alice", root: aliceRoot },
          { peer: "bob", root: bobRoot },
        ],
        "master",
      ),
    );
    await a.start(demoCmd(aliceRoot, "alice", "master", "--watch-debounce 150"));
    await b.start(demoCmd(bobRoot, "bob", "master", "--watch-debounce 150"));
    await a.waitFor((s) => s.includes("ACCT checking 100"));
    await b.waitFor((s) => s.includes("ACCT checking 100"));

    // Alice creates a transfer; wait for it to converge on all three.
    await a.sendKey("t");
    await a.waitFor((s) => s.includes("TRANSFER-FORM"));
    await a.sendText("tx-shared checking external 10");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("submitted tx-shared"));
    await m.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await a.waitFor((s) => s.includes("TX tx-shared") && s.includes("-- pending (0) --"), {
      timeoutMs: 15000,
    });
    await b.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });

    // Alice edits memo, bob edits category — different fields → commute.
    await a.sendKey("m");
    await a.waitFor((s) => s.includes("MEMO-FORM"));
    await a.sendText("tx-shared groceries and snacks");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("memo-updated tx-shared"));

    await b.sendKey("c");
    await b.waitFor((s) => s.includes("CATEGORY-FORM"));
    await b.sendText("tx-shared food");
    await b.sendKey("Enter");
    await b.waitFor((s) => s.includes("category-updated tx-shared"));

    // Watchers propagate; commutativity check passes; both land on master.
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
    await seedMaster(masterRoot);

    const m = scene.spawn("master");
    const a = scene.spawn("alice");
    const b = scene.spawn("bob");
    const sy = scene.spawn("syncer");
    await m.start(demoCmd(masterRoot, "master", "master", "--watch-debounce 150"));
    await sy.start(
      syncCmd(
        [
          { peer: "master", root: masterRoot },
          { peer: "alice", root: aliceRoot },
          { peer: "bob", root: bobRoot },
        ],
        "master",
      ),
    );
    await a.start(demoCmd(aliceRoot, "alice", "master", "--watch-debounce 150"));
    await b.start(demoCmd(bobRoot, "bob", "master", "--watch-debounce 150"));
    await a.waitFor((s) => s.includes("ACCT checking 100"));
    await b.waitFor((s) => s.includes("ACCT checking 100"));

    // Seed a shared transaction; wait for convergence.
    await a.sendKey("t");
    await a.waitFor((s) => s.includes("TRANSFER-FORM"));
    await a.sendText("tx-shared checking external 10");
    await a.sendKey("Enter");
    await a.waitFor((s) => s.includes("submitted"));
    await m.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await b.waitFor((s) => s.includes("TX tx-shared"), { timeoutMs: 15000 });
    await a.waitFor((s) => s.includes("-- pending (0) --") && s.includes("TX tx-shared"), {
      timeoutMs: 15000,
    });

    // Both edit the same memo to different values. (Status flickers through
    // sync, so check the row rendering instead of the transient status line.)
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

    // Master picks alice first (alphabetical); bob then conflicts.
    await m.waitFor((s) => s.includes(`memo=${JSON.stringify("alice-memo")}`), {
      label: "master applied alice's memo",
      timeoutMs: 15000,
    });
    await b.waitFor((s) => s.includes("CONFLICT kind=non_commutative"), {
      label: "bob in non-commutative conflict",
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
