export { diffSchema } from "./diff.js";
export { generateMigrationFiles, writeMigrationFiles } from "./generator.js";
export {
  runMigrations,
  migrationStatus,
  appliedMigrations,
  pendingMigrations,
  dryRunMigrations,
  upMigration,
  downMigration,
} from "./runner.js";
export type { MigrationResult } from "./runner.js";
export { parseFkDependencies, topoSort } from "./topo-sort.js";
export type {
  DiffAction,
  Dialect,
  MigrationFile,
  MigrationRecord,
  MigrationConfig,
  PendingMigration,
  MigrationDryRun,
  MigrationDb,
} from "./types.js";
