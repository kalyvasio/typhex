# Bulk Operations

## insertMany

Insert multiple rows in a single SQL statement:

```ts
await Product.query().insertMany([
  { sku: "W-001", name: "Widget", price: 999, stock: 100 },
  { sku: "G-001", name: "Gadget", price: 1499, stock: 50 },
  { sku: "D-001", name: "Doohickey", price: 249, stock: 200 },
]);
```

```sql
INSERT INTO products (sku, name, price, stock)
VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)
-- params: ["W-001", "Widget", 999, 100, "G-001", "Gadget", 1499, 50, "D-001", "Doohickey", 249, 200]
```

`insertMany` returns the inserted rows on PostgreSQL (where `RETURNING` is available). On SQLite, it returns an empty array — use a follow-up query if you need the inserted rows.

## onConflict

Both `insert()` and `insertMany()` support conflict resolution via `.onConflict(columns)`:

### doNothing

Skip rows that violate a unique constraint:

```ts
await Product.query()
  .insertMany([
    { sku: "W-001", name: "Updated", price: 888, stock: 999 }, // skipped (sku exists)
    { sku: "T-001", name: "Thingamajig", price: 599, stock: 75 }, // inserted
  ])
  .onConflict(["sku"])
  .doNothing();
```

```sql
INSERT INTO products (sku, name, price, stock) VALUES (?, ?, ?, ?), (?, ?, ?, ?)
ON CONFLICT (sku) DO NOTHING
```

### doUpdate (upsert)

Update all non-conflict columns when a clash is detected:

```ts
await Product.query()
  .insert({ sku: "W-001", name: "Widget v2", price: 1099, stock: 80 })
  .onConflict(["sku"])
  .doUpdate();
```

```sql
INSERT INTO products (sku, name, price, stock) VALUES (?, ?, ?, ?)
ON CONFLICT (sku) DO UPDATE SET
  name = excluded.name,
  price = excluded.price,
  stock = excluded.stock
```

### doUpdate with specific columns

Update only specified columns, leaving the rest unchanged:

```ts
await Product.query()
  .insert({ sku: "G-001", name: "Renamed (ignored)", price: 1799, stock: 0 })
  .onConflict(["sku"])
  .doUpdate(["price"]); // only price is updated; name stays as-is
```

```sql
INSERT INTO products (sku, name, price, stock) VALUES (?, ?, ?, ?)
ON CONFLICT (sku) DO UPDATE SET price = excluded.price
```

### Bulk upsert

Combine `insertMany` with `onConflict` for price-list style updates:

```ts
await Product.query()
  .insertMany([
    { sku: "W-001", name: "irrelevant", price: 500, stock: 0 },
    { sku: "Z-001", name: "Zapper", price: 3999, stock: 10 },
  ])
  .onConflict(["sku"])
  .doUpdate(["price"]);
// W-001's price is updated to 500; Z-001 is inserted as new
```

```sql
INSERT INTO products (sku, name, price, stock) VALUES (?, ?, ?, ?), (?, ?, ?, ?)
ON CONFLICT (sku) DO UPDATE SET price = excluded.price
```

## insertGraph

`insertGraph` inserts an entire object graph — related entities and junction rows — in the correct dependency order. You pass a plain object shaped like your entity with its relations nested inside:

### manyToOne parent

Provide the parent as a nested object — Typhex inserts it first and wires the foreign key automatically:

```ts
const post = await Post.query().insertGraph({
  title: "Hello",
  author: { name: "Alice" },
});
```

```sql
-- 1. Parent first
INSERT INTO users (name) VALUES (?)              -- params: ["Alice"]

-- 2. Root with foreign key wired in
INSERT INTO posts (title, authorId) VALUES (?, ?) -- params: ["Hello", 1]
```

### oneToMany children

Provide children as an array — Typhex inserts the root first and back-fills the foreign key on each child:

```ts
const user = await User.query().insertGraph({
  name: "Alice",
  posts: [{ title: "First post" }, { title: "Second post" }],
});
```

```sql
-- 1. Root first
INSERT INTO users (name) VALUES (?)                  -- params: ["Alice"]

-- 2. Children batched, with authorId auto-filled
INSERT INTO posts (title, authorId) VALUES (?, ?), (?, ?)
-- params: ["First post", 1, "Second post", 1]
```

### manyToMany

Mix new records with references to existing ones using `{ id: existingId }`:

```ts
const existingTag = await Tag.query().findById(1);

const post = await Post.query().insertGraph({
  title: "Hello",
  author: { name: "Alice" },
  tags: [
    { id: existingTag.id }, // link existing tag
    { name: "new-tag" }, // insert new tag
  ],
});
```

```sql
INSERT INTO users (name) VALUES (?)              -- author
INSERT INTO posts (title, authorId) VALUES (?, ?) -- root post
INSERT INTO tags (name) VALUES (?)               -- only the new tag is inserted

-- Junction rows for both existing + new tag
INSERT INTO post_tags (postId, tagId) VALUES (?, ?), (?, ?)
```

### Batch insert

Pass an array to insert multiple graphs at once:

```ts
const users = await User.query().insertGraph([
  { name: "Alice", posts: [{ title: "A-1" }, { title: "A-2" }] },
  { name: "Bob", posts: [{ title: "B-1" }] },
]);
```

```sql
-- Roots batched
INSERT INTO users (name) VALUES (?), (?)         -- ["Alice", "Bob"]

-- All children batched, foreign keys back-filled
INSERT INTO posts (title, authorId) VALUES (?, ?), (?, ?), (?, ?)
-- ["A-1", 1, "A-2", 1, "B-1", 2]
```

### With a transaction

`insertGraph` participates in an existing transaction:

```ts
await db.transaction(async (trx) => {
  await Post.query(trx).insertGraph({
    title: "Atomic post",
    author: { name: "Dave" },
    tags: [{ name: "typescript" }],
  });
});
```

If any insert in the graph fails, the transaction rolls back the entire graph.
