import {
  test,
  expect,
  pickSuggestedPeer,
  pickCustomPeer,
  waitSeedDone,
} from "./helpers";

test.describe("peer gate", () => {
  test("renders dialog with suggestions and seed option", async ({ page }) => {
    await expect(page.getByText("Choose a peer for this tab")).toBeVisible();
    // Suggestions for the default set.
    for (const id of ["alice", "bob", "charlie"]) {
      await expect(
        page.locator(`button:has-text("${id}")`).first(),
      ).toBeVisible();
    }
    // Alice has the "master" badge.
    await expect(
      page
        .locator('button:has-text("alice")')
        .first()
        .locator("text=master"),
    ).toBeVisible();
    // Custom input + Open button.
    await expect(page.locator("#custom-peer")).toBeVisible();
    await expect(page.locator('button:has-text("Open")')).toBeVisible();
    // Seed checkbox.
    await expect(page.getByText("Seed with sample data")).toBeVisible();
    await expect(page.locator('input[type=checkbox]')).not.toBeChecked();
  });

  test("rejects empty custom name", async ({ page }) => {
    await page.locator('button:has-text("Open")').click();
    await expect(page.getByText(/can't be empty/)).toBeVisible();
    // Still on the gate.
    await expect(page.getByText("Choose a peer for this tab")).toBeVisible();
  });

  test("rejects custom name with invalid characters", async ({ page }) => {
    await page.locator("#custom-peer").fill("Alice!");
    await page.locator('button:has-text("Open")').click();
    await expect(page.getByText(/lowercase letters\/digits/)).toBeVisible();
    await expect(page.getByText("Choose a peer for this tab")).toBeVisible();
  });

  test("clicking alice opens as master (no seed)", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await expect(page.getByText(/alice\s*\(master\)/).first()).toBeVisible();
    await expect(page.getByText("across 0 accounts")).toBeVisible();
    // No sample data should exist (0 transactions in the tab header).
    await expect(page.getByText(/Transactions\s*\(\s*0\s*\)/)).toBeVisible();
  });

  test("custom name joins as a peer", async ({ page }) => {
    await pickCustomPeer(page, "dave");
    // The top-bar peer badge + the footer hint both show the peer id.
    await expect(page.getByText("dave", { exact: true }).first()).toBeVisible();
    // dave is not master, so she sees the schema-waiting alert.
    await expect(page.getByText(/no schema on disk yet/i)).toBeVisible();
  });

  test("seed checkbox populates the store on open", async ({ page }) => {
    await pickSuggestedPeer(page, "alice", { seed: true });
    await waitSeedDone(page);
    // Balance strip surfaces each account once.
    await expect(page.locator("text=/^\\s*balances:/").first()).toBeVisible();
    // Category breakdown is a canonical single-occurrence UI element.
    await expect(
      page.getByText("Per-category breakdown").first(),
    ).toBeVisible();
    // Salary appears as a row in the breakdown with 2 income txs.
    await expect(page.getByText(/Salary[\s\S]*2 txs/)).toBeVisible();
    await expect(page.getByText(/Transactions\s*\(\s*15\s*\)/)).toBeVisible();
  });

  test("existing peers are surfaced as 'exists' on reopen", async ({ page }) => {
    // Create alice first.
    await pickSuggestedPeer(page, "alice");
    // Switch back to the gate.
    await page.locator('button:has-text("Switch")').click();
    await expect(page.getByText("Choose a peer for this tab")).toBeVisible();
    // alice's pill should now carry both the master + exists badges.
    const alicePill = page.locator('button:has-text("alice")').first();
    await expect(alicePill.getByText("master")).toBeVisible();
    await expect(alicePill.getByText("exists")).toBeVisible();
  });
});
