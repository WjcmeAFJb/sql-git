import {
  test,
  expect,
  pickSuggestedPeer,
  newAccount,
  newCategory,
  newIncome,
  newExpense,
  waitSeedDone,
} from "./helpers";

test.describe("cross-tab replication", () => {
  test("bob's action replicates to alice via file-sync + auto-resync", async ({
    page,
    context,
  }) => {
    // Alice seeded.
    await pickSuggestedPeer(page, "alice", { seed: true });
    await waitSeedDone(page);

    // Bob joins via a second tab, file-syncs to fetch master's state.
    const bob = await context.newPage();
    await bob.goto("/");
    await expect(bob.getByText("Choose a peer for this tab")).toBeVisible();
    await bob.locator("#custom-peer").fill("bob");
    await bob.locator('button:has-text("Open")').click();
    await expect(bob.getByText(/no schema on disk yet/i)).toBeVisible();
    await bob
      .getByRole("button", { name: "File-sync", exact: true })
      .click();
    await bob.locator('div[role=dialog] button:has-text("Sync")').last().click();
    await expect(bob.getByText(/transferred/)).toBeVisible({ timeout: 30_000 });
    await bob.locator('div[role=dialog] button:has-text("Close")').first().click();
    await expect(bob.getByText(/Transactions\s*\(\s*15\s*\)/)).toBeVisible({
      timeout: 30_000,
    });

    // Bob submits a new income (pending on bob's peer log until file-sync).
    await newIncome(bob, {
      amount: 999,
      account: "Checking",
      category: "Salary",
      memo: "from-bob",
    });
    // 1 pending on bob.
    await expect(bob.getByText(/1\s*pending/i)).toBeVisible();

    // Alice hasn't seen it yet (no file-sync has pushed it).
    await expect(page.locator('text=from-bob')).not.toBeVisible();

    // Bob file-syncs again — pushes bob.jsonl to alice's dir; alice auto-
    // syncs via the cross-tab BroadcastChannel watcher.
    await bob.getByRole("button", { name: "File-sync", exact: true }).click();
    await bob.locator('div[role=dialog] button:has-text("Sync")').last().click();
    await expect(bob.getByText(/transferred/)).toBeVisible({ timeout: 30_000 });
    await bob.locator('div[role=dialog] button:has-text("Close")').first().click();

    // Alice's balance and transactions reflect bob's income after auto-sync.
    await expect(page.getByText("from-bob").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Transactions\s*\(\s*16\s*\)/)).toBeVisible({
      timeout: 30_000,
    });
  });

  test("alice's fresh action replicates to bob on the next file-sync", async ({
    page,
    context,
  }) => {
    await pickSuggestedPeer(page, "alice");
    await newAccount(page, "Checking");

    const bob = await context.newPage();
    await bob.goto("/");
    await expect(bob.getByText("Choose a peer for this tab")).toBeVisible();
    await bob.locator("#custom-peer").fill("bob");
    await bob.locator('button:has-text("Open")').click();
    await bob.getByRole("button", { name: "File-sync", exact: true }).click();
    await bob.locator('div[role=dialog] button:has-text("Sync")').last().click();
    await expect(bob.getByText(/transferred/)).toBeVisible({ timeout: 30_000 });
    await bob.locator('div[role=dialog] button:has-text("Close")').first().click();
    await expect(bob.getByText("Checking").first()).toBeVisible({
      timeout: 30_000,
    });

    // Alice adds a new category after bob already synced.
    await newCategory(page, "AfterBob", "expense");

    // Bob file-syncs; should see the new category.
    await bob.getByRole("button", { name: "File-sync", exact: true }).click();
    await bob.locator('div[role=dialog] button:has-text("Sync")').last().click();
    await expect(bob.getByText(/transferred/)).toBeVisible({ timeout: 30_000 });
    await bob.locator('div[role=dialog] button:has-text("Close")').first().click();
    await expect(bob.getByText("AfterBob").first()).toBeVisible({
      timeout: 30_000,
    });
  });
});
