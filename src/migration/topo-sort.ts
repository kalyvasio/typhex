/**
 * Topological sort for table creation order based on FK references.
 * Parses "references <table>(...)" from column definitions.
 */

export function parseFkDependencies(
  entities: ReadonlyArray<{ table: { _table: string; _schema: Record<string, string> } }>,
): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const e of entities) {
    const refs: string[] = [];
    for (const def of Object.values(e.table._schema)) {
      const match = def.match(/references\s+"?(\w+)"?/i);
      if (match && match[1] !== e.table._table) refs.push(match[1]);
    }
    deps.set(e.table._table, refs);
  }
  return deps;
}

export function topoSort(names: string[], deps: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: string[] = [];
  const nameSet = new Set(names);

  function visit(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular FK dependency detected involving table "${name}"`);
    }
    visiting.add(name);
    for (const dep of deps.get(name) ?? []) {
      if (nameSet.has(dep)) visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    result.push(name);
  }

  for (const name of names) visit(name);
  return result;
}
