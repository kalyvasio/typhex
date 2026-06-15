# Changelog

All notable changes to Typhex will be documented in this file.

Typhex follows semantic versioning for the documented public API. During the
0.x series, APIs may still change while the package is being hardened.

## Unreleased

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
