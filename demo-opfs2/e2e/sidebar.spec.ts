import {
  test,
  expect,
  pickSuggestedPeer,
  newAccount,
} from "./helpers";

test.describe("history sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
  });

  test("Actions tab lists master log newest-first", async ({ page }) => {
    await expect(page.getByRole("tab", { name: /Actions/ })).toBeVisible();
    // init_bank is the only action at this point.
    await expect(page.getByText("init_bank").first()).toBeVisible();
    await newAccount(page, "Checking");
    await newAccount(page, "Savings");
    // Most recent action (create_account for Savings) is on top.
    const firstRow = page
      .getByRole("tabpanel", { name: /Actions/ })
      .locator("li")
      .first();
    await expect(firstRow.getByText("create_account")).toBeVisible();
    // Still has the init_bank row at the bottom.
    await expect(
      page.getByRole("tabpanel", { name: /Actions/ }).getByText("init_bank"),
    ).toBeVisible();
  });

  test("Events tab shows watch events for local writes", async ({ page }) => {
    await page.getByRole("tab", { name: /Events/ }).click();
    // Master's auto-bootstrap + initial sync already generate a handful
    // of local `write` events for the peer log on first open.
    const eventsPanel = page.getByRole("tabpanel", { name: /Events/ });
    await expect(eventsPanel.getByText("local").first()).toBeVisible();
    await expect(eventsPanel.getByText("write").first()).toBeVisible();
    // A new submit tacks on another event.
    await newAccount(page, "Checking");
    await page.getByRole("tab", { name: /Events/ }).click();
    // The newest event should be a local write to the peer log.
    const firstRow = eventsPanel.locator("li").first();
    await expect(firstRow.getByText("local")).toBeVisible();
  });
});
