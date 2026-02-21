# Typhex examples

Two ways to run queries with Typhex: **runtime parsing** (works everywhere) and **compile-time transformer** (TypeScript only, auto-captures closure variables).

From the **examples** directory, install dependencies once, then use the scripts below. No symlinks or global tools required.

```bash
cd examples
npm install
```

---

## 1. Basic example (runtime parsing)

Uses the runtime parser: arrow functions are stringified and parsed with Acorn. Closure variables must be passed explicitly as the second argument to `.where()`.

**From the examples directory:**

```bash
npm run basic
```

Or from the project root (without using examples/package.json):

```bash
npx tsx examples/basic.ts
```

The example imports from `../src/index.js`, so it runs against the project source.

---

## 2. Transformer example (compile-time)

Uses the TypeScript transformer so predicates are compiled to IR at build time. Closure variables are captured automatically; no second argument to `.where()`.

**Prerequisites**

- From the repo root, run `npm install` once so the main package is built. TypeScript and ts-patch are only used from the **examples** folder (they are devDependencies there).

**Run the example (from the examples directory)**

1. Install and build (first time or after changing typhex):
   ```bash
   cd examples
   npm install
   npm run transformer
   ```
   This builds typhex from the root, then runs `ts-patch install` and `tsc` from the **examples** directory (using `examples/tsconfig.transformer.json`), producing `out/with-transformer.js`, then runs it. The `typhex` dependency is satisfied by `"typhex": "file:.."` in this folder’s `package.json`, so no manual symlink is needed.

2. To only compile and run separately:
   ```bash
   npm run build:transformer
   npm run start:transformer
   ```

---
