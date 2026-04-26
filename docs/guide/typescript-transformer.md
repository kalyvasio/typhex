# TypeScript Transformer

The TypeScript transformer is the **recommended way to use Typhex**. It runs as a compiler plugin during `tsc`, converting arrow-function predicates to IR at build time. The result: no runtime parsing overhead and no closure boilerplate at the call site.

## Setup

### 1. Install ts-patch

```bash
npm install --save-dev ts-patch
```

### 2. Configure `tsconfig.json`

```json
{
  "compilerOptions": {
    "plugins": [{ "transform": "typhex/transformer" }]
  }
}
```

### 3. Patch TypeScript (one-time)

```bash
npx ts-patch install
```

To keep the patch across reinstalls, add it as a `postinstall` script:

```json
{
  "scripts": {
    "postinstall": "ts-patch install -s"
  }
}
```

After this, `tsc` (or `tspc`) automatically applies the transformer whenever it compiles your project.

## What Changes at the Call Site

With the transformer, you **never need a second argument** to `.where()` or `.select()`. Closure variables are detected and injected automatically:

```ts
// Without transformer — runtime mode
const country = "US";
users.where((u) => u.country === country, { country }); // [!code --]

// With transformer — compiler handles it
const country = "US";
users.where((u) => u.country === country); // [!code ++]
```

Multiple variables are all captured at once:

```ts
const minAge = 25;
const maxAge = 35;

const inRange = await User.query()
  .where((u) => u.age >= minAge && u.age <= maxAge)
  .orderBy((u) => u.name, "asc")
  .toArray();
```

## Select, OrderBy, Having

The transformer handles every method that takes an arrow function — `.where()`, `.select()`, `.having()`, `.orderBy()`, `.groupBy()`:

```ts
const minRevenue = 200;

const highRevenue = await Order.query()
  .select((o) => ({ category: o.category, revenue: sum(o.price) }))
  .groupBy((o) => o.category)
  .having((o) => sum(o.price) >= minRevenue)
  .toArray();
```

## How It Works

The transformer is a TypeScript compiler plugin. At compile time it:

1. Finds every `.where()`, `.select()`, `.having()`, `.groupBy()`, and `.orderBy()` call with an arrow function
2. Parses the function body into Typhex IR using the TypeScript AST
3. Replaces the call with `.where(compiledIr, { capturedVars... })`

The compiled output is standard JavaScript with IR pre-built — no dynamic parsing at runtime.

## Runtime Mode as Fallback

If you run files directly with `tsx` (no build step), or work in a plain JavaScript codebase, Typhex falls back to the runtime Acorn parser. Closure variables must be passed explicitly:

```ts
const country = "US";
await User.query()
  .where((u) => u.country === country, { country })
  .toArray();
```

SQL output is identical either way; only the call site differs.

::: warning tsx and ts-node
`tsx` and `ts-node` do not run the TypeScript compiler pipeline, so the transformer plugin is not invoked even if configured in `tsconfig.json`. Use `tspc` (ts-patch's compiler wrapper) or a `tsc --watch` build step to get the transformer at dev time.
:::
