/**
 * PostgreSQL migration demo: generate and run migrations against Postgres.
 * Run: TYPHEX_POSTGRES_URL=postgresql://user:pass@localhost:5432/mydb npx tsx examples/postgres-migrations.ts
 *
 * This example:
 *  1. Defines entities with PostgreSQL column types (SERIAL, VARCHAR, etc.)
 *  2. Generates migration .sql files for Postgres
 *  3. Applies them to the database
 *  4. Shows migration status
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Db, Entity, createPostgresDriver } from "../src/index.js";
import { clearRegistry } from "../src/entity/global-driver.js";

const connectionString =
  process.env.TYPHEX_POSTGRES_URL ?? "postgresql://localhost:5432/typhex_test";

const migDir = mkdtempSync(join(tmpdir(), "typhex-pg-mig-"));
console.log("Migrations directory:", migDir);
console.log("PostgreSQL:", connectionString.replace(/:[^:@]+@/, ":****@"));

// --- Step 1: Define entities with PostgreSQL column types ---

const User = Entity("pg_users", {
  id: "SERIAL PRIMARY KEY",
  name: "VARCHAR(255) NOT NULL",
  email: "VARCHAR(255)",
});

const Post = Entity("pg_posts", {
  id: "SERIAL PRIMARY KEY",
  user_id: "INTEGER NOT NULL REFERENCES pg_users(id)",
  title: "VARCHAR(500) NOT NULL",
});

const driver = createPostgresDriver({ connectionString });
const db = new Db(driver);

// --- Step 2: Generate initial migration scripts ---

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

// --- Step 3: Apply migrations ---

console.log("\n=== Step 3: Run migrations ===");
const runResult = await db.runMigrations(migDir);
console.log(`Applied: ${runResult.applied.length}, Skipped: ${runResult.skipped.length}`);
for (const name of runResult.applied) {
  console.log(`  applied: ${name}`);
}

// Verify tables exist
await User.create({ name: "Alice", email: "alice@example.com" });
await Post.create({ user_id: 1, title: "Hello World" });
console.log("\nInserted test data: 1 user, 1 post");

const userCount = await User.query().count();
const postCount = await Post.query().count();
console.log(`Counts — users: ${userCount}, posts: ${postCount}`);

// --- Step 4: Schema change — add a column ---

console.log("\n=== Step 4: Add 'age' column to pg_users ===");
clearRegistry();
Entity("pg_users", {
  id: "SERIAL PRIMARY KEY",
  name: "VARCHAR(255) NOT NULL",
  email: "VARCHAR(255)",
  age: "INTEGER",
});
Entity("pg_posts", {
  id: "SERIAL PRIMARY KEY",
  user_id: "INTEGER NOT NULL REFERENCES pg_users(id)",
  title: "VARCHAR(500) NOT NULL",
});

const alterFiles = await db.generateMigrations(migDir);
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
const alterResult = await db.runMigrations(migDir);
console.log(`\nApplied: ${alterResult.applied.length}, Skipped: ${alterResult.skipped.length}`);

// --- Step 5: Migration status ---

console.log("\n=== Step 5: Migration status ===");
const status = await db.migrationStatus(migDir);
console.log("Applied:");
for (const r of status.applied) {
  console.log(`  ${r.name}  (${r.applied_at})`);
}
console.log(`Pending: ${status.pending.length}`);

// Cleanup
await db.close();
rmSync(migDir, { recursive: true, force: true });
console.log("\nDone.");
