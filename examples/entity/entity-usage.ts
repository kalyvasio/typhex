/**
 * Entity() usage: schema-inferred types, relations, lifecycle hooks, save/delete.
 * Run: npm run entity  or  npx tsx examples/entity/entity-usage.ts
 */

import { Db, Entity, rel, createSqliteDriver } from "../../src/index.js";

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  email: "text",
  age: "integer",
  createdAt: "datetime not null",
});

const Post = Entity(
  "posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
    body: "text",
    authorId: "integer not null",
    published: "boolean",
    createdAt: "datetime not null",
  },
  {
    author: rel.manyToOne(() => User, { foreignKey: "authorId" }),
  }
);

class UserEntity extends User {
  get displayName() {
    return this.name ?? this.email ?? "Anonymous";
  }

  beforeSave() {
    if (!this.createdAt) this.createdAt = new Date();
  }
}

class PostEntity extends Post {
  get excerpt() {
    const b = this.body;
    return b != null ? String(b).slice(0, 80) + "..." : "";
  }

  beforeSave() {
    if (!this.createdAt) this.createdAt = new Date();
  }
}

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

const alice = await User.query().insert({
  name: "Alice",
  email: "alice@example.com",
  age: 30,
  createdAt: new Date(),
});
console.log("Created user:", alice.name, "id:", alice.id);

const bob = await User.query().insert({
  name: "Bob",
  age: 25,
  createdAt: new Date(),
});

const post1 = await Post.query().insert({
  title: "First post",
  body: "Hello world.",
  authorId: alice.id!,
  published: true,
  createdAt: new Date(),
});
const post2 = await Post.query().insert({
  title: "Draft",
  body: "Work in progress...",
  authorId: bob.id!,
  published: false,
  createdAt: new Date(),
});

console.log("Posts:", post1.title, post2.title);

const allUsers = await User.query().toArray();
console.log("All users:", allUsers.length);

const adults = await UserEntity.query().where((u) => u.age > 18).toArray();
console.log("Adults (age > 18):", adults.length);
const user = await UserEntity.query().where((u) => u.age > 18).first();
console.log("user displayname:", user?.displayName ?? "n/a");

const firstPost = await Post.query().where((p) => p.published === true).first();
console.log("First published post:", firstPost?.title ?? "none");

const found = await User.query().findByPk(alice.id!);
console.log("Found by id:", found?.name ?? "null");

const newUser = new UserEntity({
  name: "Carol",
  email: "carol@example.com",
  age: 28,
  createdAt: new Date(),
});
await newUser.query().save();
console.log("Saved new user id:", newUser.id);

await db.close();
console.log("Done.");
