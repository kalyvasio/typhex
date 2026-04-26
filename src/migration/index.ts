export { diffSchema } from "./diff.js";
export { generateMigrationFiles, writeMigrationFiles } from "./generator.js";
export { runMigrations, migrationStatus } from "./runner.js";
export { parseFkDependencies, topoSort } from "./topo-sort.js";
export type {
  DiffAction,
  Dialect,
  MigrationFile,
  MigrationRecord,
  MigrationConfig,
} from "./types.js";
