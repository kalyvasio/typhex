/**
 * Tests for inferred junction column types in auto-created many-to-many tables.
 *
 * The ORM auto-registers a junction entity for every `manyToMany` relation that
 * doesn't already have one. Junction column types must be inferred from the PK
 * columns they reference (positionally for composite PKs), not hard-coded.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Entity, rel } from "../../src/index.js";
import { clearRegistry, getRegisteredEntities, getEntityByTableName } from "../../src/entity/global-driver.js";

function junctionSchema(table: string): Record<string, string> {
  const e = getEntityByTableName(table);
  if (!e) throw new Error(`junction "${table}" not registered`);
  return e.table._schema;
}

describe("manyToMany junction column types — inferred from referenced PKs", () => {
  beforeEach(() => { clearRegistry(); });

  it("text PKs on both sides → junction columns are text not null", () => {
    const Tag = Entity("jct_tags_a", { id: "text primary key", name: "text not null" });
    Entity(
      "jct_posts_a",
      { id: "text primary key", title: "text not null" },
      { tags: rel.manyToMany(() => Tag, { junction: "jct_post_tags_a", foreignKey: "postId", referenceKey: "tagId" }) }
    );

    getRegisteredEntities();
    const schema = junctionSchema("jct_post_tags_a");
    expect(schema.postId).toBe("text not null");
    expect(schema.tagId).toBe("text not null");
  });

  it("mixed PK types: text source + integer target → junction columns are text and integer", () => {
    const Tag = Entity("jct_tags_b", { id: "integer primary key autoincrement", name: "text not null" });
    Entity(
      "jct_posts_b",
      { id: "text primary key", title: "text not null" },
      { tags: rel.manyToMany(() => Tag, { junction: "jct_post_tags_b", foreignKey: "postId", referenceKey: "tagId" }) }
    );

    getRegisteredEntities();
    const schema = junctionSchema("jct_post_tags_b");
    expect(schema.postId).toBe("text not null");
    expect(schema.tagId).toBe("integer not null");
  });

  it("integer PKs on both sides → junction columns are integer not null (preserves prior behavior)", () => {
    const Tag = Entity("jct_tags_int", { id: "integer primary key autoincrement", name: "text not null" });
    Entity(
      "jct_posts_int",
      { id: "integer primary key autoincrement", title: "text not null" },
      { tags: rel.manyToMany(() => Tag, { junction: "jct_post_tags_int", foreignKey: "postId", referenceKey: "tagId" }) }
    );

    getRegisteredEntities();
    const schema = junctionSchema("jct_post_tags_int");
    expect(schema.postId).toBe("integer not null");
    expect(schema.tagId).toBe("integer not null");
  });

  it("user-defined junction entity is preserved (auto-creation is a no-op)", () => {
    const Tag = Entity("jct_tags_c", { id: "integer primary key autoincrement", name: "text not null" });
    Entity("jct_post_tags_c", {
      postId: "text not null",
      tagId: "integer not null",
      addedAt: "text",
    });
    Entity(
      "jct_posts_c",
      { id: "text primary key", title: "text not null" },
      { tags: rel.manyToMany(() => Tag, { junction: "jct_post_tags_c", foreignKey: "postId", referenceKey: "tagId" }) }
    );

    getRegisteredEntities();
    const schema = junctionSchema("jct_post_tags_c");
    expect(Object.keys(schema).sort()).toEqual(["addedAt", "postId", "tagId"]);
    expect(schema.addedAt).toBe("text");
  });

  it("unresolved target throws a clear error at finalize time", () => {
    Entity(
      "jct_posts_d",
      { id: "text primary key", title: "text not null" },
      { tags: rel.manyToMany(() => undefined as any, { junction: "jct_post_tags_d", foreignKey: "postId", referenceKey: "tagId" }) }
    );

    expect(() => getRegisteredEntities()).toThrow(
      /manyToMany: cannot finalize 1 junction table\(s\)[\s\S]*jct_post_tags_d[\s\S]*target entity not registered/
    );
  });

  it("composite PK on source: junction foreignKey columns inferred positionally", () => {
    const Tag = Entity("jct_tags_e", { id: "integer primary key autoincrement", name: "text not null" });
    Entity(
      "jct_members_e",
      { tenantId: "text primary key", userId: "text primary key", display: "text not null" },
      { tags: rel.manyToMany(() => Tag, {
          junction: "jct_member_tags_e",
          foreignKey: ["tenantId", "userId"],
          referenceKey: "tagId",
        }) }
    );

    getRegisteredEntities();
    const schema = junctionSchema("jct_member_tags_e");
    expect(schema.tenantId).toBe("text not null");
    expect(schema.userId).toBe("text not null");
    expect(schema.tagId).toBe("integer not null");
  });

  it("column count mismatch (composite source, single junction fk) throws clearly", () => {
    const Tag = Entity("jct_tags_f", { id: "integer primary key autoincrement", name: "text not null" });
    Entity(
      "jct_members_f",
      { tenantId: "text primary key", userId: "text primary key", display: "text not null" },
      { tags: rel.manyToMany(() => Tag, { junction: "jct_member_tags_f", foreignKey: "memberKey", referenceKey: "tagId" }) }
    );

    expect(() => getRegisteredEntities()).toThrow(
      /junction "jct_member_tags_f" foreignKey has 1 column\(s\) but referenced entity "jct_members_f" has 2 primary key column\(s\)/
    );
  });
});
