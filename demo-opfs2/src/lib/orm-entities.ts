/**
 * Kysely schema describing sql-git's bank tables (see `demo/actions.ts`).
 * Used only for type-safe query builders — no entity classes, no DDL. The
 * tables themselves are created by sql-git's `init_bank` action.
 */
export interface BankDB {
  accounts: {
    id: string;
    name: string;
    balance: number;
    created_at: string;
  };
  categories: {
    id: string;
    name: string;
    kind: "income" | "expense" | "both";
    created_at: string;
  };
  transactions: {
    id: string;
    kind: "income" | "expense" | "transfer";
    acc_from: string | null;
    acc_to: string | null;
    amount: number;
    category_id: string | null;
    memo: string;
    ts: string;
  };
}

/** Row shapes are the same as the table defs above, re-exported for
 *  downstream convenience so components don't re-import them under a
 *  different name than the existing `demo/actions.ts` aliases. */
export type AccountRow = BankDB["accounts"];
export type CategoryRow = BankDB["categories"];
export type TransactionRow = BankDB["transactions"];
