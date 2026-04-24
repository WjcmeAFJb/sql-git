import {
  test,
  expect,
  pickSuggestedPeer,
  newCategory,
  renameCategory,
  deleteCategory,
  openTab,
} from "./helpers";

test.describe("categories tab", () => {
  test.beforeEach(async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
  });

  test("empty state + create income / expense / both", async ({ page }) => {
    await openTab(page, "Categories");
    // Both the CategoriesTab body and the CategoryBreakdown card render
    // their own "no categories yet" hint — either match is fine.
    await expect(page.getByText(/No categories yet/).first()).toBeVisible();

    await newCategory(page, "Salary", "income");
    await newCategory(page, "Groceries", "expense");
    await newCategory(page, "Other", "both");

    await expect(page.getByText(/Categories\s*\(\s*3\s*\)/)).toBeVisible();
    // Row kind badges render via `text-transform: uppercase`; the DOM
    // text is still the raw kind ("income"/"expense"/"both").
    await expect(
      page.locator('li:has-text("Salary")').getByText("income", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('li:has-text("Groceries")').getByText("expense", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('li:has-text("Other")').getByText("both", { exact: true }),
    ).toBeVisible();
  });

  test("rename + delete category", async ({ page }) => {
    await newCategory(page, "Salary", "income");
    await renameCategory(page, "Salary", "Paycheck");
    await expect(
      page.locator('ul >> li >> span.font-medium:has-text("Paycheck")').first(),
    ).toBeVisible();
    await expect(
      page.locator('ul >> li >> span.font-medium:has-text("Salary")'),
    ).toHaveCount(0);

    await deleteCategory(page, "Paycheck");
    await expect(page.getByText(/No categories yet/).first()).toBeVisible();
  });
});
