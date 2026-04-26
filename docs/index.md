---
layout: home

hero:
  name: Typhex
  text: Arrow-function queries for TypeScript
  tagline: Type-safe SQL without string templates or verbose builders. Write predicates like TypeScript — Typhex compiles them to safe, parameterized SQL at build time.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/kalyvasio/typhex

features:
  - title: Arrow-Function Predicates
    details: Write `users.where(u => u.age > 18)` — no string templates, no SQL injection, no verbose builder syntax. Predicates compile to SQL at build time via the TypeScript transformer.
  - title: TypeScript-Native
    details: Types flow from your schema definition — no decorators, no code generation. The compiler plugin auto-captures closure variables so there's no boilerplate at the call site.
  - title: Relations & Joins
    details: Declare `manyToOne`, `oneToMany`, and `manyToMany` relations. Reference them in `where()` for automatic JOINs and `select()` for eager loading — never N+1.
  - title: Aggregations
    details: Full GROUP BY / HAVING support with `sum()`, `avg()`, `min()`, `max()`, `count()`, `distinct()`, and `groupConcat()`. Filter groups with arrow-function `having()` predicates.
  - title: Transactions
    details: Callback API with implicit AsyncLocalStorage propagation. Explicit API for service-layer patterns. Nested savepoints. Configurable isolation levels.
  - title: SQLite + PostgreSQL
    details: Built-in drivers for both databases. Bulk inserts, upserts (`onConflict`), and `insertGraph` for nested object graphs. The query API is identical across drivers.
---
