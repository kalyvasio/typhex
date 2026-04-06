/**
 * Typhex transactions: callback API, explicit API, nested savepoints, TransactionOptions.
 * Run: npx tsx examples/transactions/transactions.ts  (from project root)
 */

import { Db, Entity, Trx, createSqliteDriver } from "../../src/index.js";

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
});

const Post = Entity("posts", {
  id: "integer primary key autoincrement",
  title: "text not null",
  authorId: "integer not null",
});

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

// ── 1. Callback API — implicit propagation via AsyncLocalStorage ──────────────
//
// Any Entity.query() call inside the callback automatically uses the active
// transaction without needing an explicit `trx` argument.

console.log("\n── 1. Callback API (implicit propagation) ──");
await db.transaction(async (_trx) => {
  const user = await User.query().insert({ name: "Alice" });
  await Post.query().insert({ title: "Hello from Alice", authorId: user.id });
  console.log("Inserted Alice and her post inside a transaction");
});
console.log("User count:", await User.query().count()); // 1
console.log("Post count:", await Post.query().count()); // 1

// ── 2. Callback API — automatic rollback on error ─────────────────────────────

console.log("\n── 2. Rollback on error ──");
await db.transaction(async () => {
  await User.query().insert({ name: "Bob" });
  throw new Error("something went wrong");
}).catch((e) => console.log("Caught:", e.message));
console.log("User count after rollback:", await User.query().count()); // still 1

// ── 3. Explicit API — pass trx into service functions ────────────────────────
//
// db.beginTrx() gives you a Trx handle to pass around manually.
// Useful for service-layer patterns where you want to inject the transaction.

console.log("\n── 3. Explicit API (service-layer pattern) ──");

async function createUserWithPost(trx: Trx, name: string, title: string) {
  const user = await User.query(trx).insert({ name });
  await Post.query(trx).insert({ title, authorId: user.id });
  return user;
}

const trx = await db.beginTrx();
try {
  const carol = await createUserWithPost(trx, "Carol", "Carol's first post");
  console.log("Created user:", carol.name);
  await trx.commit();
} catch {
  await trx.rollback();
}
console.log("User count:", await User.query().count()); // 2
console.log("Post count:", await Post.query().count());  // 2

// ── 4. Nested transactions (savepoints) ───────────────────────────────────────
//
// Calling trx.transaction() inside an active transaction creates a savepoint.
// Rolling back the inner transaction only undoes the savepoint, not the whole trx.

console.log("\n── 4. Nested transactions (savepoints) ──");
await db.transaction(async (outer) => {
  const dave = await User.query(outer).insert({ name: "Dave" });
  console.log("Inserted Dave in outer trx");

  // Try to insert a post inside a nested savepoint — then discard it
  await outer.transaction(async (inner) => {
    await Post.query(inner).insert({ title: "Draft (will be discarded)", authorId: dave.id });
    throw new Error("discard draft");
  }).catch(() => console.log("Inner savepoint rolled back"));

  // Dave still exists; only the draft post was rolled back
  await Post.query(outer).insert({ title: "Dave's published post", authorId: dave.id });
});
console.log("User count:", await User.query().count()); // 3
console.log("Post count:", await Post.query().count());  // 3 (draft discarded, published kept)

// ── 5. TransactionOptions ─────────────────────────────────────────────────────

console.log("\n── 5. TransactionOptions ──");

// SQLite SERIALIZABLE → BEGIN IMMEDIATE
await db.transaction(async () => {
  await User.query().insert({ name: "Eve" });
  console.log("SERIALIZABLE transaction committed");
}, { isolationLevel: "SERIALIZABLE" });

// SQLite native EXCLUSIVE mode
const exclTrx = await db.beginTrx({ sqliteMode: "exclusive" });
await User.query(exclTrx).insert({ name: "Frank" });
await exclTrx.commit();
console.log("EXCLUSIVE mode transaction committed");

console.log("\nFinal user count:", await User.query().count()); // 5

await db.close();
console.log("Done.");
