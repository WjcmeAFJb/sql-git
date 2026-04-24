# Conflict context

The object your `onConflict` resolver receives.

## Type

```ts
import type {
  ConflictContext,
  ConflictKind,
  Resolution,
  Resolver,
  PeerActionEntry,
  MasterActionEntry,
  Db,
} from "sql-git";

type Resolver = (ctx: ConflictContext) => Resolution | Promise<Resolution>;
type Resolution = "drop" | "force" | "retry";
type ConflictKind = "error" | "non_commutative";

type ConflictContext = {
  action: PeerActionEntry;
  kind: ConflictKind;
  error?: Error;                     // only for kind === "error"
  masterSuffix: MasterActionEntry[]; // master actions since action.baseMasterSeq
  baseDb: Db;                        // read-only db at action.baseMasterSeq
  rebasedDb: Db;                     // read-only db at the new master head
  submit(name: string, params: unknown): void;
};
```

## `ctx.action`

The peer-side entry that couldn't be rebased:

```ts
type PeerActionEntry = {
  kind: "action";
  seq: number;                // your peer-log seq
  name: string;               // action name in the registry
  params: unknown;             // JSON-serialisable params
  baseMasterSeq: number;      // master head when you submitted it
  force?: boolean;            // set on a prior force resolution
};
```

## `ctx.kind`

- `"error"` — the action *throws* when applied to `ctx.rebasedDb`.
  Cannot be `force`'d; must be `drop`'d or `retry`'d with a mitigation
  that prevents the throw.
- `"non_commutative"` — the action applies cleanly but reordering with
  the master suffix changes the final state. Can be `drop`'d or
  `force`'d (taking the peer's intent as-is).

## `ctx.error`

Present iff `ctx.kind === "error"`. The error the action threw on
replay.

## `ctx.masterSuffix`

The master actions added between the peer action's `baseMasterSeq`
and the current master head. A resolver can inspect these to decide
whether a drop / force is the right call.

```ts
const transfersIntoCheckingSinceSubmit = ctx.masterSuffix.filter(
  (e) =>
    e.name === "create_transfer" &&
    (e.params as any).acc_to === "acc-checking",
);
```

## `ctx.baseDb`

A read-only clone of the database at `action.baseMasterSeq`. Query to
compare "before" and "after" master's suffix.

```ts
const originalBalance = ctx.baseDb
  .prepare("SELECT balance FROM accounts WHERE id = ?")
  .get("acc-checking")?.balance;
```

## `ctx.rebasedDb`

A read-only clone of the database at the current master head. This is
the state your action will see if it's retried.

::: warning
`ctx.submit(...)` DOES mutate `ctx.rebasedDb`. The "read-only" label
means you shouldn't hand-roll `.prepare().run()` against it; use the
`submit` escape hatch for all mutations during conflict.
:::

## `ctx.submit(name, params)` → `void`

Queue a new peer action that will be committed to your log before
retrying. Applied immediately to `ctx.rebasedDb` so subsequent
`ctx.baseDb` / `ctx.rebasedDb` reads reflect it.

```ts
ctx.submit("create_transfer", {
  id: "topup-1",
  acc_from: "reserve",
  acc_to: "checking",
  amount: 100,
  memo: "top-up before retry",
  ts: new Date().toISOString(),
});
```

Invariants:

- Throws if `name` isn't in the action registry.
- Throws if the action errors on apply.
- The action is persisted to the peer log regardless of which
  resolution you return (drop / force / retry).

## Example resolvers

### Always drop

```ts
const alwaysDrop: Resolver = () => "drop";
```

Good for "best-effort, peer silently loses on conflict" semantics.

### Force non-commutative

```ts
const forceOrDrop: Resolver = (ctx) =>
  ctx.kind === "non_commutative" ? "force" : "drop";
```

"Peer's write wins on non-commutative conflicts; peer loses on genuine
errors."

### Retry with a top-up

```ts
const retryWithTopup: Resolver = (ctx) => {
  if (ctx.kind !== "error") return "drop";
  if (!isOverdraft(ctx)) return "drop";
  ctx.submit("create_transfer", mkTopup(ctx));
  return "retry";
};
```

### Promise-based UI resolver

```ts
function uiResolver(): Resolver {
  return (ctx) =>
    new Promise((resolve) => {
      setPendingConflict({ ctx, resolve });
      // UI reads ctx, user picks a button.
    });
}

// Usage: the UI calls resolve("drop" | "force" | "retry") when the
// user clicks a button. Any submit done via ctx.submit from that
// button handler is queued.
```

See
[`demo-opfs2/src/components/ConflictBar.tsx`](https://github.com/WjcmeAFJb/sql-git/blob/master/demo-opfs2/src/components/ConflictBar.tsx)
for the full non-modal implementation.

## See also

- [Conflict resolution](/concepts/conflicts)
- [Store.sync](/api/store)
