# Subquery follow-ups

## Context

The four subquery shapes in `SUBQUERY_ROADMAP.md` (IN, scalar SELECT, WHERE
aggregate-comparison, ORDER BY) all ship as transformer-only paths and are
covered by compile-level unit tests. Three gaps remain that I'd want closed
before declaring the feature surface fully done.

---

## 1. Destructured outer params don't correlate

### Problem

```ts
Author.query().select(({ id, name }) => ({
  count: Post.query().where(p => p.authorId === id).count(),  // bails today
}));
```

The select-transformer plumbs the outer arrow's bound row name (always `"u"`
for destructured patterns — see `select-transformer.ts:43–80`
`getParamBindings`) as the correlation outer-param. Inside the inner WHERE,
the bare identifier `id` doesn't match that name, so it falls through to
`identifierToIr` (`where-transformer.ts:233`), gets added to `freeVars`, and
the whole subquery extraction bails.

### Fix

When the outer select-arrow uses a destructured pattern, the transformer
already builds a `bindings: Map<string, string[]>` mapping each local
(`id`, `name`) to its source path (`["id"]`, `["name"]`). Plumb that map
into `parseWhereArrowToIr` and have `identifierToIr` consult it: if a bare
identifier matches a destructured local, emit `IrMember{ param: "u",
path: bindings[name] }` instead of an `IrParam` + freeVar.

### Files

- `src/transformer/where-transformer.ts` — extend `parseWhereArrowToIr`
  signature with an optional `outerBindings?: Map<string, string[]>`;
  thread into `arrowToIr` → `exprToIr` → `identifierToIr`. Treat a bare
  identifier hit as `IrMember{ param: pb.paramName, path: bindings.get(name)! }`.
- `src/transformer/subquery-extract.ts` — accept and forward
  `outerBindings` parameter on `tryExtractInlineSubqueryAggregate`.
- `src/transformer/select-transformer.ts:parseSelectObjectProperty` —
  pass `pb.bindings ?? undefined` along with the existing `[pb.paramName]`.
- (Same for the IN-form `tryExtractInlineSubquery` in
  `src/transformer/where-transformer.ts:66` — the outer where-arrow can
  also be destructured. `binaryExprToIr` would need the outer bindings,
  which means `arrowToIr` for where also needs to compute them. Defer
  this if the outer-where destructure case is rare.)

### Tests

Two new transformer snapshot tests in
`tests/transformer/select-transformer.test.ts`:

- `({ id }) => ({ c: Post.query().where(p => p.authorId === id).count() })`
- `({ id: authorId }) => ({ c: Post.query().where(p => p.authorId === authorId).count() })`

Plus one compile-level test in `tests/dbs/subquery-correlated.test.ts`
verifying the resulting IR compiles to the right SQL (the IR shape
should match the non-destructured case).

---

## 2. Real-DB integration tests

### Problem

All current subquery tests are compile-level (assert SQL string + params
array). No test runs the resulting SQL against a real database. Possible
this works for the unit tests but produces wrong results due to schema
mismatches, dialect quirks, or planner surprises.

### Fix

Add a scenarios test that exercises each of the four subquery shapes
end-to-end against an in-memory SQLite (always available locally) and
optionally against the dockerized Postgres used by `pnpm test:postgres`.

### Files

- New: `tests/integration/scenarios-subquery.test.ts` — model after the
  existing `tests/integration/scenarios.test.ts` (same fixture pattern,
  in-memory SQLite). Cover:
  - Non-correlated `count()` in SELECT.
  - Correlated `Post.query().where(p => p.authorId === a.id).count()` in
    SELECT — assert per-row counts match a hand-computed expectation.
  - Correlated subquery comparison in WHERE: `count() > N`.
  - Correlated subquery in ORDER BY (verify row order matches expected).
  - WHERE IN inline subquery (the original feature, currently only
    compile-tested).
- New: `tests/integration/scenarios-subquery-postgres.test.ts` — same
  scenarios, gated behind `TYPHEX_POSTGRES_URL` like
  `tests/integration/scenarios-postgres.test.ts`.

Use `Author` + `Post` entities (or mirror whatever shape the existing
scenarios files use) — the schema and seed-data utilities should already
be reusable.

### Verification

- `pnpm test:sqlite` includes the new sqlite scenarios file.
- `pnpm test:postgres` runs the postgres scenarios. Local docker:
  `docker compose up -d postgres` (if a compose file exists) or set
  `TYPHEX_POSTGRES_URL` to a running instance.

---

## 3. `.limit() / .offset() / .distinct()` on subquery chains (lower priority)

### Problem

The aggregate extractor only matches `Entity.query()[.where(fn)].<aggMethod>(...)`.
Common shapes that aren't recognized:

- `Post.query().where(...).limit(10).count()` — bounded count.
- `Post.query().where(...).distinct(p => p.x).count()` — DISTINCT count.
- `Post.query().where(...).orderBy(...).limit(1).select(p => p.id)` for an
  IN-subquery — top-N membership.

Today these return null from the extractor and fall through to runtime
arrow parsing (which also can't handle them). Users hit the failure mode
silently — no clear error message.

### Fix

This is more of a feature addition than a bug fix. Two paths:

- **Short-term**: detect these shapes in the extractor and emit a clear
  diagnostic (`throw new Error("[typhex] subquery chains do not yet support .limit/.distinct — use a separate query or a derived table")`). Avoids silent fallback.
- **Long-term**: extend `IrSubquery` with `limitNum?`, `offsetNum?`,
  `distinct?` fields; update `compileSubqueryExpr` to emit them.
  `compileInNode`-style usage already supports `selectCol`; aggregate
  usage would add `LIMIT/OFFSET` after the `WHERE` clause and `DISTINCT`
  inside the aggregate function.

### Files

- `src/ir/types.ts` — add optional fields to `IrSubquery`.
- `src/transformer/subquery-extract.ts` — walk additional chain
  segments (`.limit(n)` / `.offset(n)` literal-only, `.distinct(p => p.col)`).
- `src/transformer/where-transformer.ts:tryExtractInlineSubquery` —
  same for the IN form.
- `src/dbs/shared-dialect.ts:compileSubqueryExpr` — append `LIMIT/OFFSET`
  to the emitted SQL; respect `distinct: true` inside the projection.

### Tests

- Compile-level tests in `tests/dbs/subquery-select.test.ts` and
  `tests/dbs/subquery-in.test.ts` for each new field.
- Transformer snapshot tests for the new chain shapes.

---

## Order of work

1. **#1** (destructured params) — small, real correctness fix; do this
   first.
2. **#2** (integration tests) — verifies the existing implementation
   against real engines. Lands a useful safety net for #3 work and
   future subquery refactors.
3. **#3** (limit/offset/distinct) — feature work, optional; gate on
   demand.