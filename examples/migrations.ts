/**
 * Migration system demo: generate, run, and inspect migration scripts.
 * Run: npx tsx examples/migrations.ts
 *
 * This example:
 *  1. Defines entities with FK relationships
 *  2. Generates ordered migration .sql files (users → posts → comments)
 *  3. Applies them to the database
 *  4. Adds a column to an entity and generates an alter migration
 *  5. Shows migration status
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Db, Entity, createSqliteDriver } from "../src/index.js";
import { clearRegistry } from "../src/entity/global-driver.js";

const migDir = mkdtempSync(join(tmpdir(), "typhex-example-mig-"));
console.log("Migrations directory:", migDir);

// --- Step 1: Define entities with FK relationships ---

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

// --- Step 2: Generate initial migration scripts ---

console.log("\n=== Step 2: Generate initial migrations ===");
const initialFiles = db.generateMigrations(migDir);
console.log(`Generated ${initialFiles.length} file(s):`);
for (const f of initialFiles) {
  console.log(`  ${f.name}`);
}

console.log("\nFile contents:");
for (const file of readdirSync(migDir).sort()) {
  console.log(`\n--- ${file} ---`);
  console.log(readFileSync(join(migDir, file), "utf-8").trim());
}

// --- Step 3: Apply migrations ---

console.log("\n=== Step 3: Run migrations ===");
const runResult = db.runMigrations(migDir);
console.log(`Applied: ${runResult.applied.length}, Skipped: ${runResult.skipped.length}`);
for (const name of runResult.applied) {
  console.log(`  applied: ${name}`);
}

// Verify tables exist
await User.create({ name: "Alice", email: "alice@example.com" });
await Post.create({ user_id: 1, title: "Hello World" });
await Comment.create({ post_id: 1, body: "Great post!" });
console.log("\nInserted test data: 1 user, 1 post, 1 comment");

const userCount = await User.query().count();
const postCount = await Post.query().count();
const commentCount = await Comment.query().count();
console.log(`Counts — users: ${userCount}, posts: ${postCount}, comments: ${commentCount}`);

// --- Step 4: Schema change — add a column ---

console.log("\n=== Step 4: Add 'age' column to users ===");
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

const alterFiles = db.generateMigrations(migDir);
console.log(`Generated ${alterFiles.length} file(s):`);
for (const f of alterFiles) {
  console.log(`  ${f.name}`);
}

if (alterFiles.length > 0) {
  console.log("\nNew file contents:");
  const latest = alterFiles[alterFiles.length - 1];
  console.log(`--- ${latest.name}.sql ---`);
  console.log(readFileSync(join(migDir, `${latest.name}.sql`), "utf-8").trim());
}

// Apply the alter migration
const alterResult = db.runMigrations(migDir);
console.log(`\nApplied: ${alterResult.applied.length}, Skipped: ${alterResult.skipped.length}`);

// --- Step 5: Migration status ---

console.log("\n=== Step 5: Migration status ===");
const status = db.migrationStatus(migDir);
console.log("Applied:");
for (const r of status.applied) {
  console.log(`  ${r.name}  (${r.applied_at})`);
}
console.log(`Pending: ${status.pending.length}`);

// Cleanup
db.close();
rmSync(migDir, { recursive: true, force: true });
console.log("\nDone.");
