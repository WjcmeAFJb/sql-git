import { genId, nowTs } from "./id";

export type SubmitFn = (name: string, params: unknown) => Promise<string | null>;

/**
 * Populate a freshly-opened peer with two accounts, six categories, and a
 * realistic spread of ~15 transactions dated across the last ~50 days.
 *
 * Every mutation goes through `submit(...)`, so the seed is recorded as
 * ordinary actions in the peer's log — master picks them up on the next
 * sync, other peers see them after file-sync. Amounts are chosen so the
 * Checking balance never dips below zero (the CHECK constraint on
 * `accounts.balance` would otherwise reject the offending action).
 *
 * If any action fails, the caller receives the error message from the
 * first failing submit and the remaining actions are skipped. Partial
 * seeds are fine — the user can delete what they got or just move on.
 */
export async function seedBank(submit: SubmitFn): Promise<string | null> {
  const checking = genId("acc");
  const savings = genId("acc");
  const accts: Array<[string, string]> = [
    [checking, "Checking"],
    [savings, "Savings"],
  ];
  for (const [id, name] of accts) {
    const err = await submit("create_account", { id, name, ts: nowTs() });
    if (err) return err;
  }

  const salary = genId("cat");
  const groceries = genId("cat");
  const rent = genId("cat");
  const utilities = genId("cat");
  const fun = genId("cat");
  const transport = genId("cat");
  const cats: Array<[string, string, "income" | "expense" | "both"]> = [
    [salary, "Salary", "income"],
    [rent, "Rent", "expense"],
    [groceries, "Groceries", "expense"],
    [utilities, "Utilities", "expense"],
    [fun, "Entertainment", "expense"],
    [transport, "Transport", "expense"],
  ];
  for (const [id, name, kind] of cats) {
    const err = await submit("create_category", { id, name, kind, ts: nowTs() });
    if (err) return err;
  }

  const day = 86_400_000;
  const now = Date.now();
  const at = (offsetDays: number): string =>
    new Date(now - offsetDays * day).toISOString();

  type Tx =
    | { kind: "income"; daysAgo: number; amount: number; category: string; memo: string }
    | { kind: "expense"; daysAgo: number; amount: number; category: string; memo: string }
    | { kind: "transfer"; daysAgo: number; amount: number; memo: string };

  // Sequence crafted so Checking stays non-negative at every step.
  const txs: Tx[] = [
    { kind: "income", daysAgo: 50, amount: 3000, category: salary, memo: "March salary" },
    { kind: "expense", daysAgo: 49, amount: 1200, category: rent, memo: "April rent" },
    { kind: "transfer", daysAgo: 45, amount: 500, memo: "Monthly savings" },
    { kind: "expense", daysAgo: 42, amount: 85, category: groceries, memo: "" },
    { kind: "expense", daysAgo: 38, amount: 120, category: utilities, memo: "Electric" },
    { kind: "expense", daysAgo: 34, amount: 55, category: fun, memo: "Cinema" },
    { kind: "expense", daysAgo: 30, amount: 40, category: transport, memo: "Metro top-up" },
    { kind: "income", daysAgo: 20, amount: 3000, category: salary, memo: "April salary" },
    { kind: "expense", daysAgo: 19, amount: 1200, category: rent, memo: "May rent" },
    { kind: "transfer", daysAgo: 15, amount: 500, memo: "Monthly savings" },
    { kind: "expense", daysAgo: 12, amount: 95, category: groceries, memo: "Weekly shop" },
    { kind: "expense", daysAgo: 9, amount: 30, category: transport, memo: "Taxi" },
    { kind: "expense", daysAgo: 7, amount: 60, category: fun, memo: "Concert" },
    { kind: "expense", daysAgo: 4, amount: 75, category: groceries, memo: "" },
    { kind: "expense", daysAgo: 1, amount: 115, category: utilities, memo: "Internet" },
  ];

  for (const tx of txs) {
    const ts = at(tx.daysAgo);
    if (tx.kind === "income") {
      const err = await submit("create_income", {
        id: genId("inc"),
        acc_to: checking,
        amount: tx.amount,
        category_id: tx.category,
        memo: tx.memo,
        ts,
      });
      if (err) return err;
    } else if (tx.kind === "expense") {
      const err = await submit("create_expense", {
        id: genId("exp"),
        acc_from: checking,
        amount: tx.amount,
        category_id: tx.category,
        memo: tx.memo,
        ts,
      });
      if (err) return err;
    } else {
      const err = await submit("create_transfer", {
        id: genId("tr"),
        acc_from: checking,
        acc_to: savings,
        amount: tx.amount,
        memo: tx.memo,
        ts,
      });
      if (err) return err;
    }
  }

  return null;
}
