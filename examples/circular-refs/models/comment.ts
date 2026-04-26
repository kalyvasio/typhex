import { createRequire } from "node:module";
import { Entity, rel, type ManyToOne } from "../../../src/index.js";
import type { Post } from "./post.js";

const _require = createRequire(import.meta.url);

export class Comment extends Entity(
  "comments",
  {
    id: "integer primary key autoincrement",
    body: "text",
    postId: "integer not null",
  },
  {
    post: rel.manyToOne(() => _require("./post.js").Post, { foreignKey: "postId" }),
  },
) {
  declare post: ManyToOne<Post>;
}
