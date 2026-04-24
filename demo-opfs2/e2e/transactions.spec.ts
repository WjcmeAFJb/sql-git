import {
  test,
  expect,
  pickSuggestedPeer,
  newAccount,
  newCategory,
  newIncome,
  newExpense,
  newTransfer,
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

    await openTab(page, "Transactions");
    await page.locator('button:has-text("Edit")').first().click();
    await page.locator("#wizard-field").click();
    // Pick the one income transaction from the wizard's select.
    await page.locator('div[role=option]:has-text("500")').click();
    // Step 1 is the only field on the picker form, so the button is Submit.
    await page.locator('button:has-text("Submit")').click();
    // The edit-fields form opens in a new wizard — wait for it.
    await expect(page.getByText(/Edit inc-/)).toBeVisible();
    // Step 1: amount — enter a new value.
    await page.locator("#wizard-field").fill("700");
    await page.locator('button:has-text("Next")').click();
    // Step 2: memo.
    await page.locator("#wizard-field").fill("updated");
    await page.locator('button:has-text("Next")').click();
    // Step 3: category (keep).
    await page.locator('button:has-text("Submit")').click();

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
    await openTab(page, "Transactions");
    await page.locator('button:has-text("Delete")').first().click();
    await page.locator("#wizard-field").click();
    await page.locator('div[role=option]:has-text("500")').click();
    await page.locator('button:has-text("Submit")').click();
    await expect(page.getByText(/Transactions\s*\(\s*0\s*\)/)).toBeVisible();
    await expect
      .poll(async () => readBalance(page, "Checking"))
      .toBe(0);
  });

  test("transfer requires two accounts", async ({ page }) => {
    // Delete one account; attempt to open a transfer form.
    await openTab(page, "Accounts");
    await page.locator('button:has-text("Delete")').first().click();
    await page.locator("#wizard-field").click();
    await page.locator('div[role=option]:has-text("Savings")').click();
    await page.locator('button:has-text("Submit")').click();

    await openTab(page, "Transactions");
    await page.locator('button:has-text("New")').first().click();
    // Spy on window.alert since we fall back to `alert(...)` for ineligible
    // kinds; accept and continue.
    page.once("dialog", (d) => d.accept());
    await page.locator('button:has-text("Transfer")').click();
    // The dialog closed without opening the wizard (transfer unavailable).
    await expect(page.getByText(/New transfer/)).not.toBeVisible();
  });
});
