import {
  test,
  expect,
  pickSuggestedPeer,
  newAccount,
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
    // Rename and Delete are disabled when there are no accounts.
    await expect(page.locator('button:has-text("Rename")')).toBeDisabled();
    await expect(page.locator('button:has-text("Delete")')).toBeDisabled();

    await newAccount(page, "Checking");
    await expect(page.getByText(/Accounts\s*\(\s*1\s*\)/)).toBeVisible();
    await expect(page.locator('button:has-text("Rename")')).toBeEnabled();

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
    // Need a category for income.
    await openTab(page, "Categories");
    await page.locator('button:has-text("New")').first().click();
    await page.locator("#wizard-field").fill("Salary");
    await page.locator('button:has-text("Next")').click();
    await page.locator("#wizard-field").click();
    await page.locator('div[role=option]:has-text("income")').click();
    await page.locator('button:has-text("Submit")').click();

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
    // Try to delete — the sql-git action throws on FK violation; submit
    // surfaces the error, form stays open.
    await openTab(page, "Accounts");
    await page.locator('button:has-text("Delete")').first().click();
    await page.locator("#wizard-field").click();
    await page.locator('div[role=option]:has-text("Checking")').click();
    await page.locator('button:has-text("Submit")').click();
    // Expect an error (FK / constraint / RESTRICT) to surface. It shows
    // in both the wizard's error region and the top-bar alert, hence
    // `.first()` to satisfy strict mode.
    await expect(
      page.getByText(/FOREIGN KEY|constraint|RESTRICT/i).first(),
    ).toBeVisible();
    // Cancel out of the form.
    await page.locator('button:has-text("Cancel")').click();
  });
});
