export interface ColumnDefinitionMetadata {
  primaryKey: boolean;
  notNull: boolean;
  autoIncrement: boolean;
  hasDefault: boolean;
  defaultValue: string | null;
}

function maskQuotedContentAndComments(definition: string): string {
  let masked = "";
  let quote: "'" | '"' | null = null;
  let lineComment = false;

  for (let i = 0; i < definition.length; i++) {
    const char = definition[i];
    const next = definition[i + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        masked += char;
      } else {
        masked += " ";
      }
      continue;
    }

    if (quote) {
      masked += char === quote ? char : " ";
      if (char === quote) {
        if (next === quote) {
          masked += " ";
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "-" && next === "-") {
      masked += "--";
      i++;
      lineComment = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      masked += char;
      continue;
    }

    masked += char;
  }

  return masked;
}

function extractDefaultValue(definition: string, masked: string): string | null {
  const defaultMatch = /\bdefault\b/i.exec(masked);
  if (!defaultMatch) return null;

  const valueStart = defaultMatch.index + defaultMatch[0].length;
  let depth = 0;
  let valueEnd = definition.length;

  for (let i = valueStart; i < masked.length; i++) {
    const char = masked[i];
    if (depth === 0 && char === "-" && masked[i + 1] === "-") {
      valueEnd = i;
      break;
    }
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0 || !/\s/.test(char)) continue;

    const rest = masked.slice(i);
    if (
      /^\s+(?:not\s+null|primary\s+key|unique\b|references\b|check\b|collate\b|generated\b)/i.test(
        rest,
      )
    ) {
      valueEnd = i;
      break;
    }
  }

  return definition.slice(valueStart, valueEnd).trim();
}

/** Parses runtime constraint metadata from an Entity string column definition. */
export function parseColumnDefinition(definition: string): ColumnDefinitionMetadata {
  const masked = maskQuotedContentAndComments(definition);
  const defaultValue = extractDefaultValue(definition, masked);

  return {
    primaryKey: /\bprimary\s+key\b/i.test(masked),
    notNull: /\bnot\s+null\b/i.test(masked),
    autoIncrement: /\bauto_?increment\b/i.test(masked),
    hasDefault: /\bdefault\b/i.test(masked),
    defaultValue,
  };
}
