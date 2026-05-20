/**
 * Base migration class: owns the dialect-agnostic diff and DDL logic.
 * Each dialect subclasses this and overrides the dialect-specific hooks.
 */

import type {
  ColumnChange,
  ColumnDef,
  DiffAction,
  DbColumnInfo,
  DbMigrations,
  DialectName,
  Driver,
  QueryCompiler,
} from "./types.js";
import { getColumnDef } from "./types.js";
import type { RegisteredEntity } from "../entity/global-driver.js";
import { extractBaseType } from "../utils.js";

export abstract class BaseMigrations implements DbMigrations {
  constructor(
    readonly dialectName: DialectName,
    protected readonly queryCompiler: QueryCompiler,
  ) {}

  abstract getDbTables(driver: Driver): Promise<string[]>;
  abstract getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]>;

  async diffSchema(
    driver: Driver,
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
    driver: Driver,
    table: string,
    schema: Record<string, ColumnDef>,
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
      const changes = BaseMigrations.computeColumnChanges(
        dbCol,
        getColumnDef(def, this.dialectName),
      );
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
    let normalized = value.trim().replace(/^\((.*)\)$/, "$1").trim();
    // Strip Postgres type casts (e.g. `'Anon'::text`, `0::integer`, `'x'::"my_enum"`).
    normalized = normalized.replace(/::\s*(?:"[^"]+"|[A-Za-z_][\w ]*)\s*$/, "").trim();
    // Postgres serial/identity columns surface as `nextval('seq'::regclass)`; treat
    // as an implicit default so they don't drift against entity defs that omit it.
    if (/^nextval\s*\(/i.test(normalized)) return null;
    return normalized;
  }

  protected static extractDefault(def: string): string | null {
    const match = /\bdefault\s+(.+?)(?:\s+not\s+null|\s+primary\s+key|\s+unique|\s+references\b|$)/i.exec(def);
    return BaseMigrations.normalizeDefault(match?.[1] ?? null);
  }

  protected static computeColumnChanges(dbCol: DbColumnInfo, entityDef: string): ColumnChange[] {
    const changes: ColumnChange[] = [];

    const dbBaseType = extractBaseType(dbCol.type);
    const entityBaseType = extractBaseType(entityDef);
    if (dbBaseType !== entityBaseType) {
      changes.push({ kind: "type", from: dbBaseType, to: entityBaseType });
    }

    const dbPk = dbCol.pk > 0;
    const entityPk = /\bprimary\s+key\b/i.test(entityDef);
    const dbNotNull = dbCol.notnull === 1 || dbPk;
    const entityNotNull = /\bnot\s+null\b/i.test(entityDef) || entityPk;
    if (dbNotNull !== entityNotNull) {
      changes.push({
        kind: entityNotNull ? "not_null" : "nullable",
        from: dbNotNull,
        to: entityNotNull,
      });
    }

    const dbDefault = BaseMigrations.normalizeDefault(dbCol.dflt_value);
    const entityDefault = BaseMigrations.extractDefault(entityDef);
    if (dbDefault !== entityDefault) {
      changes.push({ kind: "default", from: dbDefault, to: entityDefault });
    }

    if (dbPk !== entityPk) {
      changes.push({ kind: "primary_key", from: dbPk, to: entityPk });
    }

    return changes;
  }

}
