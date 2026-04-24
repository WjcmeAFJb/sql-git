import {
  test,
  expect,
  pickSuggestedPeer,
  pickCustomPeer,
  newAccount,
  openFileSync,
  runFileSync,
  closeFileSync,
  waitSeedDone,
  waitOpened,
  expectGate,
  clearStorage,
} from "./helpers";

test.describe("file-sync menu", () => {
  test("shows only current peer when no other dir exists", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await openFileSync(page);
    await expect(page.getByText("Peer directories")).toBeVisible();
    // One card; labelled "this tab".
    await expect(page.getByText("this tab").first()).toBeVisible();
    // With only alice's dir known, the plan can't be formed — the Sync
    // button in the dialog is disabled.
    await expect(
      page.locator('div[role=dialog] button:has-text("Sync")'),
    ).toBeDisabled();
    await closeFileSync(page);
  });

  test("master → peer: alice in one tab, bob in another, file-sync pulls schema", async ({
    page,
    context,
  }) => {
    // Alice seeds.
    await pickSuggestedPeer(page, "alice", { seed: true });
    await waitSeedDone(page);

    // Open a *second* tab as bob — the existing smoke test demonstrates
    // this is the reliable path (in-tab Switch + OPFS + stale in-memory
    // store races otherwise). Both tabs share the OPFS origin.
    const bobTab = await context.newPage();
    await bobTab.goto("/");
    await expect(bobTab.getByText("Choose a peer for this tab")).toBeVisible();
    await bobTab.locator("#custom-peer").fill("bob");
    await bobTab.locator('button:has-text("Open")').click();
    // Wait for bob's initial sync to settle before kicking off file-sync —
    // otherwise the new sync call dedupes against the in-flight one.
    await expect(bobTab.getByText(/no schema on disk yet/i)).toBeVisible();
    await expect
      .poll(async () => /mode\s*IDLE/i.test(await bobTab.innerText("body")), {
        timeout: 30_000,
      })
      .toBe(true);

    // File-sync from bob's tab.
    await bobTab
      .getByRole("button", { name: "File-sync", exact: true })
      .click();
    await expect(bobTab.getByText("File-sync operations")).toBeVisible();
    await expect(bobTab.getByText("Transfer plan")).toBeVisible();
    await bobTab
      .locator('div[role=dialog] button:has-text("Sync")')
      .last()
      .click();
    await expect(bobTab.getByText(/transferred/)).toBeVisible({ timeout: 30_000 });
    await bobTab
      .locator('div[role=dialog] button:has-text("Close")')
      .first()
      .click();

    // Bob's store re-syncs off the freshly-staged master log + snapshot.
    await expect(bobTab.getByText(/Transactions\s*\(\s*15\s*\)/)).toBeVisible({
      timeout: 60_000,
    });
    await expect(bobTab.getByText(/no schema on disk yet/i)).not.toBeVisible();
  });

  test("bidirectional sync marks owned files as skipped by ownership rules", async ({
    page,
  }) => {
    // Set up alice + bob so both dirs exist.
    await pickSuggestedPeer(page, "alice");
    await newAccount(page, "Checking");
    await page.locator('button:has-text("Switch")').click();
    await pickCustomPeer(page, "bob");
    // Initial sync bob ↔ alice copies alice's files to bob.
    await openFileSync(page);
    await runFileSync(page);
    await closeFileSync(page);

    // Now ask for a second sync — snapshot.db on bob shouldn't propagate
    // back to alice. Since bob has newer snapshot.db (due to mtime bump
    // from the last copy), newest-wins would pick bob; the ownership rule
    // skips it.
    await openFileSync(page);
    // The plan UI might now say "in sync" or show only legitimate transfers.
    // Either way, there should be NO aToB or bToA row that mentions
    // `/master/snapshot.db` being written back onto alice.
    const planText = await page
      .locator('div[role=dialog]')
      .innerText();
    // Ownership-rules section either renders or the plan is fully in sync.
    if (/skipped by ownership rules/.test(planText)) {
      expect(planText).toMatch(/alice owns snapshot\.db|cache copies never propagate back/);
    } else {
      expect(planText).toMatch(/in sync|nothing to transfer/);
    }
    await closeFileSync(page);
  });
});
