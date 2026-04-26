/**
 * Integration tests for composite primary key scenarios:
 *   - insert and fetch rows whose PK spans two columns
 *   - findById with a composite-key object
 *   - one-to-many relation with composite FK (Project → Tasks)
 *   - many-to-one relation with composite FK (Task → Project)
 *   - insertMany into a composite-PK table
 *
 * SQLite does not allow two `PRIMARY KEY` column constraints in the same table,
 * so tables are created with a table-level `PRIMARY KEY (col1, col2)` clause.
 * The Entity schema marks each PK column with "primary key" so getPkColumns()
 * detects the full composite set.  The ORM never calls db.migrate() for these
 * tables — we issue DDL directly via db.run().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db, Entity, rel } from "../../src/index.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";
import { freshDriver } from "../helpers.js";

// ─── Entity definitions ────────────────────────────────────────────────────────
//
// Project has a composite PK (tenantId, projectId).
// Task has a single auto-increment PK and a composite FK → Project.

const Project = Entity(
  "cpk_projects",
  {
    tenantId: "text primary key", // both marked so getPkColumns returns ["tenantId","projectId"]
    projectId: "text primary key",
    name: "text not null",
  },
  {
    tasks: rel.oneToMany(() => Task, { foreignKey: ["tenantId", "projectId"] }),
  },
);

const Task = Entity(
  "cpk_tasks",
  {
    id: "integer primary key autoincrement",
    tenantId: "text not null",
    projectId: "text not null",
    title: "text not null",
    done: "boolean",
  },
  {
    project: rel.manyToOne(() => Project, { foreignKey: ["tenantId", "projectId"] }),
  },
);

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function createTables(db: Db): Promise<void> {
  // Table-level PRIMARY KEY for composite PK (required by SQLite).
  await db.run(
    `CREATE TABLE IF NOT EXISTS "cpk_projects" (
      "tenantId"  text NOT NULL,
      "projectId" text NOT NULL,
      "name"      text NOT NULL,
      PRIMARY KEY ("tenantId", "projectId")
    )`,
  );
  await db.run(
    `CREATE TABLE IF NOT EXISTS "cpk_tasks" (
      "id"        integer PRIMARY KEY AUTOINCREMENT,
      "tenantId"  text NOT NULL,
      "projectId" text NOT NULL,
      "title"     text NOT NULL,
      "done"      integer
    )`,
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("composite PK — insert and fetch", () => {
  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(Project);
    registerEntity(Task);
    db = new Db(freshDriver());
    await createTables(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("inserts a row with composite PK and reads it back", async () => {
    await Project.query().insert({ tenantId: "acme", projectId: "p1", name: "Alpha" });

    const rows = (await Project.query().toArray()) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: "acme", projectId: "p1", name: "Alpha" });
  });

  it("findById with composite key object returns the correct row", async () => {
    await Project.query().insert({ tenantId: "acme", projectId: "p1", name: "Alpha" });
    await Project.query().insert({ tenantId: "acme", projectId: "p2", name: "Beta" });
    await Project.query().insert({ tenantId: "corp", projectId: "p1", name: "Gamma" });

    const row = (await Project.query().findById({ tenantId: "acme", projectId: "p2" })) as any;
    expect(row).not.toBeNull();
    expect(row.name).toBe("Beta");
  });

  it("findById returns null when no row matches the composite key", async () => {
    await Project.query().insert({ tenantId: "acme", projectId: "p1", name: "Alpha" });

    const row = await Project.query().findById({ tenantId: "acme", projectId: "no-such" });
    expect(row).toBeNull();
  });

  it("insertMany into composite-PK table inserts all rows", async () => {
    await Project.query().insertMany([
      { tenantId: "acme", projectId: "p1", name: "Alpha" },
      { tenantId: "acme", projectId: "p2", name: "Beta" },
      { tenantId: "corp", projectId: "p1", name: "Gamma" },
    ]);

    const count = await Project.query().count();
    expect(count).toBe(3);
  });

  it("where clause filters by one PK column", async () => {
    await Project.query().insertMany([
      { tenantId: "acme", projectId: "p1", name: "Alpha" },
      { tenantId: "acme", projectId: "p2", name: "Beta" },
      { tenantId: "corp", projectId: "p1", name: "Gamma" },
    ]);

    const rows = (await Project.query()
      .where((p: any) => p.tenantId === "acme")
      .orderBy("projectId", "asc")
      .toArray()) as any[];

    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.name)).toEqual(["Alpha", "Beta"]);
  });
});

describe("composite PK — one-to-many relation (Project → Tasks)", () => {
  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(Project);
    registerEntity(Task);
    db = new Db(freshDriver());
    await createTables(db);

    // Seed: two projects for tenant "acme", one for "corp".
    await Project.query().insertMany([
      { tenantId: "acme", projectId: "p1", name: "Alpha" },
      { tenantId: "acme", projectId: "p2", name: "Beta" },
      { tenantId: "corp", projectId: "p1", name: "Gamma" },
    ]);
    // Tasks for acme/p1
    await Task.query().insertMany([
      { tenantId: "acme", projectId: "p1", title: "T1", done: false },
      { tenantId: "acme", projectId: "p1", title: "T2", done: true },
    ]);
    // Tasks for acme/p2
    await Task.query().insert({ tenantId: "acme", projectId: "p2", title: "T3", done: false });
    // No tasks for corp/p1
  });

  afterEach(async () => {
    await db.close();
  });

  it("loads tasks for each project via composite FK", async () => {
    const projects = (await Project.query()
      .where((p: any) => p.tenantId === "acme")
      .select((p: any) => ({ tenantId: p.tenantId, projectId: p.projectId, tasks: p.tasks }))
      .orderBy("projectId", "asc")
      .toArray()) as any[];

    expect(projects).toHaveLength(2);

    const alpha = projects.find((p: any) => p.projectId === "p1")!;
    expect(alpha.tasks).toHaveLength(2);
    expect(alpha.tasks.map((t: any) => t.title).sort()).toEqual(["T1", "T2"]);

    const beta = projects.find((p: any) => p.projectId === "p2")!;
    expect(beta.tasks).toHaveLength(1);
    expect(beta.tasks[0].title).toBe("T3");
  });

  it("returns empty tasks array for a project with no tasks", async () => {
    const projects = (await Project.query()
      .where((p: any) => p.tenantId === "corp")
      .select((p: any) => ({ tenantId: p.tenantId, tasks: p.tasks }))
      .toArray()) as any[];

    expect(projects).toHaveLength(1);
    expect(projects[0].tasks).toEqual([]);
  });

  it("tasks are not mixed between tenants even when projectId collides", async () => {
    // acme/p1 has T1, T2 — corp/p1 has no tasks.
    // This validates that the composite FK (tenantId+projectId) correctly
    // separates tasks that share the same projectId across tenants.
    await Task.query().insert({ tenantId: "corp", projectId: "p1", title: "Corp-T1", done: false });

    const projects = (await Project.query()
      .select((p: any) => ({ tenantId: p.tenantId, projectId: p.projectId, tasks: p.tasks }))
      .orderBy("tenantId", "asc")
      .toArray()) as any[];

    const acmeP1 = projects.find((p: any) => p.tenantId === "acme" && p.projectId === "p1")!;
    const corpP1 = projects.find((p: any) => p.tenantId === "corp" && p.projectId === "p1")!;

    expect(acmeP1.tasks.map((t: any) => t.title).sort()).toEqual(["T1", "T2"]);
    expect(corpP1.tasks).toHaveLength(1);
    expect(corpP1.tasks[0].title).toBe("Corp-T1");
  });
});

describe("composite PK — many-to-one relation (Task → Project)", () => {
  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(Project);
    registerEntity(Task);
    db = new Db(freshDriver());
    await createTables(db);

    await Project.query().insertMany([
      { tenantId: "acme", projectId: "p1", name: "Alpha" },
      { tenantId: "acme", projectId: "p2", name: "Beta" },
    ]);
    await Task.query().insertMany([
      { tenantId: "acme", projectId: "p1", title: "T1", done: false },
      { tenantId: "acme", projectId: "p2", title: "T2", done: true },
      { tenantId: "acme", projectId: "p1", title: "T3", done: false },
    ]);
  });

  afterEach(async () => {
    await db.close();
  });

  it("loads the parent project for each task via composite FK", async () => {
    const tasks = (await Task.query()
      .select((t: any) => ({ id: t.id, title: t.title, project: t.project }))
      .orderBy("id", "asc")
      .toArray()) as any[];

    expect(tasks).toHaveLength(3);

    expect(tasks[0].project).toMatchObject({ tenantId: "acme", projectId: "p1", name: "Alpha" });
    expect(tasks[1].project).toMatchObject({ tenantId: "acme", projectId: "p2", name: "Beta" });
    expect(tasks[2].project).toMatchObject({ tenantId: "acme", projectId: "p1", name: "Alpha" });
  });

  it("batches the project lookup — both tasks for p1 share the same fetched project object key", async () => {
    // Two tasks point to "acme/p1"; the ORM should issue a single WHERE IN
    // query for all distinct FK combos and map results back correctly.
    const tasks = (await Task.query()
      .where((t: any) => t.projectId === "p1")
      .select((t: any) => ({ title: t.title, project: t.project }))
      .orderBy("title", "asc")
      .toArray()) as any[];

    expect(tasks).toHaveLength(2);
    expect(tasks[0].project.name).toBe("Alpha");
    expect(tasks[1].project.name).toBe("Alpha");
  });

  it("project is null when no matching composite FK row exists", async () => {
    // Insert a task whose FK points to a non-existent project.
    await Task.query().insert({
      tenantId: "acme",
      projectId: "no-project",
      title: "Orphan",
      done: false,
    });

    const tasks = (await Task.query()
      .where((t: any) => t.title === "Orphan")
      .select((t: any) => ({ title: t.title, project: t.project }))
      .toArray()) as any[];

    expect(tasks).toHaveLength(1);
    expect(tasks[0].project).toBeNull();
  });
});

describe("composite PK — relation referenced in WHERE clause (JOIN path)", () => {
  // When a composite-FK relation appears in a WHERE predicate (e.g. t.project.name === "Alpha"),
  // the ORM emits a JOIN instead of a separate WHERE-IN query.
  // buildJoinClause must produce: ON t0."tenantId" = t1."tenantId" AND t0."projectId" = t1."projectId"
  // If only the first FK column is used, the join would mix rows from different tenants.

  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(Project);
    registerEntity(Task);
    db = new Db(freshDriver());
    await createTables(db);

    await Project.query().insertMany([
      { tenantId: "acme", projectId: "p1", name: "Alpha" },
      { tenantId: "acme", projectId: "p2", name: "Beta" },
      // corp also has a project named "Alpha" with the same projectId "p1"
      { tenantId: "corp", projectId: "p1", name: "Alpha" },
    ]);
    await Task.query().insertMany([
      { tenantId: "acme", projectId: "p1", title: "AcmeTask", done: false },
      { tenantId: "acme", projectId: "p2", title: "BetaTask", done: false },
      { tenantId: "corp", projectId: "p1", title: "CorpTask", done: false },
    ]);
  });

  afterEach(async () => {
    await db.close();
  });

  it("filters tasks by project name via JOIN on composite FK — only matching tenant rows returned", async () => {
    // WHERE t.project.name === "Alpha" triggers a JOIN.
    // The JOIN must include both tenantId and projectId in the ON clause;
    // if it only joined on projectId, corp tasks would also match acme/p1 "Alpha".
    const tasks = (await Task.query()
      .where((t: any) => t.project.name === "Alpha")
      .orderBy("tenantId", "asc")
      .toArray()) as any[];

    // Both acme/p1 and corp/p1 have a project named "Alpha", so both tasks are returned.
    expect(tasks).toHaveLength(2);
    const tenants = tasks.map((t: any) => t.tenantId).sort();
    expect(tenants).toEqual(["acme", "corp"]);
    expect(tasks.map((t: any) => t.title).sort()).toEqual(["AcmeTask", "CorpTask"]);
  });

  it("JOIN on composite FK does not include tasks from wrong project when names differ", async () => {
    // Only acme/p2 is "Beta" — no corp project is named "Beta".
    const tasks = (await Task.query()
      .where((t: any) => t.project.name === "Beta")
      .toArray()) as any[];

    expect(tasks).toHaveLength(1);
    expect((tasks[0] as any).title).toBe("BetaTask");
    expect((tasks[0] as any).tenantId).toBe("acme");
  });

  it("composite JOIN correctly isolates tenant — same projectId, different tenant, different name", async () => {
    // acme/p1 = "Alpha", corp/p1 = "Alpha" — but we can filter by tenantId in addition
    // to verify the JOIN does not collapse rows across tenants.
    const tasks = (await Task.query()
      .where((t: any) => t.project.name === "Alpha" && t.tenantId === "acme")
      .toArray()) as any[];

    expect(tasks).toHaveLength(1);
    expect((tasks[0] as any).title).toBe("AcmeTask");
  });
});
