# Conflict resolution

Most changes commute. When they don't, peer `sync()` calls your
resolver. This page covers the contract and the idioms.

## The resolver

```ts
import type { ConflictContext, Resolution } from "sql-git";

type Resolver = (ctx: ConflictContext) => Resolution | Promise<Resolution>;

const resolver: Resolver = async (ctx) => {
  // decide something
  return "drop" | "force" | "retry";
};

await store.sync({ onConflict: resolver });
```

## The context

```ts
type ConflictContext = {
  /** Your peer-side action that can't be rebased. */
  action: PeerActionEntry;
  /** Why: `"error"` means the action throws on current state; `"non_commutative"` means it runs fine but reordering with master's suffix produces a different result. */
  kind: "error" | "non_commutative";
  /** Present iff `kind === "error"`. */
  error?: Error;
  /** The master actions added since `action.baseMasterSeq`. */
  masterSuffix: MasterActionEntry[];
  /** Read-only db at `action.baseMasterSeq`. Inspect; don't mutate. */
  baseDb: Db;
  /** Read-only db at the new master head. Inspect; don't mutate. */
  rebasedDb: Db;
  /** Queue a mitigation action to prepend before retry (see below). */
  submit(name: string, params: unknown): void;
};
```

## The three resolutions

### `drop`

Remove the action from the peer log; it never reaches master. Sync
report counts it as `dropped`.

```ts
async (ctx) => "drop"
```

Use when the peer's intent is superseded by what master did — e.g.,
the peer queued a "rename A → B" but master has since deleted A. A drop
with no prior context is fine; the peer accepts that their change
lost.

### `force`

Keep the action, tagged `force: true`. On the next master sync, master
accepts it iff no other peer's actions have landed in between.

```ts
async (ctx) => ctx.kind === "non_commutative" ? "force" : "drop"
```

Use when the peer's intent must win and you've verified the conflict
is semantic, not a real error. Only valid for `non_commutative`
conflicts — forcing an `error` action would re-throw on master. sql-git
rejects that.

### `retry`

Apply any `ctx.submit(...)` mitigations, then re-check the action on
the updated base. Requires at least one prior `ctx.submit(...)` call;
without one, sync throws (because without a change, retry loops).

```ts
async (ctx) => {
  ctx.submit("create_transfer", {
    id: newId(),
    acc_from: "reserve",
    acc_to: ctx.action.params.acc_from,
    amount: missing,
    memo: "top-up",
    ts: nowTs(),
  });
  return "retry";
};
```

Use when you can fix the precondition — e.g., an overdraft can be
avoided by prepending a transfer from a reserve account.

## Non-modal resolvers

The resolver is `async`. You can wait for user input:

```ts
const resolver: Resolver = (ctx) =>
  new Promise((resolve) => {
    setPendingConflict({ ctx, resolve });
    setMode("conflict");
  });
```

Your UI sets `resolve("drop" | "force" | "retry")` when the user picks.
[`demo-opfs2/src/components/ConflictBar.tsx`](https://github.com/WjcmeAFJb/sql-git/blob/master/demo-opfs2/src/components/ConflictBar.tsx)
shows a non-modal dock that keeps tabs interactive while the conflict
is open — queued `ctx.submit` calls preview live because the UI reads
from `ctx.rebasedDb` during the conflict.

## The `submit` escape hatch

Inside `onConflict`, `ctx.submit(name, params)` queues a mitigation
action that's committed before the retry. Crucially:

- The mitigation runs against `ctx.rebasedDb` immediately — it's a
  real apply, not a pretend one.
- It's appended to the peer log regardless of which resolution you pick
  (drop / force / retry). If you drop the conflicting action but have
  queued mitigations, those still land.
- It can bump master's state non-trivially. Use it when the fix for a
  conflict is "add a new action first."

A common pattern is exposing the queued list in the UI so the user sees
what will run if they pick retry:

```
Queued mitigations (applied before retry):
  1. create_transfer {amount: 100, acc_from: reserve, ...}
  2. rename_account {id: acc-xyz, name: "Savings (renamed)"}
```

## Master's view: skipping

Master never runs `onConflict`. If a peer submits something that
doesn't rebase cleanly onto master, master simply stops processing
that peer at the first conflict — later actions stay pending until
the peer re-syncs, rebases, and either drops / forces / retries.

This keeps master's behavior deterministic and side-effect-free. All
the "human decision" lives on the peer side.

## Next

- [Convergence detection](/concepts/convergence)
- [API — Conflict context](/api/conflict-context)
