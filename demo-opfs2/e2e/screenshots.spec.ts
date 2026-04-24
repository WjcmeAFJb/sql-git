import {
  test,
  expect,
  pickSuggestedPeer,
  waitSeedDone,
  openSqlConsole,
  openFileSync,
  newAccount,
  newCategory,
  newIncome,
  newExpense,
} from "./helpers";

/**
 * Visual regression snapshots. First run creates baselines under
 * `e2e/screenshots.spec.ts-snapshots/`; later runs compare and diff.
 *
 * Screenshots mask transient/ID-y content (timestamps, random IDs) via
 * CSS-level overrides on elements that would otherwise move between runs.
 */

async function freezeDynamicContent(page: import("@playwright/test").Page) {
  // The JSON dumps in the Actions sidebar include fresh auto-generated
  // IDs and ISO timestamps; mask them so screenshots compare stably.
  await page.addStyleTag({
    content: `
      /* Sidebar JSON blob (class marks the row's params dump) */
      aside .font-mono.text-\\[10px\\] { visibility: hidden !important; }
      aside .font-mono.text-\\[11px\\] span:last-child,
      aside .font-mono.text-\\[11px\\] .rounded.bg-muted {
        visibility: hidden !important;
      }
      /* Timestamps in Events tab */
      aside [role="tabpanel"] .text-\\[10px\\].text-muted-foreground {
        visibility: hidden !important;
      }
      /* Random ids on transaction rows */
      main ul li .text-\\[10px\\].text-muted-foreground.font-mono {
        visibility: hidden !important;
      }
      /* Generated account IDs on the accounts list (font-mono TEXT-[10px]) */
      main .font-mono.text-\\[10px\\] { visibility: hidden !important; }
    `,
  });
}

test.describe("screenshots", () => {
  test("peer gate — empty", async ({ page }) => {
    // Gate is default on first load.
    await expect(page.getByText("Choose a peer for this tab")).toBeVisible();
    await expect(page).toHaveScreenshot("gate-empty.png", {
      fullPage: false,
    });
  });

  test("peer gate — seed checked", async ({ page }) => {
    await page.locator('input[type=checkbox]').check();
    await expect(page).toHaveScreenshot("gate-seed.png", { fullPage: false });
  });

  test("app overview — seeded alice", async ({ page }) => {
    await pickSuggestedPeer(page, "alice", { seed: true });
    await waitSeedDone(page);
    await freezeDynamicContent(page);
    await expect(page).toHaveScreenshot("overview-seeded.png", {
      fullPage: false,
    });
  });

  test("empty state — new alice master", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await freezeDynamicContent(page);
    await expect(page).toHaveScreenshot("overview-empty.png", {
      fullPage: false,
    });
  });

  test("accounts tab — 3 accounts + 2 categories", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await newAccount(page, "Checking");
    await newAccount(page, "Savings");
    await newCategory(page, "Salary", "income");
    await newCategory(page, "Groceries", "expense");
    await newIncome(page, {
      amount: 500,
      account: "Checking",
      category: "Salary",
    });
    await newExpense(page, {
      amount: 120,
      account: "Checking",
      category: "Groceries",
    });
    await freezeDynamicContent(page);
    await expect(page).toHaveScreenshot("overview-crud.png", {
      fullPage: false,
    });
  });

  test("SQL console — SELECT result", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await newAccount(page, "Checking");
    await newCategory(page, "Salary", "income");
    await newIncome(page, {
      amount: 500,
      account: "Checking",
      category: "Salary",
    });
    await openSqlConsole(page);
    const ta = page.locator("textarea").first();
    await ta.fill("SELECT name, balance FROM accounts;");
    await page
      .locator('div:has-text("SQL console") >> button:has-text("Run")')
      .last()
      .click();
    await expect(page.locator("table").getByText("balance")).toBeVisible();
    await freezeDynamicContent(page);
    await expect(page).toHaveScreenshot("sql-console-select.png", {
      fullPage: false,
    });
  });

  test("SQL console — mutation info box", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await newAccount(page, "Checking");
    await openSqlConsole(page);
    const ta = page.locator("textarea").first();
    await ta.fill(
      "UPDATE accounts SET name = 'Renamed' WHERE name = 'Checking';",
    );
    // Info box appears.
    await expect(page.getByText(/Writes are submitted as an/)).toBeVisible();
    await freezeDynamicContent(page);
    await expect(page).toHaveScreenshot("sql-console-mutation-info.png", {
      fullPage: false,
    });
  });

  test("file-sync menu", async ({ page }) => {
    await pickSuggestedPeer(page, "alice");
    await openFileSync(page);
    await expect(page.getByText("Peer directories")).toBeVisible();
    await freezeDynamicContent(page);
    await expect(page).toHaveScreenshot("file-sync-menu.png", {
      fullPage: false,
    });
  });
});
