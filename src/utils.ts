export function toArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function groupBy<T, K>(items: Iterable<T>, keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

export function extractBaseType(def: string): string {
  const trimmed = def.trim().toLowerCase().replaceAll(/\s+/g, " ");
  const withoutModifiers = trimmed.replace(/^(?:unsigned|signed)\s+/, "");
  const multiWord = withoutModifiers.match(
    /^(?:double\s+precision|character\s+varying|timestamp\s+with\s+time\s+zone|timestamp\s+without\s+time\s+zone)(?:\([^)]*\))?/,
  );
  if (multiWord) return multiWord[0];
  const withParams = withoutModifiers.match(/^(\w+(?:\([^)]*\))?)/);
  return withParams ? withParams[1] : (withoutModifiers.split(/\s/)[0] ?? trimmed);
}
