# PostgreSQL Driver

## Setup

```ts
import { Db, createPostgresDriver } from "typhex";

const db = new Db(
  createPostgresDriver({
    connectionString: process.env.TYPHEX_POSTGRES_URL!,
  }),
);
```

## Options

| Option             | Type     | Description                                                              |
| ------------------ | -------- | ------------------------------------------------------------------------ |
| `connectionString` | `string` | Standard PostgreSQL URI: `postgresql://user:password@host:port/database` |

## Installation

```bash
npm install pg
```

The driver uses `pg.Pool` internally; call `db.close()` on shutdown to release pool connections.

## Column Types

Use PostgreSQL-native types in your schema:

```ts
const User = Entity("users", {
  id: "SERIAL PRIMARY KEY",
  name: "VARCHAR(255) NOT NULL",
  age: "INTEGER NOT NULL",
});
```

The query API (`where`, `insert`, `select`, etc.) is identical to SQLite — only the driver and column types differ.
