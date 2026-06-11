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

| Option                | Type       | Description                                                              |
| --------------------- | ---------- | ------------------------------------------------------------------------ |
| `connectionString`    | `string`   | Standard PostgreSQL URI: `postgresql://user:password@host:port/database` |
| `url`                 | `string`   | Alias for `connectionString`, useful in config files                     |
| `host`                | `string`   | Hostname when not using a connection string                              |
| `port`                | `number`   | Port, default `5432`                                                     |
| `database`            | `string`   | Database name, default `"postgres"`                                      |
| `user`                | `string`   | Database user                                                            |
| `password`            | `string`   | Database password                                                        |
| `ssl`                 | `pg` value | SSL config forwarded to `pg`                                             |
| `poolMin`             | `number`   | Minimum pool connections, default `2`                                    |
| `poolMax`             | `number`   | Maximum pool connections, default `10`                                   |
| `idleTimeoutMs`       | `number`   | Idle connection timeout in milliseconds, default `30000`                 |
| `connectionTimeoutMs` | `number`   | Pool connection timeout in milliseconds, default `5000`                  |
| `statementTimeoutMs`  | `number`   | PostgreSQL `statement_timeout` in milliseconds                           |
| `logger`              | `object`   | Custom pool error logger with an `error(message, err)` method            |

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
