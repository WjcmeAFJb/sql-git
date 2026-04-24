import {
  test,
  expect,
  pickSuggestedPeer,
  newAccount,
  newCategory,
  renameAccount,
  deleteAccount,
  newIncome,
  newExpense,
  openTab,
  readBalance,
} from "./helpers";

test.describe("accounts tab", () => {
  test.beforeEach(async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
  });

  test("empty state + new account + rename", async ({ page }) => {
    await openTab(page, "Accounts");
    await expect(
      page.getByText(/No accounts yet/),
    ).toBeVisible();

    await newAccount(page, "Checking");
    await expect(page.getByText(/Accounts\s*\(\s*1\s*\)/)).toBeVisible();
    // Per-row rename/delete icons are present.
    await expect(
      page.locator('main ul > li button[title="Rename"]'),
    ).toHaveCount(1);

    await renameAccount(page, "Checking", "Main");
    await expect
      .poll(async () =>
        page
          .locator('ul >> li >> span.font-medium:has-text("Main")')
          .first()
          .isVisible(),
      )
      .toBe(true);
    // No list row still labelled "Checking".
    await expect(
      page.locator('ul >> li >> span.font-medium:has-text("Checking")'),
    ).toHaveCount(0);
  });

  test("balance strip updates on income / expense", async ({ page }) => {
    await newAccount(page, "Checking");
    // Balance starts at 0.
    expect(await readBalance(page, "Checking")).toBe(0);
    await newCategory(page, "Salary", "income");

    await newIncome(page, { amount: 500, account: "Checking", category: "Salary" });
    await expect
      .poll(async () => readBalance(page, "Checking"))
      .toBe(500);
    await newExpense(page, { amount: 120, account: "Checking" });
    await expect
      .poll(async () => readBalance(page, "Checking"))
      .toBe(380);
  });

  test("delete account", async ({ page }) => {
    await newAccount(page, "Checking");
    await deleteAccount(page, "Checking");
    await expect(
      page.getByText(/No accounts yet/),
    ).toBeVisible();
  });

  test("account with transactions cannot be deleted", async ({ page }) => {
    await newAccount(page, "Checking");
    await newIncome(page, { amount: 100, account: "Checking" });
    // The delete click accepts the confirm prompt but the sql-git action
    // throws on the FK RESTRICT — the store surfaces the error in the
    // top-bar status alert. The account row stays in the list.
    await deleteAccount(page, "Checking");
    await expect(
      page.getByText(/FOREIGN KEY|constraint|RESTRICT/i).first(),
    ).toBeVisible();
    await expect(
      page.locator('ul >> li >> span.font-medium:has-text("Checking")'),
    ).toHaveCount(1);
  });
});
