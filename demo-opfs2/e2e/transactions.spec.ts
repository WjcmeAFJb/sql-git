import {
  test,
  expect,
  pickSuggestedPeer,
  newAccount,
  newCategory,
  newIncome,
  newExpense,
  newTransfer,
  editTransaction,
  deleteTransaction,
  deleteAccount,
  openTab,
  readBalance,
} from "./helpers";

test.describe("transactions tab", () => {
  test.beforeEach(async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await newAccount(page, "Checking");
    await newAccount(page, "Savings");
    await newCategory(page, "Salary", "income");
    await newCategory(page, "Groceries", "expense");
  });

  test("creates income, expense, transfer and updates balances", async ({ page }) => {
    await newIncome(page, {
      amount: 1000,
      account: "Checking",
      category: "Salary",
      memo: "First paycheck",
    });
    await newExpense(page, {
      amount: 120,
      account: "Checking",
      category: "Groceries",
    });
    await newTransfer(page, {
      amount: 300,
      from: "Checking",
      to: "Savings",
      memo: "Monthly saving",
    });

    await expect(page.getByText(/Transactions\s*\(\s*3\s*\)/)).toBeVisible();
    await expect
      .poll(async () => readBalance(page, "Checking"))
      .toBe(580); // 1000 - 120 - 300
    await expect
      .poll(async () => readBalance(page, "Savings"))
      .toBe(300);
    // Memos show in both the transactions list and the action sidebar's
    // JSON dump — pick either.
    await expect(page.getByText(/First paycheck/).first()).toBeVisible();
    await expect(page.getByText(/Monthly saving/).first()).toBeVisible();
  });

  test("edit transaction amount + memo", async ({ page }) => {
    await newIncome(page, {
      amount: 500,
      account: "Checking",
      category: "Salary",
      memo: "initial",
    });

    await editTransaction(page, "initial", { amount: 700, memo: "updated" });

    await expect
      .poll(async () => readBalance(page, "Checking"))
      .toBe(700);
    await expect(page.getByText(/updated/).first()).toBeVisible();
  });

  test("delete transaction reverses the balance", async ({ page }) => {
    await newIncome(page, {
      amount: 500,
      account: "Checking",
      category: "Salary",
    });
    await deleteTransaction(page, /\$500/);
    await expect(page.getByText(/Transactions\s*\(\s*0\s*\)/)).toBeVisible();
    await expect
      .poll(async () => readBalance(page, "Checking"))
      .toBe(0);
  });

  test("transfer requires two accounts", async ({ page }) => {
    // Drop Savings, leaving only Checking.
    await deleteAccount(page, "Savings");

    await openTab(page, "Transactions");
    await page.locator('main button:has-text("New")').first().click();
    // Kind toggle shows Transfer but the Create button will be disabled
    // because accounts.length < 2 for a transfer.
    await page.locator('[data-testid="ntx-kind-transfer"]').click();
    await expect(
      page.locator('div[role=dialog] button:has-text("Create")'),
    ).toBeDisabled();
  });
});
