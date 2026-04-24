import {
  test,
  expect,
  pickSuggestedPeer,
  newAccount,
  newCategory,
  newIncome,
  newExpense,
  waitSeedDone,
} from "./helpers";

test.describe("stats panel + category breakdown", () => {
  test("empty state shows zeroes and empty category breakdown", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    // Stats panel cards: each label appears + each value is $0 (we read
    // innerText to avoid locator-to-value structural assumptions).
    const body = await page.innerText("body");
    expect(body).toMatch(/NET BALANCE\s*\$0\b/);
    expect(body).toMatch(/TOTAL INCOME\s*\$0\b/);
    expect(body).toMatch(/TOTAL EXPENSE\s*\$0\b/);
    expect(body).toMatch(/TRANSACTIONS\s*0\b/);
    // Category breakdown empty.
    await expect(
      page.getByText(/No categories yet — add one/),
    ).toBeVisible();
  });

  test("stats + breakdown react to each action", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await newAccount(page, "Checking");
    await newCategory(page, "Salary", "income");
    await newCategory(page, "Groceries", "expense");
    await newIncome(page, { amount: 500, account: "Checking", category: "Salary" });
    // Net balance reflects the income.
    await expect.poll(async () => {
      const text = await page.innerText("body");
      const m = /NET BALANCE[\s\S]*?\$([0-9,]+)/.exec(text);
      return m ? m[1] : null;
    }).toBe("500");
    // Breakdown row for Salary reports 1 tx, $500.
    await expect
      .poll(async () => {
        const text = await page.innerText("body");
        return /Salary\s+INCOME\s+·\s*1 txs\s+\$500/.test(text);
      })
      .toBe(true);

    await newExpense(page, { amount: 120, account: "Checking", category: "Groceries" });
    await expect.poll(async () => {
      const text = await page.innerText("body");
      const m = /NET BALANCE[\s\S]*?\$([0-9,]+)/.exec(text);
      return m ? m[1] : null;
    }).toBe("380");
    await expect.poll(async () => {
      const text = await page.innerText("body");
      const m = /TOTAL EXPENSE[\s\S]*?\$([0-9,]+)/.exec(text);
      return m ? m[1] : null;
    }).toBe("120");
    await expect
      .poll(async () => {
        const text = await page.innerText("body");
        return /Groceries\s+EXPENSE\s+·\s*1 txs\s+\$120/.test(text);
      })
      .toBe(true);
  });

  test("seed populates breakdown with 6 categories", async ({ page }) => {
    await pickSuggestedPeer(page, "alice", { seed: true });
    await waitSeedDone(page);
    // Breakdown lists all 6 seeded categories with correct tx counts.
    await expect(page.getByText(/Salary[\s\S]*2 txs/)).toBeVisible();
    await expect(page.getByText(/Rent[\s\S]*2 txs/)).toBeVisible();
    await expect(page.getByText(/Groceries[\s\S]*3 txs/)).toBeVisible();
    await expect(page.getByText(/Utilities[\s\S]*2 txs/)).toBeVisible();
    await expect(page.getByText(/Entertainment[\s\S]*2 txs/)).toBeVisible();
    await expect(page.getByText(/Transport[\s\S]*2 txs/)).toBeVisible();
  });
});
