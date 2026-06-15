# Release Checklist

Use this checklist before tagging a production release.

## API

- Run `npm run api:check` and confirm `etc/typhex.api.md` is unchanged. If the public surface changed intentionally, run `npm run api:update`, review the diff, and commit it alongside the change.
- Confirm `docs/public-api.md` matches `package.json` exports and `src/index.ts`.
- Confirm new exports are documented with examples.
- Confirm internal helpers are not required for common application usage.
- Add a migration guide for any breaking public API change.
- Update `CHANGELOG.md` with user-visible changes and any compatibility notes.

## Compatibility

- Run the full test suite on the supported Node.js versions.
- Run SQLite tests with the bundled `better-sqlite3` driver.
- Run PostgreSQL integration tests with `TYPHEX_POSTGRES_URL` set.
- Verify runtime parser mode and transformer mode.

## Package

- Run `npm run release:check`.
- Run `npm run pack:check` and inspect the tarball contents.
- Verify `dist/index.d.ts`, `dist/transformer/index.d.ts`, `dist/sqlite.d.ts`, and `dist/postgres.d.ts` are present.
- Verify the CLI entry `dist/migration/cli.js` exists and is executable.
- Verify `LICENSE`, `README.md`, `CHANGELOG.md`, and `SECURITY.md` are included.
- Verify source maps are generated or intentionally omitted.
- Publish with npm provenance enabled.

## Publish

- Confirm the Git tag matches the package version exactly: `v${package.json.version}`.
- Push the tag to trigger `.github/workflows/release.yml`.
- Configure npm authentication before the first tag-triggered release:
  - preferred: npm trusted publishing for this repository/workflow; or
  - fallback: an `NPM_TOKEN` GitHub Actions secret with publish permissions.
- Prerelease versions such as `0.1.0-alpha.0` publish with the npm `alpha` dist-tag.
- Stable versions publish with the npm `latest` dist-tag.
- The release workflow skips npm publish and GitHub release creation when the version/tag already exists, so reruns are safe after partial failures.

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
