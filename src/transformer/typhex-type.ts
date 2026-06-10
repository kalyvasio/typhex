/**
 * Detect whether a TypeScript type/receiver is Typhex's Table or QueryBuilder,
 * gating which `.where()` / `.select()` calls the transformer rewrites.
 */

import ts from "typescript";

export function checkSymbolIsTyphex(symbol: ts.Symbol): boolean {
  const symbolName = symbol.getName();
  if (symbolName !== "Table" && symbolName !== "QueryBuilder") return false;

  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) return false;

  for (const decl of declarations) {
    if (!isTyphexDeclarationFile(decl.getSourceFile().fileName)) return false;
  }
  return true;
}

function isTyphexDeclarationFile(rawPath: string): boolean {
  const normalized = rawPath.replaceAll("\\", "/");
  const inTyphexPackage = normalized.includes("/typhex/") || normalized.includes("/typhex\\");
  const inOrmModule =
    normalized.includes("/orm/table") || normalized.includes("/orm/query-builder");
  const hasValidExtension =
    normalized.endsWith(".ts") || normalized.endsWith(".js") || normalized.endsWith(".d.ts");
  return inTyphexPackage && inOrmModule && hasValidExtension;
}

export function isTyphexType(receiver: ts.Expression, checker: ts.TypeChecker): boolean {
  try {
    const symbol = resolveTypeSymbol(receiver, checker);
    return symbol ? checkSymbolIsTyphex(symbol) : false;
  } catch {
    return false;
  }
}

function resolveTypeSymbol(
  receiver: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const receiverType = checker.getTypeAtLocation(receiver);

  const direct = receiverType.getSymbol();
  if (direct) return direct;

  const constructorProp = receiverType.getProperties().find((p) => p.getName() === "constructor");
  if (constructorProp) {
    const signatures = checker
      .getTypeOfSymbolAtLocation(constructorProp, receiver)
      .getCallSignatures();
    if (signatures.length > 0) {
      const fromCtor = signatures[0].getReturnType().getSymbol();
      if (fromCtor) return fromCtor;
    }
  }

  return receiverType.aliasSymbol;
}
