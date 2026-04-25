# SQLite Driver

## Setup

```ts
import { Db, createSqliteDriver } from "typhex";

const db = new Db(createSqliteDriver({ path: "./app.db" }));
```

Use `":memory:"` for an in-memory database (created fresh, discarded on close — useful for tests):

```ts
const db = new Db(createSqliteDriver({ path: ":memory:" }));
```

## Options

| Option | Type | Description |
|--------|------|-------------|
| `path` | `string` | Path to the `.db` file, or `":memory:"` |

## Installation

```bash
npm install better-sqlite3
```

`better-sqlite3` includes a native C++ addon. If installation fails, install the appropriate build tools:

- **macOS:** `xcode-select --install`
- **Linux:** `apt install build-essential` (or distro equivalent)
- **Windows:** Visual Studio Build Tools
