# Migrations

Typhex includes a schema-diffing migration system. Define your entities, generate SQL migration files, apply them to the database, and inspect their status.

## API

### `db.generateMigrations(dir)`

Diffs current entity definitions against the database and writes new `.js` migration modules for any schema changes.

```ts
const files = await db.generateMigrations("./migrations");
// Returns: { name: string, upSql: string, downSql: string, content: string }[]
```

On first run (no existing migration files), generates `CREATE TABLE` statements for all registered entities. On subsequent runs, generates `ALTER TABLE` statements for any new columns detected.

### `db.runMigrations(dir)`

Applies all pending migration files in `dir`, in lexicographic order by filename.

```ts
const result = await db.runMigrations("./migrations");
// Returns: { applied: string[], skipped: string[] }
```

Files already applied (tracked in a `_typhex_migrations` table) are skipped.

### `db.migrationStatus(dir)`

Inspects which migrations have been applied and which are pending.

```ts
const status = await db.migrationStatus("./migrations");
// Returns: { applied: MigrationRecord[], pending: string[] }
```

## Workflow

A typical migration flow:

```ts
import { Db, Entity, createSqliteDriver } from "typhex";

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  email: "text",
});

const db = new Db(createSqliteDriver({ path: "./app.db" }));

// 1. Generate any new migrations from current entity definitions
await db.generateMigrations("./migrations");

// 2. Apply them
await db.runMigrations("./migrations");
```

The first run creates files like:

```
migrations/
  2026042823220001_add_users_table.js
```

Each file exports SQL plus executable `up(db)` and `down(db)` functions:

```js
export const upSql = `CREATE TABLE IF NOT EXISTS "users" ("id" integer primary key autoincrement, "name" text not null, "email" text);`;

export const downSql = `DROP TABLE IF EXISTS "users";`;

export async function up(db) {
  await db.run(upSql);
}

export async function down(db) {
  await db.run(downSql);
}
```

When you add a column to your entity (e.g., `age: "integer"`), the next `generateMigrations()` call writes a new file:

```sql
-- 2026042823230001_add_age_column_on_users.js
ALTER TABLE users ADD COLUMN age integer;
```

`runMigrations()` then applies only the new file — already-applied files are skipped.

## PostgreSQL

The migration API is identical for PostgreSQL. Use PostgreSQL column types in your schema:

```ts
import { Db, Entity, createPostgresDriver } from "typhex";

const User = Entity("users", {
  id: "SERIAL PRIMARY KEY",
  name: "VARCHAR(255) NOT NULL",
  email: "VARCHAR(255)",
});

const db = new Db(
  createPostgresDriver({
    connectionString: process.env.TYPHEX_POSTGRES_URL!,
  }),
);

await db.generateMigrations("./migrations");
await db.runMigrations("./migrations");
```

## CLI

Typhex ships a CLI that loads a `typhex.config.js` from your project root:

```bash
npx typhex migrate:generate --entities ./dist/entities.js --db ./app.db --dir ./migrations
npx typhex migrate:run --db ./app.db --dir ./migrations
npx typhex migrate:status --db ./app.db --dir ./migrations
```

The same config can create a `Db` in application code:

```js
// typhex.config.js
export default {
  dialect: "sqlite",
  database: "./app.db",
  migrationsFolder: "./migrations",
  entities: "./dist/entities.js",
};
```

```ts
import { Db } from "typhex";

const db = await Db.fromConfig();
```

Use `url` instead of `database` for PostgreSQL connection strings.
