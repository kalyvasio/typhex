# Changelog

All notable changes to Typhex will be documented in this file.

Typhex follows semantic versioning for the documented public API. During the
0.x series, APIs may still change while the package is being hardened.

## Unreleased

## 0.1.0-alpha.2 - 2026-08-30

- Query terminals (`toArray`, `first`, `count`, `findById`, `update`, `delete`, and inserts) now return a lazy `Statement`: `await` to execute, `.toSql()` to compile without running.
- Add `TYPHEX_COMPILE_ONLY` to compile queries without a live database.
- Query builder chains are immutable.
- Nested queries are planned before SQL compilation.
- `Db` can own an explicit `entities` collection for migrate/validate/generate; the process registry remains the fallback.
- Keep `update()` and `patch()` as distinct operations.
- Remove pre-release compatibility aliases.
- Bump `better-sqlite3`, `pg`, and `acorn`.

## 0.1.0-alpha.1 - 2026-06-15

- Switch release workflow to npm Trusted Publishing (OIDC) instead of `NPM_TOKEN`.

## 0.1.0-alpha.0 - 2026-06-15

- Initial public alpha preview.
- Added release hardening metadata and package verification scripts.
- Added CI quality gates for linting, formatting, API compatibility, coverage,
  and package dry-runs.
- Added an explicit MIT license file.
- Added a production dependency audit gate for release checks.
- Added deterministic parser/compiler fuzz coverage across SQLite and PostgreSQL
  SQL compilation.
- Upgraded Vitest and coverage tooling to remove critical dev audit findings.
