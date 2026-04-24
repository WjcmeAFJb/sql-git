import { test as base, expect, type Page } from "@playwright/test";

/**
 * Wipe OPFS + sessionStorage for the origin. Tests share a single dev
 * server (and therefore a single OPFS root), so each one must start from
 * a clean slate. Run from an already-navigated page — `navigator.storage`
 * is only defined in a browsing context.
 */
export async function clearStorage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try {
      sessionStorage.clear();
    } catch {
      /* noop */
    }
    try {
      const root = await navigator.storage.getDirectory();
      // DirectoryHandle's `entries()` is the async-iterable surface used
      // by the adapter itself; iterate and recursively remove each.
      const ents = (root as unknown as {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }).entries();
      for await (const [name] of ents) {
        await root.removeEntry(name, { recursive: true });
      }
    } catch {
      /* OPFS may be unavailable in older test browsers; noop */
    }
  });
}

/** Shared fixture: navigates + wipes before every test, so each spec
 *  starts at a freshly-loaded peer gate with no OPFS state. */
export const test = base.extend<{}>({
  page: async ({ page }, use) => {
    await page.goto("/");
    await clearStorage(page);
    await page.reload();
    await use(page);
  },
});

export { expect };

// ─── peer-gate helpers ───────────────────────────────────────────────────

export async function expectGate(page: Page): Promise<void> {
  await expect(page.getByText("Choose a peer for this tab")).toBeVisible();
}

export async function pickSuggestedPeer(
  page: Page,
  peerId: string,
  opts: { seed?: boolean } = {},
): Promise<void> {
  await expectGate(page);
  if (opts.seed) await page.locator('input[type=checkbox]').check();
  await page.locator(`button:has-text("${peerId}")`).first().click();
  await waitOpened(page);
}

export async function pickCustomPeer(
  page: Page,
  peerId: string,
  opts: { seed?: boolean } = {},
): Promise<void> {
  await expectGate(page);
  if (opts.seed) await page.locator('input[type=checkbox]').check();
  await page.locator("#custom-peer").fill(peerId);
  await page.locator('button:has-text("Open")').click();
  await waitOpened(page);
}

export async function waitOpened(page: Page): Promise<void> {
  // Wait for the initial sync to settle — status line shows something like
  // "synced applied=0 skipped=0 ...". Non-master peers with no files yet
  // transition to "opened as peer" and stop; accept either.
  await expect
    .poll(
      async () =>
        /(synced applied=|opened as peer)/.test(await page.innerText("body")),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect
    .poll(async () => /mode\s*IDLE/i.test(await page.innerText("body")), {
      timeout: 30_000,
    })
    .toBe(true);
}

export async function waitSeedDone(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        /Transactions\s*\(\s*15\s*\)/.test(await page.innerText("body")),
      { timeout: 60_000 },
    )
    .toBe(true);
}

// ─── tab navigation ─────────────────────────────────────────────────────

export async function openTab(
  page: Page,
  tab: "Transactions" | "Accounts" | "Categories",
): Promise<void> {
  await page.locator(`button[role=tab]:has-text("${tab}")`).click();
}

// ─── wizard helpers ─────────────────────────────────────────────────────

async function fillWizardInput(page: Page, value: string): Promise<void> {
  await page.locator("#wizard-field").fill(value);
}

async function pickWizardOption(page: Page, label: string): Promise<void> {
  await page.locator("#wizard-field").click();
  await expect(
    page.locator(`div[role=option]:has-text("${label}")`).first(),
  ).toBeVisible();
  await page
    .locator(`div[role=option]:has-text("${label}")`)
    .first()
    .click();
}

async function wizardNext(page: Page): Promise<void> {
  await page.locator('button:has-text("Next")').click();
}

async function wizardSubmit(page: Page): Promise<void> {
  await page.locator('button:has-text("Submit")').click();
}

// ─── CRUD ───────────────────────────────────────────────────────────────

export async function newAccount(page: Page, name: string): Promise<void> {
  await openTab(page, "Accounts");
  await page.locator('button:has-text("New")').first().click();
  await expect(page.getByText("New account")).toBeVisible();
  await fillWizardInput(page, name);
  await wizardSubmit(page);
  await expect(page.getByText(name).first()).toBeVisible();
}

export async function renameAccount(
  page: Page,
  from: string,
  to: string,
): Promise<void> {
  await openTab(page, "Accounts");
  await page.locator('button:has-text("Rename")').first().click();
  await pickWizardOption(page, from);
  await wizardNext(page);
  await fillWizardInput(page, to);
  await wizardSubmit(page);
}

export async function deleteAccount(page: Page, name: string): Promise<void> {
  await openTab(page, "Accounts");
  await page.locator('button:has-text("Delete")').first().click();
  await pickWizardOption(page, name);
  await wizardSubmit(page);
}

export async function newCategory(
  page: Page,
  name: string,
  kind: "income" | "expense" | "both",
): Promise<void> {
  await openTab(page, "Categories");
  await page.locator('button:has-text("New")').first().click();
  await expect(page.getByText("New category")).toBeVisible();
  await fillWizardInput(page, name);
  await wizardNext(page);
  await pickWizardOption(page, kind);
  await wizardSubmit(page);
}

export async function renameCategory(
  page: Page,
  from: string,
  to: string,
): Promise<void> {
  await openTab(page, "Categories");
  await page.locator('button:has-text("Rename")').first().click();
  await pickWizardOption(page, from);
  await wizardNext(page);
  await fillWizardInput(page, to);
  await wizardSubmit(page);
}

export async function deleteCategory(page: Page, name: string): Promise<void> {
  await openTab(page, "Categories");
  await page.locator('button:has-text("Delete")').first().click();
  await pickWizardOption(page, name);
  await wizardSubmit(page);
}

export async function newIncome(
  page: Page,
  opts: { amount: number; account: string; category?: string; memo?: string },
): Promise<void> {
  await openTab(page, "Transactions");
  await page.locator('button:has-text("New")').first().click();
  await expect(page.getByText("New transaction")).toBeVisible();
  await page.locator('button:has-text("Income")').click();
  await expect(page.getByText("New income")).toBeVisible();
  await fillWizardInput(page, String(opts.amount));
  await wizardNext(page);
  await pickWizardOption(page, opts.account);
  await wizardNext(page);
  if (opts.category) await pickWizardOption(page, opts.category);
  await wizardNext(page);
  if (opts.memo) await fillWizardInput(page, opts.memo);
  await wizardSubmit(page);
}

export async function newExpense(
  page: Page,
  opts: { amount: number; account: string; category?: string; memo?: string },
): Promise<void> {
  await openTab(page, "Transactions");
  await page.locator('button:has-text("New")').first().click();
  await expect(page.getByText("New transaction")).toBeVisible();
  await page.locator('button:has-text("Expense")').click();
  await expect(page.getByText("New expense")).toBeVisible();
  await fillWizardInput(page, String(opts.amount));
  await wizardNext(page);
  await pickWizardOption(page, opts.account);
  await wizardNext(page);
  if (opts.category) await pickWizardOption(page, opts.category);
  await wizardNext(page);
  if (opts.memo) await fillWizardInput(page, opts.memo);
  await wizardSubmit(page);
}

export async function newTransfer(
  page: Page,
  opts: { amount: number; from: string; to: string; memo?: string },
): Promise<void> {
  await openTab(page, "Transactions");
  await page.locator('button:has-text("New")').first().click();
  await expect(page.getByText("New transaction")).toBeVisible();
  await page.locator('button:has-text("Transfer")').click();
  await expect(page.getByText("New transfer")).toBeVisible();
  await fillWizardInput(page, String(opts.amount));
  await wizardNext(page);
  await pickWizardOption(page, opts.from);
  await wizardNext(page);
  await pickWizardOption(page, opts.to);
  await wizardNext(page);
  if (opts.memo) await fillWizardInput(page, opts.memo);
  await wizardSubmit(page);
}

// ─── file-sync ──────────────────────────────────────────────────────────

export async function openFileSync(page: Page): Promise<void> {
  // The schema-waiting alert on non-master peers has a lower-case
  // "file-sync menu" link — disambiguate to the top-bar button.
  await page
    .getByRole("button", { name: "File-sync", exact: true })
    .click();
  await expect(page.getByText("File-sync operations")).toBeVisible();
}

export async function runFileSync(page: Page): Promise<void> {
  await page
    .locator('div[role=dialog] button:has-text("Sync")')
    .last()
    .click();
  await expect(page.getByText(/transferred|nothing to transfer/)).toBeVisible({
    timeout: 30_000,
  });
}

export async function closeFileSync(page: Page): Promise<void> {
  // Dialog's top-right `X` has aria-label="Close"; use the footer button.
  await page
    .locator('div[role=dialog] button:has-text("Close")')
    .first()
    .click();
  await expect(page.getByText("File-sync operations")).not.toBeVisible();
}

// ─── SQL console ────────────────────────────────────────────────────────

export async function openSqlConsole(page: Page): Promise<void> {
  await page.locator('button:has-text("SQL")').last().click();
  await expect(page.getByText("SQL console")).toBeVisible();
}

export async function runSql(page: Page, sql: string): Promise<void> {
  const ta = page.locator("textarea").first();
  await ta.click();
  await ta.fill(sql);
  await page
    .locator('div.fixed >> button:has-text("Run")')
    .last()
    .click()
    .catch(async () => {
      // Fallback: no 'div.fixed' locator match on Chromium — use a
      // simpler disambiguator: Run button is inside the console, which
      // contains the text "SQL console".
      await page
        .locator('div:has-text("SQL console") >> button:has-text("Run")')
        .last()
        .click();
    });
}

// ─── utilities ──────────────────────────────────────────────────────────

export async function readHead(page: Page): Promise<number> {
  const text = await page.innerText("body");
  const m = /head\s+(\d+)/.exec(text);
  return m ? Number(m[1]) : -1;
}

export async function readBalance(
  page: Page,
  account: string,
): Promise<number> {
  // Balance strip shows "<account> $<amount>" per account.
  const text = await page.innerText("body");
  const re = new RegExp(`${account}\\s+\\$(-?\\d+(?:,\\d{3})*)`);
  const m = re.exec(text);
  if (!m) throw new Error(`balance for ${account} not found in body`);
  return Number(m[1].replace(/,/g, ""));
}
