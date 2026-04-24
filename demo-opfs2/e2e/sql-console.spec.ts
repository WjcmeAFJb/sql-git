import {
  test,
  expect,
  pickSuggestedPeer,
  newAccount,
  newCategory,
  newIncome,
  openSqlConsole,
  runSql,
} from "./helpers";

test.describe("SQL console", () => {
  test.beforeEach(async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await newAccount(page, "Checking");
    await newCategory(page, "Salary", "income");
    await newIncome(page, {
      amount: 500,
      account: "Checking",
      category: "Salary",
    });
  });

  test("opens + closes + sample queries prefill editor", async ({ page }) => {
    await openSqlConsole(page);
    // Default sample is prefilled.
    const ta = page.locator("textarea").first();
    await expect(ta).toHaveValue(/SELECT id, amount, memo, acc_from/);
    // Samples buttons swap the textarea value.
    await page.locator('button:has-text("Balance per account")').click();
    await expect(ta).toHaveValue(/FROM accounts/);
    // Close button collapses back to the floating trigger.
    await page.locator('button[title="Close"]').click();
    await expect(page.getByText("SQL console")).not.toBeVisible();
    await expect(page.locator('button:has-text("SQL")').last()).toBeVisible();
  });

  test("SELECT returns rows", async ({ page }) => {
    await openSqlConsole(page);
    await runSql(page, "SELECT name, balance FROM accounts;");
    await expect(page.locator("table").getByText("name")).toBeVisible();
    await expect(page.locator("table").getByText("balance")).toBeVisible();
    await expect(page.locator("table").getByText("Checking")).toBeVisible();
    await expect(page.locator("table").getByText("500")).toBeVisible();
  });

  test("SELECT returns 0 rows shows helpful message", async ({ page }) => {
    await openSqlConsole(page);
    await runSql(page, "SELECT * FROM accounts WHERE name = 'Nope';");
    await expect(page.getByText(/returned 0 rows/)).toBeVisible();
  });

  test("invalid SQL surfaces the sqlite error", async ({ page }) => {
    await openSqlConsole(page);
    await runSql(page, "SELECT * FROM nonexistent_table;");
    await expect(
      page.getByText(/no such table|syntax error|SQLITE/i),
    ).toBeVisible();
  });

  test("mutation submits as exec_sql action and updates the UI", async ({
    page,
  }) => {
    await openSqlConsole(page);
    // The mutation-mode info banner should appear for a non-SELECT.
    await page.locator("textarea").first().fill("UPDATE accounts SET name = 'Main' WHERE name = 'Checking';");
    await expect(page.getByText(/Writes are submitted as an/)).toBeVisible();
    await expect(page.getByText(/exec_sql/).first()).toBeVisible();
    // Info text wraps — the strong token is visible and stays inside the
    // container, i.e. the Run button is still clickable at its position.
    await expect(
      page.locator('div:has-text("SQL console")').getByText("Run").last(),
    ).toBeVisible();

    await page.locator('div:has-text("SQL console") >> button:has-text("Run")').last().click();
    await expect(page.getByText(/submitted/).first()).toBeVisible();
    await expect(page.getByText(/as\s*exec_sql/).first()).toBeVisible();

    // UI reflects the rename in the balance strip.
    await expect
      .poll(async () => /balances:[\s\S]*Main\b/.test(await page.innerText("body")))
      .toBe(true);

    // Action sidebar shows an exec_sql entry.
    await expect(page.getByText("exec_sql").first()).toBeVisible();
  });

  test("mutation error surfaces + doesn't advance the log", async ({ page }) => {
    await openSqlConsole(page);
    const initialBodyHead = await page.innerText("body");
    const headBefore = /head\s+(\d+)/.exec(initialBodyHead)?.[1];

    await page.locator("textarea").first().fill("UPDATE accounts SET balance = -1 WHERE name = 'Checking';");
    await page.locator('div:has-text("SQL console") >> button:has-text("Run")').last().click();
    // CHECK(balance >= 0) fires. sql-git's Store.submit throws before the
    // action lands in the log.
    await expect(
      page.getByText(/CHECK constraint|constraint failed/i).first(),
    ).toBeVisible();
    // Head should not have advanced.
    const after = await page.innerText("body");
    const headAfter = /head\s+(\d+)/.exec(after)?.[1];
    expect(headAfter).toBe(headBefore);
  });
});
