/**
 * Migration system demo: generate, run, and inspect migration scripts (SQLite).
 * Run: npx tsx examples/migrations/migrations.ts
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Db, Entity, createSqliteDriver } from "../../src/index.js";
import { clearRegistry } from "../../src/entity/global-driver.js";

const migDir = mkdtempSync(join(tmpdir(), "typhex-example-mig-"));
console.log("Migrations directory:", migDir);

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  email: "text",
});

const Post = Entity("posts", {
  id: "integer primary key autoincrement",
  user_id: "integer not null references users(id)",
  title: "text not null",
});

const Comment = Entity("comments", {
  id: "integer primary key autoincrement",
  post_id: "integer not null references posts(id)",
  body: "text not null",
});

const db = new Db(createSqliteDriver({ path: ":memory:" }));

console.log("\n=== Step 2: Generate initial migrations ===");
const initialFiles = await db.generateMigrations(migDir);
console.log(`Generated ${initialFiles.length} file(s):`);
for (const f of initialFiles) {
  console.log(`  ${f.name}`);
}

console.log("\nFile contents:");
for (const file of readdirSync(migDir).sort()) {
  console.log(`\n--- ${file} ---`);
  console.log(readFileSync(join(migDir, file), "utf-8").trim());
}

console.log("\n=== Step 3: Run migrations ===");
const runResult = await db.runMigrations(migDir);
console.log(`Applied: ${runResult.applied.length}, Skipped: ${runResult.skipped.length}`);

await User.query().insert({ name: "Alice", email: "alice@example.com" });
await Post.query().insert({ user_id: 1, title: "Hello World" });
await Comment.query().insert({ post_id: 1, body: "Great post!" });
console.log("\nInserted test data: 1 user, 1 post, 1 comment");

console.log("\n=== Step 4: Add 'age' column ===");
clearRegistry();
Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  email: "text",
  age: "integer",
});
Entity("posts", {
  id: "integer primary key autoincrement",
  user_id: "integer not null references users(id)",
  title: "text not null",
});
Entity("comments", {
  id: "integer primary key autoincrement",
  post_id: "integer not null references posts(id)",
  body: "text not null",
});

const alterFiles = await db.generateMigrations(migDir);
console.log(`Generated ${alterFiles.length} file(s):`);
for (const f of alterFiles) {
  console.log(`  ${f.name}`);
}

if (alterFiles.length > 0) {
  const latest = alterFiles[alterFiles.length - 1];
  console.log(`\n--- ${latest.name}.sql ---`);
  console.log(readFileSync(join(migDir, `${latest.name}.sql`), "utf-8").trim());
}

const alterResult = await db.runMigrations(migDir);
console.log(`\nApplied: ${alterResult.applied.length}, Skipped: ${alterResult.skipped.length}`);

console.log("\n=== Step 5: Migration status ===");
const status = await db.migrationStatus(migDir);
console.log("Applied:", status.applied.length);
console.log(`Pending: ${status.pending.length}`);

await db.close();
rmSync(migDir, { recursive: true, force: true });
console.log("\nDone.");
