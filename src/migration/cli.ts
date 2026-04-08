#!/usr/bin/env node

/**
 * CLI for typhex migrations.
 *
 * Usage:
 *   typhex migrate:generate [--config <path>] [--entities <path>] [--db <path>] [--dir <path>] [--dialect <name>]
 *   typhex migrate:run      [--config <path>] [--db <path>] [--dir <path>]
 *   typhex migrate:status   [--config <path>] [--db <path>] [--dir <path>]
 *
 * Config is loaded from: --config path, or typhex.config.js/mjs/json in cwd, or .env (TYPHEX_*).
 * CLI args override config. --db can be omitted if TYPHEX_DATABASE or config.database is set.
 *
 */

import { resolve, relative } from "node:path";
import { getRegisteredEntities } from "../entity/global-driver.js";
import { createDriver } from "../driver/factory.js";
import { generateMigrationFiles, writeMigrationFiles } from "./generator.js";
import { runMigrations, migrationStatus } from "./runner.js";
import type { TyphexConfig } from "../config/types.js";
import { loadConfig } from "../config/load-config.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

/** Resolve db path: --db flag, then config, then TYPHEX_DATABASE env. */
function resolveDbPath(cliDb: string | undefined, configDb: string | undefined): string {
  const raw = cliDb ?? configDb ?? process.env.TYPHEX_DATABASE ?? process.env.TYPHEX_DB;
  if (!raw) {
    throw new Error("Database path required. Use --db <path>, config.database, or TYPHEX_DATABASE.");
  }
  return raw === ":memory:" ? raw : resolveWithinCwd(raw, "--db");
}

/** Ensure path is within cwd to prevent path traversal. */
function resolveWithinCwd(pathArg: string, label: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, pathArg);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..")) {
    throw new Error(`${label} path must be within the current working directory`);
  }
  return resolved;
}

/** Create a driver, run callback, and always close — regardless of outcome. */
async function withDriver<T>(
  config: TyphexConfig,
  dbPath: string,
  callback: (driver: Awaited<ReturnType<typeof createDriver>>) => Promise<T>
): Promise<T> {
  const driver = createDriver({
    dialect: config.dialect,
    database: dbPath,
    url: config.url,
  });
  try {
    return await callback(driver);
  } finally {
    await driver.close();
  }
}

function usage(): never {
  console.log(`
typhex — migration CLI

Commands:
  migrate:generate  Diff entity definitions against the database and generate .sql scripts
  migrate:run       Apply pending migration scripts to the database
  migrate:status    Show applied and pending migrations

Options:
  --config <path>    Config file path (default: auto-detect typhex.config.js)
  --entities <path>  Path to module that defines Entity() calls (required for generate)
  --db <path>        Database path (or config.database / TYPHEX_DATABASE)
  --dir <path>       Migrations directory (default: ./migrations)
  --dialect <name>   Target dialect: sqlite (default) or postgres
`);
  process.exit(1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command) usage();

  const overrides: Record<string, string> = {};
  if (args.db) overrides.database = args.db;
  if (args.dir) overrides.migrationsFolder = args.dir;
  if (args.dialect) overrides.dialect = args.dialect;
  if (args.entities) overrides.entities = args.entities;

  const config = await loadConfig({
    configPath: args.config,
    cwd: process.cwd(),
    overrides: overrides as Partial<TyphexConfig>,
  });

  const dir = resolveWithinCwd(config.migrationsFolder ?? "./migrations", "--dir");
  const dbPath = resolveDbPath(args.db, config.database);

  if (command === "migrate:generate") {
    const entitiesPath = args.entities ?? config.entities;
    if (!entitiesPath) {
      console.error("migrate:generate requires --entities or config.entities");
      process.exit(1);
    }
    const entitiesResolved = resolveWithinCwd(entitiesPath, "--entities");
    await withDriver(config, dbPath, async (driver) => {
      await import(entitiesResolved);
      const entities = getRegisteredEntities();
      if (entities.length === 0) {
        console.log("No entities registered. Nothing to generate.");
        return;
      }
      const files = await generateMigrationFiles(driver, entities);
      if (files.length === 0) {
        console.log("Schema is up to date. No migrations generated.");
        return;
      }
      const paths = writeMigrationFiles(dir, files);
      console.log(`Generated ${paths.length} migration(s):`);
      for (const p of paths) console.log(`  ${p}`);
    });
  } else if (command === "migrate:run") {
    await withDriver(config, dbPath, async (driver) => {
      const result = await runMigrations(driver, dir);
      if (result.applied.length === 0) {
        console.log("No pending migrations.");
      } else {
        console.log(`Applied ${result.applied.length} migration(s):`);
        for (const n of result.applied) console.log(`  ✓ ${n}`);
      }
      if (result.skipped.length > 0) {
        console.log(`Skipped ${result.skipped.length} (already applied).`);
      }
    });
  } else if (command === "migrate:status") {
    await withDriver(config, dbPath, async (driver) => {
      const status = await migrationStatus(driver, dir);
      if (status.applied.length > 0) {
        console.log("Applied migrations:");
        for (const r of status.applied) console.log(`  ✓ ${r.name}  (${r.applied_at})`);
      }
      if (status.pending.length > 0) {
        console.log("Pending migrations:");
        for (const n of status.pending) console.log(`  ○ ${n}`);
      }
      if (status.applied.length === 0 && status.pending.length === 0) {
        console.log("No migrations found.");
      }
    });
  } else {
    console.error(`Unknown command: ${command}`);
    usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
