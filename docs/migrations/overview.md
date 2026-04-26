# Migrations

Typhex includes a schema-diffing migration system. Define your entities, generate SQL migration files, apply them to the database, and inspect their status.

## API

### `db.generateMigrations(dir)`

Diffs current entity definitions against existing migration files in `dir` and writes new `.sql` files for any schema changes.

```ts
const files = await db.generateMigrations("./migrations");
// Returns: { name: string }[] — list of newly generated files
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
// Returns: { applied: string[], pending: string[] }
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
  0001_create_users.sql
```

Each file contains the DDL:

```sql
CREATE TABLE IF NOT EXISTS users (
  id integer primary key autoincrement,
  name text not null,
  email text
);
```

When you add a column to your entity (e.g., `age: "integer"`), the next `generateMigrations()` call writes a new file:

```sql
-- 0002_alter_users.sql
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

const db = new Db(createPostgresDriver({
  connectionString: process.env.TYPHEX_POSTGRES_URL!,
}));

await db.generateMigrations("./migrations");
await db.runMigrations("./migrations");
```

## CLI

Typhex ships a CLI that loads a `typhex.config.js` from your project root:

```bash
npx typhex migrate --dir ./migrations
npx typhex status --dir ./migrations
```
