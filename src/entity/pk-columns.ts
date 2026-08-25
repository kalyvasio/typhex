import { parseColumnDefinition } from "../schema/column-definition.js";

function getPkColumns(schema: Record<string, string>): string[] {
  const names = Object.keys(schema);
  return names.filter((c) => parseColumnDefinition(schema[c]).primaryKey);
}

/** Primary key column names from a schema map. */
export function getPkColumnsFromSchema(schema: Record<string, string>): string[] {
  return getPkColumns(schema);
}

export { getPkColumns };
