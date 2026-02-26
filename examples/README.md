# Typhex examples

All examples use the `Entity()` API with schema-inferred types. Three variants: **basic** (runtime parsing), **entity** (relations + lifecycle hooks), and **transformer** (compile-time, auto-captures closures).

From the **examples** directory, install dependencies once, then use the scripts below.

```bash
cd examples
npm install
```

---

## 1. Basic example (runtime parsing)

Defines entities with `Entity()`, queries with arrow functions parsed at runtime by Acorn. Closure variables must be passed explicitly as the second argument to `.where()`.

```bash
npm run basic
```

Or from the project root: `npx tsx examples/basic.ts`

---

## 2. Entity example (relations + lifecycle hooks)

Extends the basic pattern with relations (`rel.manyToOne`), subclasses for lifecycle hooks (`beforeSave`, custom getters), and instance `save()` / `delete()`.

```bash
npm run entity
```

Or from the project root: `npx tsx examples/entity-usage.ts`

---

## 3. Transformer example (compile-time)

Uses the TypeScript transformer so predicates are compiled to IR at build time. Closure variables are captured automatically; no second argument to `.where()`. Select lambdas like `(u) => ({ id: u.id })` are also compiled.

**Prerequisites**: from the repo root, run `npm install` once.

```bash
npm run transformer
```

This builds typhex, patches TypeScript, compiles via `tsconfig.transformer.json`, and runs the output.

---
