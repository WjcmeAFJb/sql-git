# Actions

Actions are the **only** write primitive in sql-git. They replace
`INSERT`, `UPDATE`, `DELETE` at the API surface — you never call those
directly in user code; you define an action that runs them, and call
`store.submit(actionName, params)`.

## The type

```ts
export type ActionFn = (db: Db, params: unknown) => void;
export type ActionRegistry = Record<string, ActionFn>;
```

`db` is the live in-memory SQLite database. `params` is whatever you
pass to `store.submit` — it's persisted to disk as JSON and replayed on
every peer, so it must be JSON-serializable.

## Why this shape

The key property sql-git needs is **determinism**: applying the same
sequence of actions with the same params yields the same db state on
every peer.

This single constraint gives you:

- **Log-based replication** — the log is a stream of
  `(name, params)` tuples; the peer that receives it re-runs your
  action registry to arrive at the same state.
- **Rebase** — master can incorporate your actions in a different order
  than you ran them, and you can re-run them on a different base, as
  long as the action function is pure.
- **Conflict detection** — because actions are pure, we can replay them
  on a clone and watch for divergence.

## Writing an action

```ts
const actions: ActionRegistry = {
  // Good: params carry everything non-deterministic.
  append_note: (db, p) => {
    const { id, body, ts } = p as { id: string; body: string; ts: string };
    db.prepare("INSERT INTO notes (id, body, ts) VALUES (?, ?, ?)")
      .run(id, body, ts);
  },

  // BAD: `Date.now()` makes the action non-deterministic — every peer
  // that replays it gets a different timestamp, divergence is
  // immediate.
  append_note_bad: (db, { body }: any) => {
    const id = `n-${Date.now()}`;
    db.prepare("INSERT INTO notes VALUES (?, ?, ?)")
      .run(id, body, new Date().toISOString());
  },

  // Good: the submitter generates the ID + timestamp. The action just
  // applies.
  append_note_good: (db, p) => {
    const { id, body, ts } = p as { id: string; body: string; ts: string };
    db.prepare("INSERT INTO notes VALUES (?, ?, ?)").run(id, body, ts);
  },
};

// Caller generates IDs / timestamps.
await store.submit("append_note_good", {
  id: crypto.randomUUID(),
  body: "hello",
  ts: new Date().toISOString(),
});
```

Rule of thumb: if it wouldn't compile the same way on every peer, it
goes in `params`.

## Validating inside an action

Actions can throw. A throw during `store.submit` surfaces as the
submit's rejection, and the action is *not* appended to the log:

```ts
delete_account: (db, p) => {
  const { id } = p as { id: string };
  const r = db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  if (r.changes === 0) throw new Error(`delete_account: no '${id}'`);
},
```

During rebase, a throw is treated as an `error`-kind conflict — your
resolver gets a chance to `drop` it or queue a mitigation and `retry`.

## Actions at the SQL layer

The library gives you a thin wrapper over `sqlite3-read-tracking`:

- `db.prepare(sql)` — returns a statement with `run / get / all` mimicking
  better-sqlite3.
- `db.exec(sql, params?)` — batch execution.
- `db.pragma(stmt)` — for `foreign_keys = ON`, etc.

CHECK constraints, triggers, FK enforcement — all the usual SQLite
mechanics apply. See the TUI demo's
[`bankActions`](https://github.com/WjcmeAFJb/sql-git/blob/master/demo/actions.ts)
for a real-world registry with balance triggers + FK-based delete
restrictions.

## What actions can't do

- **Read other tables non-deterministically.** If your action's behavior
  depends on which rows exist at submit time and those rows differ
  across peers, you'll diverge on replay.
- **Call into the network, filesystem, or `navigator.*`.** Zero side
  effects outside `db`.

If you need that, do it *before* `store.submit` and pass the result
through `params`.

## Registering actions

```ts
await Store.open({
  root: "/path",
  peerId: "alice",
  masterId: "alice",
  actions, // your registry
});
```

Every peer must register the same action names with semantically-equivalent
implementations. Divergence in the implementation is equivalent to
divergence in the log — the library cannot detect it, your state just
starts to drift.

## Submitting

```ts
await store.submit("append_note_good", { id, body, ts });
```

What happens internally:

1. Look up `actions[name]`. Throw if missing.
2. Apply it to the live `db` — if it throws, submit rejects, log is not
   touched.
3. Append the entry to this peer's log on disk (`peers/<peerId>.jsonl`).

The submit is only complete once step 3 resolves. For the Node adapter
that's an atomic tmp-then-rename; for OPFS it's a seek-backed
`createWritable` + `close`.

## The escape hatch: `exec_sql`

For the SQL console in `demo-opfs2` we wanted to let the user run
ad-hoc SQL and have it replicate like a normal action. The solution
is an `exec_sql` action whose params are `{ sql: string }`:

```ts
exec_sql: (db, p) => {
  const { sql } = p as { sql: string };
  if (typeof sql !== "string" || !sql.trim()) throw new Error("exec_sql: empty");
  db.exec(sql);
},
```

Mutations from the SQL console go through
`store.submit("exec_sql", { sql })` — logged, rebased, replicated like
any other action. The caller is responsible for determinism (no
`RANDOM()`, no `datetime('now')`).

## Next

- [Master & peers](/concepts/roles)
- [Sync & rebase](/concepts/sync-and-rebase)
