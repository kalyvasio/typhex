# Transactions

Typhex provides two transaction APIs. Both support nested savepoints and configurable isolation levels.

## Callback API (Recommended)

Pass an async callback to `db.transaction()`. Any `Entity.query()` call inside the callback **automatically uses the active transaction** — no need to thread a `trx` argument through your code:

```ts
import { Db, Entity, createSqliteDriver } from "typhex";

await db.transaction(async () => {
  const user = await User.query().insert({ name: "Alice" });
  await Post.query().insert({ title: "Hello", authorId: user.id });
});
```

```sql
BEGIN
  INSERT INTO users (name) VALUES (?)
  INSERT INTO posts (title, authorId) VALUES (?, ?)
COMMIT
```

If the callback throws, the transaction is rolled back automatically:

```ts
await db
  .transaction(async () => {
    await User.query().insert({ name: "Bob" });
    throw new Error("oops");
  })
  .catch((e) => console.log("rolled back:", e.message));
```

```sql
BEGIN
  INSERT INTO users (name) VALUES (?)
ROLLBACK
```

## Explicit API (Service-Layer Pattern)

Use `db.beginTrx()` when you need to pass the transaction handle to functions that shouldn't know about `db`:

```ts
import { Trx } from "typhex";

async function createUserWithPost(trx: Trx, name: string, title: string) {
  const user = await User.query(trx).insert({ name });
  await Post.query(trx).insert({ title, authorId: user.id });
  return user;
}

const trx = await db.beginTrx();
try {
  const user = await createUserWithPost(trx, "Carol", "Carol's post");
  await trx.commit();
} catch {
  await trx.rollback();
}
```

`Entity.query(trx)` routes the query through the given transaction connection.

## Nested Transactions (Savepoints)

Calling `trx.transaction()` (or `db.transaction()` inside an active transaction) creates a **savepoint**. Rolling back the inner transaction only undoes work since the savepoint — the outer transaction is unaffected:

```ts
await db.transaction(async (outer) => {
  const dave = await User.query(outer).insert({ name: "Dave" });

  // Inner savepoint — will be rolled back
  await outer
    .transaction(async (inner) => {
      await Post.query(inner).insert({ title: "Draft", authorId: dave.id });
      throw new Error("discard draft");
    })
    .catch(() => {}); // only the draft is lost

  // Dave still exists; publish a different post
  await Post.query(outer).insert({ title: "Published", authorId: dave.id });
});
```

```sql
BEGIN
  INSERT INTO users (name) VALUES (?)
  SAVEPOINT sp_1
    INSERT INTO posts (title, authorId) VALUES (?, ?)
  ROLLBACK TO SAVEPOINT sp_1
  INSERT INTO posts (title, authorId) VALUES (?, ?)
COMMIT
```

## Transaction Options

### Isolation Level

```ts
await db.transaction(
  async () => {
    // ...
  },
  { isolationLevel: "SERIALIZABLE" },
);
```

```sql
-- SQLite
BEGIN IMMEDIATE
  ...
COMMIT

-- PostgreSQL
BEGIN ISOLATION LEVEL SERIALIZABLE
  ...
COMMIT
```

SQLite maps `"SERIALIZABLE"` to `BEGIN IMMEDIATE`.

### SQLite Exclusive Mode

```ts
const trx = await db.beginTrx({ sqliteMode: "exclusive" });
await User.query(trx).insert({ name: "Frank" });
await trx.commit();
```

`sqliteMode` accepts `"deferred"` (default), `"immediate"`, or `"exclusive"`.

## With insertGraph

`insertGraph` respects an active transaction — pass `trx` to keep the whole graph insertion atomic:

```ts
await db.transaction(async (trx) => {
  await Post.query(trx).insertGraph({
    title: "Hello",
    author: { name: "Alice" },
    tags: [{ name: "typescript" }, { name: "orm" }],
  });
});
```
