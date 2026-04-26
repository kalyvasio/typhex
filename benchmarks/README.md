# Performance Benchmarks

Run the local SQLite benchmark suite:

```bash
npm run bench
```

The suite uses an in-memory SQLite database and reports elapsed time plus
rows/second for representative ORM paths:

- `insertMany`
- relation loading
- aggregation with `groupBy` / `having`
- large offset pagination
- `insertGraph`

These numbers are intended for regression tracking, not machine-independent
absolute performance claims. Run on the same machine and Node.js version when
comparing branches.
