import type { ActionRegistry } from "../src/index.ts";

/**
 * Bank schema used by both the Ink TUI demo and the e2e tests.
 *
 * `accounts.balance` carries a CHECK (balance >= 0) constraint and the
 * `txn_apply` trigger auto-debits / auto-credits balances on every row
 * inserted into `transactions` — so the whole transfer becomes a single
 * INSERT whose CHECK failure trips the rebase conflict path.
 */
export const bankActions: ActionRegistry = {
  init_bank: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL CHECK (balance >= 0)
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        acc_from TEXT NOT NULL,
        acc_to TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount > 0),
        ts TEXT NOT NULL,
        memo TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT ''
      );
      CREATE TRIGGER IF NOT EXISTS txn_apply AFTER INSERT ON transactions
      BEGIN
        UPDATE accounts SET balance = balance - NEW.amount WHERE id = NEW.acc_from;
        UPDATE accounts SET balance = balance + NEW.amount WHERE id = NEW.acc_to;
      END;
    `);
  },
  open_account: (db, p) => {
    const { id, initial } = p as { id: string; initial: number };
    db.prepare("INSERT INTO accounts (id, balance) VALUES (?, ?)").run(id, initial);
  },
  transfer: (db, p) => {
    const { txId, from, to, amount, ts, memo, category } = p as {
      txId: string;
      from: string;
      to: string;
      amount: number;
      ts: string;
      memo?: string;
      category?: string;
    };
    db.prepare(
      "INSERT INTO transactions (id, acc_from, acc_to, amount, ts, memo, category) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(txId, from, to, amount, ts, memo ?? "", category ?? "");
  },
  update_memo: (db, p) => {
    const { txId, memo } = p as { txId: string; memo: string };
    const r = db.prepare("UPDATE transactions SET memo = ? WHERE id = ?").run(memo, txId);
    if (r.changes === 0) throw new Error(`update_memo: no transaction with id='${txId}'`);
  },
  update_category: (db, p) => {
    const { txId, category } = p as { txId: string; category: string };
    const r = db
      .prepare("UPDATE transactions SET category = ? WHERE id = ?")
      .run(category, txId);
    if (r.changes === 0) throw new Error(`update_category: no transaction with id='${txId}'`);
  },
};

export type Account = { id: string; balance: number };
export type Transaction = {
  id: string;
  acc_from: string;
  acc_to: string;
  amount: number;
  ts: string;
  memo: string;
  category: string;
};
