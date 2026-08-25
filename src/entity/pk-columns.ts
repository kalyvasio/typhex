import { parseColumnDefinition } from "../schema/column-definition.js";

/** Primary key column names from a schema map. */
export function getPkColumnsFromSchema(schema: Record<string, string>): string[] {
  return Object.keys(schema).filter((column) => parseColumnDefinition(schema[column]).primaryKey);
}
