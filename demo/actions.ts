import type { ActionRegistry } from "../src/index.ts";

export type Account = { id: string; name: string; balance: number; created_at: string };
export type Category = {
  id: string;
  name: string;
  kind: "income" | "expense" | "both";
  created_at: string;
};
export type Transaction = {
  id: string;
  kind: "income" | "expense" | "transfer";
  acc_from: string | null;
  acc_to: string | null;
  amount: number;
  category_id: string | null;
  memo: string;
  ts: string;
};

export const CATEGORY_KINDS = ["income", "expense", "both"] as const;
export const TX_KINDS = ["income", "expense", "transfer"] as const;

/**
 * Schema: accounts, categories, transactions (with kind = income/expense/transfer).
 * Balances are maintained by triggers on INSERT/DELETE/UPDATE-OF-amount, and a
 * CHECK (balance >= 0) enforces the overdraft conflict semantics.
 */
export const bankActions: ActionRegistry = {
  init_bank: (db) => {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS categories (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('income','expense','both')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('income','expense','transfer')),
        acc_from    TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
        acc_to      TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
        amount      INTEGER NOT NULL CHECK (amount > 0),
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
        memo        TEXT NOT NULL DEFAULT '',
        ts          TEXT NOT NULL,
        CHECK (
          (kind = 'income'   AND acc_from IS NULL     AND acc_to IS NOT NULL) OR
          (kind = 'expense'  AND acc_from IS NOT NULL AND acc_to IS NULL)     OR
          (kind = 'transfer' AND acc_from IS NOT NULL AND acc_to IS NOT NULL AND acc_from != acc_to)
        )
      );
      CREATE TRIGGER IF NOT EXISTS txn_insert AFTER INSERT ON transactions BEGIN
        UPDATE accounts SET balance = balance - NEW.amount
          WHERE NEW.acc_from IS NOT NULL AND id = NEW.acc_from;
        UPDATE accounts SET balance = balance + NEW.amount
          WHERE NEW.acc_to   IS NOT NULL AND id = NEW.acc_to;
      END;
      CREATE TRIGGER IF NOT EXISTS txn_delete AFTER DELETE ON transactions BEGIN
        UPDATE accounts SET balance = balance + OLD.amount
          WHERE OLD.acc_from IS NOT NULL AND id = OLD.acc_from;
        UPDATE accounts SET balance = balance - OLD.amount
          WHERE OLD.acc_to   IS NOT NULL AND id = OLD.acc_to;
      END;
      CREATE TRIGGER IF NOT EXISTS txn_update AFTER UPDATE OF amount ON transactions BEGIN
        UPDATE accounts SET balance = balance + OLD.amount
          WHERE OLD.acc_from IS NOT NULL AND id = OLD.acc_from;
        UPDATE accounts SET balance = balance - OLD.amount
          WHERE OLD.acc_to   IS NOT NULL AND id = OLD.acc_to;
        UPDATE accounts SET balance = balance - NEW.amount
          WHERE NEW.acc_from IS NOT NULL AND id = NEW.acc_from;
        UPDATE accounts SET balance = balance + NEW.amount
          WHERE NEW.acc_to   IS NOT NULL AND id = NEW.acc_to;
      END;
    `);
  },

  // ─── accounts ─────────────────────────────────────────────────────────
  create_account: (db, p) => {
    const { id, name, ts } = p as { id: string; name: string; ts: string };
    db.prepare(
      "INSERT INTO accounts (id, name, balance, created_at) VALUES (?, ?, 0, ?)",
    ).run(id, name, ts);
  },
  rename_account: (db, p) => {
    const { id, name } = p as { id: string; name: string };
    const r = db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(name, id);
    if (r.changes === 0) throw new Error(`rename_account: no account '${id}'`);
  },
  delete_account: (db, p) => {
    const { id } = p as { id: string };
    const r = db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    if (r.changes === 0) throw new Error(`delete_account: no account '${id}'`);
  },

  // ─── categories ───────────────────────────────────────────────────────
  create_category: (db, p) => {
    const { id, name, kind, ts } = p as {
      id: string;
      name: string;
      kind: Category["kind"];
      ts: string;
    };
    db.prepare(
      "INSERT INTO categories (id, name, kind, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, name, kind, ts);
  },
  rename_category: (db, p) => {
    const { id, name } = p as { id: string; name: string };
    const r = db.prepare("UPDATE categories SET name = ? WHERE id = ?").run(name, id);
    if (r.changes === 0) throw new Error(`rename_category: no category '${id}'`);
  },
  delete_category: (db, p) => {
    const { id } = p as { id: string };
    const r = db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    if (r.changes === 0) throw new Error(`delete_category: no category '${id}'`);
  },

  // ─── transactions ─────────────────────────────────────────────────────
  create_income: (db, p) => {
    const { id, acc_to, amount, category_id, memo, ts } = p as {
      id: string;
      acc_to: string;
      amount: number;
      category_id: string | null;
      memo: string;
      ts: string;
    };
    db.prepare(
      `INSERT INTO transactions (id, kind, acc_from, acc_to, amount, category_id, memo, ts)
       VALUES (?, 'income', NULL, ?, ?, ?, ?, ?)`,
    ).run(id, acc_to, amount, category_id, memo ?? "", ts);
  },
  create_expense: (db, p) => {
    const { id, acc_from, amount, category_id, memo, ts } = p as {
      id: string;
      acc_from: string;
      amount: number;
      category_id: string | null;
      memo: string;
      ts: string;
    };
    db.prepare(
      `INSERT INTO transactions (id, kind, acc_from, acc_to, amount, category_id, memo, ts)
       VALUES (?, 'expense', ?, NULL, ?, ?, ?, ?)`,
    ).run(id, acc_from, amount, category_id, memo ?? "", ts);
  },
  create_transfer: (db, p) => {
    const { id, acc_from, acc_to, amount, memo, ts } = p as {
      id: string;
      acc_from: string;
      acc_to: string;
      amount: number;
      memo: string;
      ts: string;
    };
    db.prepare(
      `INSERT INTO transactions (id, kind, acc_from, acc_to, amount, category_id, memo, ts)
       VALUES (?, 'transfer', ?, ?, ?, NULL, ?, ?)`,
    ).run(id, acc_from, acc_to, amount, memo ?? "", ts);
  },
  edit_tx_amount: (db, p) => {
    const { id, amount } = p as { id: string; amount: number };
    const r = db.prepare("UPDATE transactions SET amount = ? WHERE id = ?").run(amount, id);
    if (r.changes === 0) throw new Error(`edit_tx_amount: no tx '${id}'`);
  },
  edit_tx_memo: (db, p) => {
    const { id, memo } = p as { id: string; memo: string };
    const r = db.prepare("UPDATE transactions SET memo = ? WHERE id = ?").run(memo, id);
    if (r.changes === 0) throw new Error(`edit_tx_memo: no tx '${id}'`);
  },
  edit_tx_category: (db, p) => {
    const { id, category_id } = p as { id: string; category_id: string | null };
    const r = db
      .prepare("UPDATE transactions SET category_id = ? WHERE id = ?")
      .run(category_id, id);
    if (r.changes === 0) throw new Error(`edit_tx_category: no tx '${id}'`);
  },
  delete_transaction: (db, p) => {
    const { id } = p as { id: string };
    const r = db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
    if (r.changes === 0) throw new Error(`delete_transaction: no tx '${id}'`);
  },
};
