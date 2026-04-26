# Entities & Relations

## The `Entity()` Factory

`Entity()` creates a base class for a database table. The second argument is the schema — a map from column name to SQL type string.

```ts
import { Entity, rel } from "typhex";

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  email: "text",
  age: "integer",
  createdAt: "datetime not null",
});
```

TypeScript infers the row shape from the schema, so `User` instances are typed — no separate interface declaration required.

## Defining Relations

Pass a third argument to `Entity()` to declare relations. Use the `rel` helper:

```ts
const Post = Entity(
  "posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
    authorId: "integer not null",
    createdAt: "datetime not null",
  },
  {
    author: rel.manyToOne(() => User, { foreignKey: "authorId" }), // [!code highlight]
  }
);
```

The target entity is passed as a thunk (`() => User`) to allow forward-references when entities are defined in separate files or have circular references.

### Relation helpers

| Helper | Direction | What it means |
|--------|-----------|---------------|
| `rel.manyToOne(() => Target, { foreignKey })` | N:1 | This table holds the foreign key |
| `rel.oneToMany(() => Target, { foreignKey })` | 1:N | The other table holds the foreign key |
| `rel.oneToOne(() => Target, { foreignKey })` | 1:1 | FK on this table; loads a single related row |
| `rel.manyToMany(() => Target, { junction, foreignKey, referenceKey })` | M:N | Via a junction table |

## One-to-One Relations

Use `rel.oneToOne()` when each row has at most one related row. The FK lives on this entity's table:

```ts
const UserProfile = Entity("user_profiles", {
  id: "integer primary key autoincrement",
  userId: "integer not null unique",
  bio: "text",
});

const User = Entity("users",
  { id: "integer primary key autoincrement", name: "text not null" },
  { profile: rel.oneToOne(() => UserProfile, { foreignKey: "userId" }) }
);

// Load the profile alongside the user
const users = await User.query()
  .select((u) => ({ id: u.id, name: u.name, profile: u.profile }))
  .toArray();
```

```sql
-- 1. Main query
SELECT id AS id, name AS name FROM users

-- 2. Relation fetch (one round-trip, regardless of result count)
SELECT id, userId, bio FROM user_profiles WHERE userId IN (?, ?, ...)
```

## Many-to-Many Relations

A `manyToMany` relation works through a junction table that you manage directly in SQL (Typhex doesn't auto-migrate junction tables):

```ts
import { Entity, rel, type ManyToMany } from "typhex";
import { Tag } from "./tag.js";

export class Post extends Entity("posts",
  { id: "integer primary key autoincrement", title: "text not null" },
  {
    tags: rel.manyToMany(() => Tag, {
      junction: "post_tags",   // junction table name
      foreignKey: "postId",    // column pointing to this entity
      referenceKey: "tagId",   // column pointing to the target
    }),
  }
) {
  declare tags: ManyToMany<Tag>; // needed when Post and Tag are in separate files
}
```

Create the junction table manually (once):

```ts
await db.run("CREATE TABLE post_tags (postId INTEGER NOT NULL, tagId INTEGER NOT NULL)");
```

Then use it like any other relation in `select()`:

```ts
const posts = await Post.query()
  .select((p) => ({
    id: p.id,
    title: p.title,
    tags: p.tags.query().select((t) => ({ name: t.name })).orderBy((t) => t.name, "asc"),
  }))
  .toArray();
```

```sql
-- 1. Main query
SELECT id AS id, title AS title FROM posts

-- 2. Junction + target fetched together
SELECT post_tags.postId, tags.name AS name
FROM post_tags
JOIN tags ON tags.id = post_tags.tagId
WHERE post_tags.postId IN (?, ?, ...)
ORDER BY tags.name ASC
```

## Composite Primary Keys

When a table's primary key spans multiple columns, mark each column with `"primary key"` in the schema. Relations accept an array for composite foreign keys:

```ts
const Project = Entity(
  "projects",
  {
    tenantId:  "text primary key",
    projectId: "text primary key",
    name:      "text not null",
  },
  {
    tasks: rel.oneToMany(() => Task, { foreignKey: ["tenantId", "projectId"] }),
  }
);

const Task = Entity(
  "tasks",
  { id: "integer primary key autoincrement", tenantId: "text not null",
    projectId: "text not null", title: "text not null" },
  { project: rel.manyToOne(() => Project, { foreignKey: ["tenantId", "projectId"] }) }
);
```

`findById` accepts an object for composite keys:

```ts
const project = await Project.query().findById({ tenantId: "acme", projectId: "p1" });
```

```sql
SELECT tenantId, projectId, name FROM projects
WHERE tenantId = ? AND projectId = ?
LIMIT 1
-- params: ["acme", "p1"]
```

::: warning SQLite DDL
SQLite doesn't allow two `PRIMARY KEY` column constraints in one `CREATE TABLE`. Use `db.run()` with a table-level `PRIMARY KEY (col1, col2)` clause instead of `db.migrate()` for composite-PK tables.
:::

## Custom Entity Classes

Subclass the `Entity()` result to add computed properties and lifecycle hooks. The subclass inherits all ORM methods (`.query()`, `.where()`, `.insert()`, etc.) and instances are returned by query methods.

```ts
class UserEntity extends User {
  // Computed property
  get displayName() {
    return this.name ?? this.email ?? "Anonymous";
  }

  // Lifecycle hook — called before every save()
  beforeSave() {
    if (!this.createdAt) this.createdAt = new Date();
  }
}

// Query and use the computed property
const user = await UserEntity.query().where((u) => u.age > 18).first();
console.log(user?.displayName);
```

`beforeSave()` is the only lifecycle hook. Use it to set defaults or enforce invariants — it runs before both inserts and updates.
