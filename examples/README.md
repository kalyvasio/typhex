# Typhex examples

All examples use the `Entity()` API with schema-inferred types. From the **examples** directory:

```bash
cd examples
npm install
```

---

## 1. Basic (runtime parsing)

Entity definition, runtime arrow-function where, CRUD. Closure variables must be passed explicitly as the second argument to `.where()`.

```bash
npm run basic
```

Or: `npx tsx examples/basic/basic.ts`

---

## 2. Entity (relations + lifecycle hooks)

Relations (`rel.manyToOne`), subclasses for lifecycle hooks (`beforeSave`, custom getters), instance `save()` / `delete()`.

```bash
npm run entity
```

Or: `npx tsx examples/entity/entity-usage.ts`

---

## 3. Relation queries (select with relations)

Loads related entities via `select()`: `select(p => ({ id: p.id, author: p.author }))`. Split by case:

| Case | Path | Run |
|------|------|-----|
| **Circular refs** (User ↔ Post ↔ Comment, declare + createRequire) | `circular-refs/` | `npm run relations` |
| **Non-circular oneToMany** (Department → Employee, no declare) | `non-circular-one-to-many/` | `npm run relations:one-to-many` |
| **Non-circular manyToOne** (Contact → Company, no declare) | `non-circular-many-to-one/` | `npm run relations:many-to-one` |

---

## 4. PostgreSQL

Basic CRUD with PostgreSQL. Requires a running Postgres instance.

```bash
TYPHEX_POSTGRES_URL=postgresql://user:pass@localhost:5432/mydb npm run postgres
```

Or: `npx tsx examples/postgres/postgres.ts`

---

## 5. Migrations (SQLite)

Generate, run, and inspect migration scripts for SQLite.

```bash
npm run migrations
```

Or: `npx tsx examples/migrations/migrations.ts`

---

## 6. PostgreSQL migrations

Generate and run migrations against Postgres.

```bash
TYPHEX_POSTGRES_URL=postgresql://user:pass@localhost:5432/mydb npm run postgres-migrations
```

Or: `npx tsx examples/postgres-migrations/postgres-migrations.ts`

---

## 7. Transformer (compile-time)

TypeScript transformer: predicates compiled to IR at build time. Closure variables auto-captured; no second argument to `.where()`.

**Prerequisites**: from the repo root, run `npm install` once.

```bash
npm run transformer
```
