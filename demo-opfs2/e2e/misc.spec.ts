import {
  test,
  expect,
  pickSuggestedPeer,
  newAccount,
  openTab,
} from "./helpers";

test.describe("misc UI", () => {
  test("tab switching navigates between the three tabs", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");

    await openTab(page, "Accounts");
    await expect(page.getByRole("tabpanel", { name: "Accounts" })).toBeVisible();

    await openTab(page, "Categories");
    await expect(
      page.getByRole("tabpanel", { name: "Categories" }),
    ).toBeVisible();

    await openTab(page, "Transactions");
    await expect(
      page.getByRole("tabpanel", { name: "Transactions" }),
    ).toBeVisible();
  });

  test("Switch peer clears state + re-shows the gate", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await newAccount(page, "Checking");
    await expect(page.locator("text=Checking").first()).toBeVisible();
    await page.locator('button:has-text("Switch")').click();
    await expect(page.getByText("Choose a peer for this tab")).toBeVisible();
    // Existing peer appears as "exists" + "master".
    const alicePill = page.locator('button:has-text("alice")').first();
    await expect(alicePill.getByText("exists")).toBeVisible();
    // Re-select alice; accounts survive via OPFS.
    await alicePill.click();
    await expect(page.locator("text=Checking").first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test("Top-bar Sync button runs store.sync", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await newAccount(page, "Checking");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    // Status bar shows a `synced applied=…` message.
    await expect(page.getByText(/synced applied=/)).toBeVisible({
      timeout: 30_000,
    });
  });
});
