export interface ColumnDefinitionMetadata {
  primaryKey: boolean;
  notNull: boolean;
  autoIncrement: boolean;
  hasDefault: boolean;
  defaultValue: string | null;
}

const DEFAULT_VALUE =
  /\bdefault\s+(.+?)(?:\s+not\s+null|\s+primary\s+key|\s+unique|\s+references\b|$)/i;

/** Parses runtime constraint metadata from an Entity string column definition. */
export function parseColumnDefinition(definition: string): ColumnDefinitionMetadata {
  const defaultMatch = DEFAULT_VALUE.exec(definition);
  return {
    primaryKey: /\bprimary\s+key\b/i.test(definition),
    notNull: /\bnot\s+null\b/i.test(definition),
    autoIncrement: /\bauto_?increment\b/i.test(definition),
    hasDefault: /\bdefault\b/i.test(definition),
    defaultValue: defaultMatch?.[1]?.trim() ?? null,
  };
}
