/**
 * PostgreSQL migration demo: generate and run migrations against Postgres.
 * Run: TYPHEX_POSTGRES_URL=postgresql://user:pass@localhost:5432/mydb npx tsx examples/postgres-migrations/postgres-migrations.ts
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Db, Entity, createPostgresDriver } from "../../src/index.js";
import { clearRegistry } from "../../src/entity/global-driver.js";

const connectionString =
  process.env.TYPHEX_POSTGRES_URL ?? "postgresql://localhost:5432/typhex_test";

const migDir = mkdtempSync(join(tmpdir(), "typhex-pg-mig-"));
console.log("Migrations directory:", migDir);
console.log("PostgreSQL:", connectionString.replace(/:[^:@]+@/, ":****@"));

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
console.log("\nInserted test data: 1 user, 1 post");

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
