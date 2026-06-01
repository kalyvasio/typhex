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

| Case                                                               | Path                        | Run                             |
| ------------------------------------------------------------------ | --------------------------- | ------------------------------- |
| **Circular refs** (User ↔ Post ↔ Comment, declare + createRequire) | `circular-refs/`            | `npm run relations`             |
| **Non-circular oneToMany** (Department → Employee, no declare)     | `non-circular-one-to-many/` | `npm run relations:one-to-many` |
| **Non-circular manyToOne** (Contact → Company, no declare)         | `non-circular-many-to-one/` | `npm run relations:many-to-one` |

---

## 4. Relation where (JOIN)

Filter by related entity properties via JOIN. When a relation is used in `where()` (e.g. `c.company.name === "Acme"`), typhex emits a JOIN instead of failing. If the same relation is in `select()`, it reuses the joined data (no redundant whereIn fetch).

```bash
npx tsx examples/relation-where/relation-where.ts
```

---

## 5. PostgreSQL

Basic CRUD with PostgreSQL. Requires a running Postgres instance.

```bash
TYPHEX_POSTGRES_URL=postgresql://user:pass@localhost:5432/mydb npm run postgres
```

Or: `npx tsx examples/postgres/postgres.ts`

---

## 6. Migrations (SQLite)

Generate, run, and inspect migration scripts for SQLite.

```bash
npm run migrations
```

Or: `npx tsx examples/migrations/migrations.ts`

---

## 7. PostgreSQL migrations

Generate and run migrations against Postgres.

```bash
TYPHEX_POSTGRES_URL=postgresql://user:pass@localhost:5432/mydb npm run postgres-migrations
```

Or: `npx tsx examples/postgres-migrations/postgres-migrations.ts`

---

## 8. Transformer (compile-time)

TypeScript transformer: predicates compiled to IR at build time. Closure variables auto-captured; no second argument to `.where()`.

**Prerequisites**: from the repo root, run `npm install` once.

```bash
npm run transformer
```

---

## 9. CTE (WITH clauses)

`withCte`, `withRecursiveCte`, `unionAll`, mutations correlated to registered CTEs. Built with the Typhex transformer (same toolchain as subqueries).

**Prerequisites**: `npm install` in `examples/` (links `typhex` from the repo root) and `npm install` at the repo root (for `npm run build`).

```bash
npm run cte
```

Debug emitted SQL: `npm run cte:debug` (`TYPHEX_DEBUG=1`).

Compiled output goes to `examples/out/cte/cte.js` (gitignored); `npm run cte` rebuilds it automatically.
