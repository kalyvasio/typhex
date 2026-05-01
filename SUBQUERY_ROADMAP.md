# Subquery Roadmap

## Implemented: WHERE IN Subquery

Two syntaxes both compile to `IN (SELECT ...)`:

**Params-based (runtime parser):**
```typescript
const posts = Post.query().where(p => p.active === true).select(p => p.id);
Author.query().where((a, p) => a.postId in p.posts, { posts });
```

**Inline (transformer only — acorn cannot evaluate call chains from source text):**
```typescript
Author.query().where(a => a.postId in Post.query().where(p => p.active === true).select(p => p.id));
```

`NOT IN` works automatically via the existing negated `IrIn` path:
```typescript
Author.query().where((a, p) => !(a.postId in p.posts), { posts });
```

### How it works

`IrSubquery` is a pure-data IR node — no methods, no live references, fully serializable:
```typescript
interface IrSubquery {
  kind: "subquery";
  tableName: string;
  selectCol: string;
  whereIr: IrNode | null;
  whereParams: Record<string, unknown>;
}
```

- **Runtime parser** (`parse-arrow.ts`): duck-types the param value for `toSubqueryIr()`, calls it to get `IrSubquery`.
- **Transformer** (`where-transformer.ts`): detects `EntityClass.query().where(fn).select(fn)` call chain using the TS type checker, extracts `tableName` from the static property, recursively transforms the inner `where` predicate to IR, emits a static object literal.
- **SQL compiler** (`shared-dialect.ts`): `inlineParams()` resolves `IrParam` nodes inside the subquery's `whereIr` to concrete values, then `compileNode` generates the subquery SQL using the shared outer params array (keeping `$N` numbering sequential for PostgreSQL).

---

## Implemented: Scalar subquery in SELECT — non-correlated

```typescript
Author.query().select(a => ({
  name: a.name,
  totalPosts: Post.query().count(),
  activeScore: Post.query().where(p => p.active === true).sum(p => p.score),
}));
// → SELECT "t0"."name" AS "name",
//          (SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1) AS "totalPosts",
//          (SELECT SUM("t1"."score") FROM "posts" AS "t1" WHERE ("t1"."active" = $1)) AS "activeScore"
//   FROM "authors" AS "t0"
```

Supported aggregates: `count()`, `sum(p => p.col)`, `avg`, `min`, `max`. Transformer-only path (the runtime parser would need a builder closure binding plus a params arg on `.select()` — deferred).

### How it works

- `IrSubquery` carries an optional `aggregate: { func; valueCol? }` (mutually exclusive with `selectCol`).
- `IrSelect.subqueries: Array<{ alias; subquery }>` — emitted by `select-transformer.ts` when it detects `Entity.query()[.where(fn)].<aggMethod>(...)` chains. Free-variable references in the inner WHERE bail (correlated case is #1 below).
- `compileSelectList` now returns `{ sql, params }` and threads subquery params; `executeMainQuery` re-numbers WHERE/HAVING placeholders to start after the select-list params.

---

## Implemented: Correlated scalar SELECT

```typescript
Author.query().select(a => ({
  name: a.name,
  postCount: Post.query().where(p => p.authorId === a.id).count(),
}));
// → SELECT "t0"."name" AS "name",
//          (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) AS "postCount"
//   FROM "authors" AS "t0"
```

The transformer plumbs the outer arrow's row params into the inner WHERE
parser; the resulting IrSubquery records `innerParamNames` so the compiler
remaps only inner refs to the subquery alias and keeps outer refs bound to
the surrounding `paramToAlias`. Closure-variable references still bail.

---

## Implemented: Aggregate filter in WHERE

```typescript
Author.query().where(a => Post.query().where(p => p.authorId === a.id).count() > 5);
// → SELECT * FROM "authors" AS "t0"
//   WHERE ((SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) > $1)
```

`IrSubquery` was already in the `IrNode` union, so the binary-comparison
side just needed the where-transformer's `binaryExprToIr` to fall back to
the inline-subquery extractor on either side, plus a `case "subquery":`
branch in `compileNode` (the same one used in #1) to emit the scalar SQL.

---

## Implemented: Subquery in ORDER BY

```typescript
Author.query().orderBy(a => Post.query().where(p => p.authorId === a.id).count(), "desc");
// → SELECT * FROM "authors" AS "t0"
//   ORDER BY (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) DESC
```

`IrOrderBy` was generalized from `{ param, path }` to `{ expr: IrNode }`,
so any IR expression — most commonly an `IrMember` (column) or `IrSubquery`
(scalar subquery) — can serve as the sort key. `compileOrderBy` returns
`{ sql, params }` and `executeMainQuery` renumbers placeholders so
order-by params come after select-list, where, and having.
