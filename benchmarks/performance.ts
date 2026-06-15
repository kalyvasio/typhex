import { performance } from "node:perf_hooks";
import { Db, Entity, count, createSqliteDriver, rel } from "../src/index.js";
import { clearRegistry, registerEntity } from "../src/entity/global-driver.js";

interface BenchmarkResult {
  name: string;
  rows: number;
  ms: number;
  opsPerSecond: number;
}

const User = Entity(
  "bench_users",
  {
    id: "integer primary key autoincrement",
    name: "text not null",
    age: "integer not null",
  },
  {
    posts: rel.oneToMany(() => Post, { foreignKey: "authorId" }),
  },
);

const Post = Entity(
  "bench_posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
    authorId: "integer not null",
    views: "integer not null default 0",
  },
  {
    author: rel.manyToOne(() => User, { foreignKey: "authorId" }),
  },
);

async function time(name: string, rows: number, fn: () => Promise<void>): Promise<BenchmarkResult> {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  return {
    name,
    rows,
    ms,
    opsPerSecond: rows / (ms / 1000),
  };
}

function print(results: BenchmarkResult[]): void {
  const nameWidth = Math.max(...results.map((result) => result.name.length), "benchmark".length);
  console.log(`${"benchmark".padEnd(nameWidth)}  rows      ms      rows/sec`);
  console.log(`${"-".repeat(nameWidth)}  ----  ------  ------------`);
  for (const result of results) {
    console.log(
      [
        result.name.padEnd(nameWidth),
        String(result.rows).padStart(4),
        result.ms.toFixed(1).padStart(6),
        result.opsPerSecond.toFixed(0).padStart(12),
      ].join("  "),
    );
  }
}

async function setup(): Promise<Db> {
  clearRegistry();
  registerEntity(User);
  registerEntity(Post);
  const db = new Db(createSqliteDriver({ path: ":memory:" }));
  await db.migrate();
  return db;
}

async function seedUsers(count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    name: `user-${i}`,
    age: 18 + (i % 50),
  }));
  await User.query().insertMany(rows);
}

async function seedPosts(users: Array<{ id: number }>, postsPerUser: number): Promise<void> {
  const rows = users.flatMap((user, userIndex) =>
    Array.from({ length: postsPerUser }, (_, postIndex) => ({
      title: `post-${userIndex}-${postIndex}`,
      authorId: user.id,
      views: postIndex * 10,
    })),
  );
  await Post.query().insertMany(rows);
}

async function main(): Promise<void> {
  const db = await setup();
  const results: BenchmarkResult[] = [];

  try {
    results.push(
      await time("insertMany users", 1_000, async () => {
        await seedUsers(1_000);
      }),
    );

    const users = (await User.query().toArray()) as Array<{ id: number }>;
    results.push(
      await time("insertMany posts", 5_000, async () => {
        await seedPosts(users, 5);
      }),
    );

    results.push(
      await time("relation loading", 1_000, async () => {
        await User.query()
          .select((u: any) => ({
            id: u.id,
            posts: u.posts.query().select((p: any) => ({ id: p.id, title: p.title })),
          }))
          .toArray();
      }),
    );

    results.push(
      await time("aggregation", 1, async () => {
        await Post.query()
          .select((p: any) => ({ authorId: p.authorId, total: count(p.id) }))
          .groupBy("authorId")
          .having((p: any) => count(p.id) > 0)
          .toArray();
      }),
    );

    results.push(
      await time("large pagination", 100, async () => {
        for (let page = 0; page < 100; page++) {
          await Post.query()
            .orderBy("id", "asc")
            .limit(50)
            .offset(page * 50)
            .toArray();
        }
      }),
    );

    results.push(
      await time("insertGraph", 100, async () => {
        await User.query().insertGraph(
          Array.from({ length: 100 }, (_, i) => ({
            name: `graph-user-${i}`,
            age: 30,
            posts: [
              { title: `graph-post-${i}-a`, views: 1 },
              { title: `graph-post-${i}-b`, views: 2 },
            ],
          })),
        );
      }),
    );

    print(results);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
