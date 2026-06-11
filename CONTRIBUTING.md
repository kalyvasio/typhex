# Contributing to Typhex

Thanks for your interest in contributing. Typhex is open source and accepts pull requests from forks.

## Before you start

- Read the [README](README.md) and relevant docs under [`docs/`](docs/).
- Search [existing issues](https://github.com/kalyvasio/typhex/issues) and open PRs to avoid duplicate work.
- For large changes, open an issue first so we can agree on direction.

## Fork and clone

1. Fork [kalyvasio/typhex](https://github.com/kalyvasio/typhex) on GitHub.
2. Clone your fork and add upstream:

```bash
git clone https://github.com/<your-username>/typhex.git
cd typhex
git remote add upstream https://github.com/kalyvasio/typhex.git
```

3. Create a branch from an up-to-date `main`:

```bash
git fetch upstream
git checkout -b my-feature upstream/main
```

## Development setup

Requirements:

- Node.js 18 or later
- npm (used by CI)

Install dependencies:

```bash
npm ci
```

Build:

```bash
npm run build
```

## Running tests

Most changes can be validated with SQLite and transformer tests (no external services):

```bash
npm run test:sqlite
npm run test:transformer
```

Optional lint and format checks:

```bash
npm run lint
npm run format:check
```

Or run the combined check:

```bash
npm run check
```

### PostgreSQL tests (optional)

PostgreSQL tests are not required for every change, but run them when you touch Postgres-specific code.

Start Postgres locally (port `5433` by default), then:

```bash
export TYPHEX_POSTGRES_URL=postgresql://postgres:postgres@localhost:5433/typhex_test
npm run test:postgres
```

CI runs the full matrix (SQLite, transformer, and PostgreSQL). Your PR must pass the required `CI` check before merge.

## Submitting a pull request

1. Push your branch to **your fork** (not upstream):

```bash
git push origin my-feature
```

2. Open a pull request against `kalyvasio/typhex` → `main`.
3. Fill in the PR template checklist.
4. Keep the PR focused. Prefer several small PRs over one large one.

### First-time contributors

If this is your first contribution, a maintainer may need to approve CI workflow runs on your PR before checks start. That is normal for public repositories.

### After review

Address feedback with new commits on the same branch. Do not force-push unless a maintainer asks you to rebase.

## Code guidelines

- Match existing style in the files you touch.
- Keep changes surgical: only modify what the task requires.
- Add or update tests when behavior changes.
- Update docs when you change user-facing behavior or public API.

Before opening a PR, run at minimum:

```bash
npx tsc --noEmit
npm run test:sqlite
npm run test:transformer
```

## Questions

Open a [GitHub issue](https://github.com/kalyvasio/typhex/issues) for bugs, questions, or feature proposals.
