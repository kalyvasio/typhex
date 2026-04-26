import { createRequire } from "node:module";
import { Entity, rel, type ManyToOne, type OneToMany } from "../../../src/index.js";
import type { User } from "./user.js";
import type { Comment } from "./comment.js";

const _require = createRequire(import.meta.url);

export class Post extends Entity(
  "posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
    body: "text",
    authorId: "integer not null",
    published: "boolean",
  },
  {
    author: rel.manyToOne(() => _require("./user.js").User, { foreignKey: "authorId" }),
    comments: rel.oneToMany(() => _require("./comment.js").Comment, { foreignKey: "postId" }),
  },
) {
  declare author: ManyToOne<User>;
  declare comments: OneToMany<Comment>;
}
