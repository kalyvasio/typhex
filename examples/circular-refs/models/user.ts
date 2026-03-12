import { createRequire } from "node:module";
import { Entity, rel, type OneToMany } from "../../../src/index.js";
import type { Post } from "./post.js";

const _require = createRequire(import.meta.url);

export class User extends Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  email: "text",
}, {
  posts: rel.oneToMany(() => _require("./post.js").Post, { foreignKey: "authorId" }),
}) {
  declare posts: OneToMany<Post>;
}
