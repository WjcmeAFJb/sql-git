import {
  test,
  expect,
  pickSuggestedPeer,
  newAccount,
  newCategory,
  newIncome,
  newExpense,
} from "./helpers";

/**
 * sql-git surfaces conflicts via the peer-side `runPeerSync` — master's
 * sync just *skips* conflicting peer actions, it doesn't invoke the
 * resolver. So we need to drive the error on bob's tab: bob queues a
 * pending expense, alice pushes a concurrent expense that draws the
 * Checking balance below what bob's expense needs, bob file-syncs twice
 * (push then pull), and bob's second auto-resync rebases onto the new
 * master head and fires the resolver.
 */
async function setupConflict(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
) {
  await pickSuggestedPeer(page, "alice");
  await newAccount(page, "Checking");
  await newCategory(page, "Salary", "income");
  await newIncome(page, {
    amount: 100,
    account: "Checking",
    category: "Salary",
  });

  const bob = await context.newPage();
  await bob.goto("/");
  await bob.locator("#custom-peer").fill("bob");
  await bob.locator('button:has-text("Open")').click();
  await bob.getByRole("button", { name: "File-sync", exact: true }).click();
  await bob
    .locator('div[role=dialog] button:has-text("Sync")')
    .last()
    .click();
  await expect(bob.getByText(/transferred/)).toBeVisible({ timeout: 30_000 });
  await bob
    .locator('div[role=dialog] button:has-text("Close")')
    .first()
    .click();
  await expect(bob.getByText("Checking").first()).toBeVisible({
    timeout: 30_000,
  });

  // Bob queues a $60 expense locally (pending).
  await newExpense(bob, { amount: 60, account: "Checking" });
  await expect(bob.getByText(/1\s*pending/i)).toBeVisible();

  // Alice — concurrently — spends $80 → balance $20. Bob's $60 won't fit.
  await newExpense(page, { amount: 80, account: "Checking" });
  await expect
    .poll(async () => {
      const m = /Checking\s+\$(\d+)/.exec(await page.innerText("body"));
      return m ? Number(m[1]) : null;
    })
    .toBe(20);

  // First bob file-sync: pushes bob.jsonl to alice, alice auto-syncs and
  // `skipped`s bob's action. Alice also squashes + writes new master log.
  await bob.getByRole("button", { name: "File-sync", exact: true }).click();
  await bob
    .locator('div[role=dialog] button:has-text("Sync")')
    .last()
    .click();
  await expect(bob.getByText(/transferred/)).toBeVisible({ timeout: 30_000 });
  await bob
    .locator('div[role=dialog] button:has-text("Close")')
    .first()
    .click();
  // Wait for alice to finish her master-side sync.
  await expect
    .poll(async () => /skipped=1/.test(await page.innerText("body")), {
      timeout: 30_000,
    })
    .toBe(true);

  // Second bob file-sync: pulls alice's updated log + snapshot. Bob's
  // own auto-resync rebases his expense on balance=$20 → conflict.
  await bob.getByRole("button", { name: "File-sync", exact: true }).click();
  await bob
    .locator('div[role=dialog] button:has-text("Sync")')
    .last()
    .click();
  await expect(bob.getByText(/transferred|nothing to transfer/)).toBeVisible({
    timeout: 30_000,
  });
  await bob
    .locator('div[role=dialog] button:has-text("Close")')
    .first()
    .click();

  // Bob's conflict bar appears.
  await expect(bob.getByText(/kind: error/)).toBeVisible({ timeout: 30_000 });
  return bob;
}

test.describe("conflict bar", () => {
  test("non-modal — tabs remain interactive", async ({ page, context }) => {
    const bob = await setupConflict(page, context);
    // Switching tabs still works with the conflict bar docked.
    await bob.getByRole("tab", { name: /Events/ }).click();
    await bob.getByRole("tab", { name: /Actions/ }).click();
    await expect(bob.getByText(/kind: error/)).toBeVisible();
    // Conflict bar shows the action name + stats.
    await expect(bob.getByText("create_expense").first()).toBeVisible();
    // There's a Drop/Force/Retry button; Retry starts disabled (no queued).
    await expect(bob.locator('button:has-text("Drop")')).toBeEnabled();
    await expect(bob.locator('button:has-text("Retry")')).toBeDisabled();
  });

  test("queue mitigation → Retry clears the conflict", async ({
    page,
    context,
  }) => {
    const bob = await setupConflict(page, context);
    // Queue an income mitigation worth $100 on bob (routed through
    // ctx.submit, shown in "queued mitigations" summary).
    await newIncome(bob, {
      amount: 100,
      account: "Checking",
      category: "Salary",
      memo: "topup",
    });
    await expect(bob.getByText(/1\s*queued\s*mitigation/i)).toBeVisible();
    // Retry now enabled.
    await bob.locator('button:has-text("Retry")').click();
    await expect(bob.getByText(/kind: error/)).not.toBeVisible({
      timeout: 30_000,
    });
  });

  test("drop clears the conflict without applying the action", async ({
    page,
    context,
  }) => {
    const bob = await setupConflict(page, context);
    await bob.locator('button:has-text("Drop")').click();
    await expect(bob.getByText(/kind: error/)).not.toBeVisible({
      timeout: 30_000,
    });
    // Bob's pending expense is gone — no pending count visible.
    await expect(bob.getByText(/pending/)).not.toBeVisible();
  });
});
