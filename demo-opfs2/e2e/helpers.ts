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

// ─── form + select helpers ──────────────────────────────────────────────

async function pickOption(
  page: Page,
  triggerSelector: string,
  optionLabel: string,
): Promise<void> {
  await page.locator(triggerSelector).click();
  await expect(
    page.locator(`div[role=option]:has-text("${optionLabel}")`).first(),
  ).toBeVisible();
  await page
    .locator(`div[role=option]:has-text("${optionLabel}")`)
    .first()
    .click();
}

/** Find a list item by one of its visible text fragments (row text). */
function row(page: Page, match: string | RegExp) {
  return page.locator(`main ul > li`).filter({ hasText: match }).first();
}

// ─── accounts CRUD ──────────────────────────────────────────────────────

export async function newAccount(page: Page, name: string): Promise<void> {
  await openTab(page, "Accounts");
  await page
    .locator('main button:has-text("New")')
    .first()
    .click();
  await expect(page.getByText("New account")).toBeVisible();
  await page.locator("#form-field-name").fill(name);
  await page.locator('button:has-text("Create")').click();
  await expect(page.getByText(name).first()).toBeVisible();
}

export async function renameAccount(
  page: Page,
  from: string,
  to: string,
): Promise<void> {
  await openTab(page, "Accounts");
  await row(page, from).locator('button[title="Rename"]').click();
  await expect(page.getByText(`Rename ${from}`)).toBeVisible();
  await page.locator("#form-field-name").fill(to);
  await page.locator('button:has-text("Save")').click();
}

export async function deleteAccount(page: Page, name: string): Promise<void> {
  await openTab(page, "Accounts");
  page.once("dialog", (d) => void d.accept());
  await row(page, name).locator('button[title="Delete"]').click();
}

/** Variant that dismisses the confirm dialog — the delete is aborted. */
export async function attemptDeleteAccountDismiss(
  page: Page,
  name: string,
): Promise<void> {
  await openTab(page, "Accounts");
  page.once("dialog", (d) => void d.dismiss());
  await row(page, name).locator('button[title="Delete"]').click();
}

// ─── categories CRUD ────────────────────────────────────────────────────

export async function newCategory(
  page: Page,
  name: string,
  kind: "income" | "expense" | "both",
): Promise<void> {
  await openTab(page, "Categories");
  await page
    .locator('main button:has-text("New")')
    .first()
    .click();
  await expect(page.getByText("New category")).toBeVisible();
  await page.locator("#form-field-name").fill(name);
  await pickOption(page, "#form-field-kind", kind);
  await page.locator('button:has-text("Create")').click();
  // Wait for the reactive query to reflect the new category before the
  // caller moves on — otherwise a follow-up dialog (e.g. newIncome) may
  // snapshot stale `categories` props and miss the just-created row.
  await expect(
    page.locator('main ul > li').filter({ hasText: name }).first(),
  ).toBeVisible();
}

export async function renameCategory(
  page: Page,
  from: string,
  to: string,
): Promise<void> {
  await openTab(page, "Categories");
  await row(page, from).locator('button[title="Rename"]').click();
  await expect(page.getByText(`Rename ${from}`)).toBeVisible();
  await page.locator("#form-field-name").fill(to);
  await page.locator('button:has-text("Save")').click();
}

export async function deleteCategory(page: Page, name: string): Promise<void> {
  await openTab(page, "Categories");
  page.once("dialog", (d) => void d.accept());
  await row(page, name).locator('button[title="Delete"]').click();
}

// ─── transactions CRUD ─────────────────────────────────────────────────

async function openNewTxDialog(page: Page): Promise<void> {
  await openTab(page, "Transactions");
  await page.locator('main button:has-text("New")').first().click();
  await expect(page.getByText("New transaction")).toBeVisible();
}

async function submitNewTx(page: Page): Promise<void> {
  await page.locator('div[role=dialog] button:has-text("Create")').click();
  await expect(page.getByText("New transaction")).not.toBeVisible();
}

export async function newIncome(
  page: Page,
  opts: { amount: number; account: string; category?: string; memo?: string },
): Promise<void> {
  await openNewTxDialog(page);
  await page.locator('[data-testid="ntx-kind-income"]').click();
  await page.locator("#ntx-amount").fill(String(opts.amount));
  await pickOption(page, "#ntx-acc-to", opts.account);
  if (opts.category) await pickOption(page, "#ntx-category", opts.category);
  if (opts.memo) await page.locator("#ntx-memo").fill(opts.memo);
  await submitNewTx(page);
}

export async function newExpense(
  page: Page,
  opts: { amount: number; account: string; category?: string; memo?: string },
): Promise<void> {
  await openNewTxDialog(page);
  await page.locator('[data-testid="ntx-kind-expense"]').click();
  await page.locator("#ntx-amount").fill(String(opts.amount));
  await pickOption(page, "#ntx-acc-from", opts.account);
  if (opts.category) await pickOption(page, "#ntx-category", opts.category);
  if (opts.memo) await page.locator("#ntx-memo").fill(opts.memo);
  await submitNewTx(page);
}

export async function newTransfer(
  page: Page,
  opts: { amount: number; from: string; to: string; memo?: string },
): Promise<void> {
  await openNewTxDialog(page);
  await page.locator('[data-testid="ntx-kind-transfer"]').click();
  await page.locator("#ntx-amount").fill(String(opts.amount));
  await pickOption(page, "#ntx-acc-from", opts.from);
  await pickOption(page, "#ntx-acc-to", opts.to);
  if (opts.memo) await page.locator("#ntx-memo").fill(opts.memo);
  await submitNewTx(page);
}

/** Edit the most recent transaction matching `match` in its row text. */
export async function editTransaction(
  page: Page,
  match: string | RegExp,
  opts: { amount?: number; memo?: string; category?: string },
): Promise<void> {
  await openTab(page, "Transactions");
  await row(page, match).locator('button[title="Edit"]').click();
  await expect(page.getByText(/^Edit /)).toBeVisible();
  if (opts.amount !== undefined) {
    await page.locator("#etx-amount").fill(String(opts.amount));
  }
  if (opts.memo !== undefined) {
    await page.locator("#etx-memo").fill(opts.memo);
  }
  if (opts.category !== undefined) {
    await pickOption(page, "#etx-category", opts.category);
  }
  await page.locator('div[role=dialog] button:has-text("Save")').click();
}

export async function deleteTransaction(
  page: Page,
  match: string | RegExp,
): Promise<void> {
  await openTab(page, "Transactions");
  page.once("dialog", (d) => void d.accept());
  await row(page, match).locator('button[title="Delete"]').click();
}

// ─── file-sync ──────────────────────────────────────────────────────────

/** Run the quick top-bar file-sync (no modal). Matches both non-master
 *  "synced with master…" and master "synced with N peer(s)…" toasts,
 *  plus the already-in-sync case. */
export async function quickFileSync(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "File-sync", exact: true })
    .click();
  await expect(
    page.getByText(/(^|:\s*)(synced with|already in sync with) /),
  ).toBeVisible({ timeout: 30_000 });
}

/** Open the detailed multi-peer dialog via the "Peers…" button. */
export async function openPeersMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Peers…", exact: true }).click();
  await expect(page.getByText("File-sync operations")).toBeVisible();
}

export async function runPeersMenuSync(page: Page): Promise<void> {
  await page
    .locator('div[role=dialog] button:has-text("Sync")')
    .last()
    .click();
  await expect(page.getByText(/transferred|nothing to transfer/)).toBeVisible({
    timeout: 30_000,
  });
}

export async function closePeersMenu(page: Page): Promise<void> {
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
