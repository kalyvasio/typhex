/**
 * Schema and table definition types.
 */

export interface ColumnDef {
  type: string;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  nullable?: boolean;
  default?: string | number;
}

export type TableDefinition = Record<string, string | ColumnDef>;

function stripForConstraintCheck(def: string): string {
  return def.replace(/'[^']*'/g, "").replace(/--[^\n]*/g, "");
}

/** Normalize to ColumnDef */
export function normalizeCol(def: string | ColumnDef): ColumnDef {
  if (typeof def === "string") {
    const stripped = stripForConstraintCheck(def);
    return {
      type: def,
      primaryKey: /\bprimary\s+key\b/i.test(stripped),
      autoIncrement: /\bautoincrement\b/i.test(stripped),
      nullable: !/\bnot\s+null\b/i.test(stripped),
    };
  }
  return def;
}

export function getColumnNames(def: TableDefinition): string[] {
  return Object.keys(def);
}

export function sqlType(def: TableDefinition, col: string): string {
  const d = def[col];
  const c = normalizeCol(d);
  const lower = c.type.toLowerCase();
  let out = c.type;
  if (c.primaryKey && !lower.includes("primary key")) out += " PRIMARY KEY";
  if (c.autoIncrement && !lower.includes("autoincrement")) out += " AUTOINCREMENT";
  if (c.nullable === false && !lower.includes("not null")) out += " NOT NULL";
  if (c.default !== undefined) out += " DEFAULT " + (typeof c.default === "number" ? c.default : `'${String(c.default).replace(/'/g, "''")}'`);
  return out;
}
