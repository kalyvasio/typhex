# Release Checklist

Use this checklist before tagging a production release.

## API

- Run `pnpm run api:check` and confirm `etc/typhex.api.md` is unchanged. If the public surface changed intentionally, run `pnpm run api:update`, review the diff, and commit it alongside the change.
- Confirm `docs/public-api.md` matches `package.json` exports and `src/index.ts`.
- Confirm new exports are documented with examples.
- Confirm internal helpers are not required for common application usage.
- Add a migration guide for any breaking public API change.

## Compatibility

- Run the full test suite on the supported Node.js versions.
- Run SQLite tests with the bundled `better-sqlite3` driver.
- Run PostgreSQL integration tests with `TYPHEX_POSTGRES_URL` set.
- Verify runtime parser mode and transformer mode.

## Package

- Run `npm pack` and inspect the tarball contents.
- Verify `dist/index.d.ts`, `dist/transformer/index.d.ts`, `dist/sqlite.d.ts`, and `dist/postgres.d.ts` are present.
- Verify the CLI entry `dist/migration/cli.js` exists and is executable.
- Verify source maps are generated or intentionally omitted.

## Migrations

- Generate a migration from a clean database.
- Apply pending migrations.
- Check migration status.
- Run a no-op generate/status cycle after applying.
- For PostgreSQL, verify generated SQL against a real database.

## Documentation

- README quick start uses the current `Entity` API.
- Examples cover SQLite, PostgreSQL, relations, many-to-many, transactions, aggregations, and migrations.
- Known limitations are listed explicitly.
- Transformer setup includes TypeScript version expectations.
