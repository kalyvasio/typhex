function hasPrimaryKey(def: string): boolean {
  const stripped = def.replaceAll(/'[^']*'/g, "").replaceAll(/--[^\n]*/g, "");
  return /\bprimary\s+key\b/i.test(stripped);
}

function getPkColumns(schema: Record<string, string>): string[] {
  const names = Object.keys(schema);
  return names.filter((c) => hasPrimaryKey(schema[c]));
}

/** Primary key column names from a schema map. */
export function getPkColumnsFromSchema(schema: Record<string, string>): string[] {
  return getPkColumns(schema);
}

export { getPkColumns };
