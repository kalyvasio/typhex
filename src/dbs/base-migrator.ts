/**
 * Base migrator: owns dialect-agnostic schema diff and introspection.
 * Each dialect subclasses this and overrides dialect-specific hooks.
 */

import type {
  ColumnChange,
  DialectColumnDef,
  DiffAction,
  DbColumnInfo,
  DbMigrator,
  DialectName,
  QueryCompiler,
} from "./types.js";
import { getColumnDef } from "./types.js";
import type { RegisteredEntity } from "../entity/global-driver.js";
import type { ResolvedDriver } from "../driver/types.js";
import { parseColumnDefinition } from "../schema/column-definition.js";
import { extractBaseType } from "../utils.js";

export abstract class BaseMigrator implements DbMigrator {
  constructor(
    readonly dialectName: DialectName,
    protected readonly queryCompiler: QueryCompiler,
  ) {}

  abstract getDbTables(driver: ResolvedDriver): Promise<string[]>;
  abstract getDbColumns(driver: ResolvedDriver, table: string): Promise<DbColumnInfo[]>;

  async diffSchema(
    driver: ResolvedDriver,
    entities: readonly RegisteredEntity[],
  ): Promise<DiffAction[]> {
    const actions: DiffAction[] = [];
    const dbTables = new Set(await this.getDbTables(driver));
    const entityTables = new Map(entities.map((e) => [e.table._table, e.table._schema]));

    for (const [table, schema] of entityTables) {
      if (!dbTables.has(table)) {
        actions.push({ kind: "add_table", table, schema });
        continue;
      }
      actions.push(...(await this.diffColumns(driver, table, schema)));
    }

    for (const dbTable of dbTables) {
      if (!entityTables.has(dbTable)) {
        const columnInfos = await this.getDbColumns(driver, dbTable);
        actions.push({ kind: "drop_table", table: dbTable, columnInfos });
      }
    }

    return actions;
  }

  private async diffColumns(
    driver: ResolvedDriver,
    table: string,
    schema: Record<string, DialectColumnDef>,
  ): Promise<DiffAction[]> {
    const actions: DiffAction[] = [];
    const dbCols = await this.getDbColumns(driver, table);
    const dbColMap = new Map(dbCols.map((c) => [c.name, c]));
    const entityCols = new Set(Object.keys(schema));

    for (const [col, def] of Object.entries(schema)) {
      const dbCol = dbColMap.get(col);
      if (!dbCol) {
        actions.push({ kind: "add_column", table, column: col, definition: def });
        continue;
      }
      const changes = BaseMigrator.computeColumnChanges(dbCol, getColumnDef(def, this.dialectName));
      if (changes.length > 0) {
        actions.push({
          kind: "alter_column",
          table,
          column: col,
          oldDef: dbCol.type,
          newDef: def,
          columnInfo: dbCol,
          changes,
        });
      }
    }

    for (const dbCol of dbCols) {
      if (!entityCols.has(dbCol.name)) {
        actions.push({ kind: "drop_column", table, column: dbCol.name, columnInfo: dbCol });
      }
    }

    return actions;
  }

  protected static normalizeDefault(value: string | null): string | null {
    if (value == null) return null;
    let normalized = value
      .trim()
      .replace(/^\((.*)\)$/, "$1")
      .trim();
    // Strip Postgres type casts (e.g. `'Anon'::text`, `0::integer`, `'x'::"my_enum"`).
    normalized = normalized.replace(/::\s*(?:"[^"]+"|[A-Za-z_][\w ]*)\s*$/, "").trim();
    // Postgres serial/identity columns surface as `nextval('seq'::regclass)`; treat
    // as an implicit default so they don't drift against entity defs that omit it.
    if (/^nextval\s*\(/i.test(normalized)) return null;
    return normalized;
  }

  protected static computeColumnChanges(dbCol: DbColumnInfo, entityDef: string): ColumnChange[] {
    const changes: ColumnChange[] = [];
    const metadata = parseColumnDefinition(entityDef);

    const dbBaseType = extractBaseType(dbCol.type);
    const entityBaseType = extractBaseType(entityDef);
    if (dbBaseType !== entityBaseType) {
      changes.push({ kind: "type", from: dbBaseType, to: entityBaseType });
    }

    const dbPk = dbCol.pk > 0;
    const entityPk = metadata.primaryKey;
    const dbNotNull = dbCol.notnull === 1 || dbPk;
    const entityNotNull = metadata.notNull || entityPk;
    if (dbNotNull !== entityNotNull) {
      changes.push({
        kind: entityNotNull ? "not_null" : "nullable",
        from: dbNotNull,
        to: entityNotNull,
      });
    }

    const dbDefault = BaseMigrator.normalizeDefault(dbCol.dflt_value);
    const entityDefault = BaseMigrator.normalizeDefault(metadata.defaultValue);
    if (dbDefault !== entityDefault) {
      changes.push({ kind: "default", from: dbDefault, to: entityDefault });
    }

    if (dbPk !== entityPk) {
      changes.push({ kind: "primary_key", from: dbPk, to: entityPk });
    }

    return changes;
  }
}
