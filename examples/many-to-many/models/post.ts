import { Entity, rel, type ManyToMany } from "../../../src/index.js";
import { Tag } from "./tag.js";

export class Post extends Entity(
  "posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
  },
  {
    tags: rel.manyToMany(() => Tag, {
      junction: "post_tags",
      foreignKey: "postId",
      referenceKey: "tagId",
    }),
  },
) {
  declare tags: ManyToMany<Tag>;
}
