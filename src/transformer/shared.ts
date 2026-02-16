/**
 * Shared utilities for Typhex transformers.
 */

import * as ts from "typescript";

/** Check if a symbol is from the Typhex package (Table or QueryBuilder). */
export function checkSymbolIsTyphex(symbol: ts.Symbol): boolean {
  const symbolName = symbol.getName();
  
  // Only check Table and QueryBuilder symbols
  if (symbolName !== "Table" && symbolName !== "QueryBuilder") {
    return false;
  }
  
  // Check declarations to verify source file
  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) {
    return false;
  }
  
  // Verify all declarations are from typhex package
  for (const decl of declarations) {
    const sourceFile = decl.getSourceFile();
    const fileName = sourceFile.fileName;
    
    // Normalize path separators
    const normalizedPath = fileName.replace(/\\/g, "/");
    
    // Check if file is from our package structure
    const isTyphexFile = 
      (normalizedPath.includes("/typhex/") || normalizedPath.includes("/typhex\\")) &&
      (normalizedPath.includes("/orm/table") || normalizedPath.includes("/orm/query-builder")) &&
      (normalizedPath.endsWith(".ts") || normalizedPath.endsWith(".js") || normalizedPath.endsWith(".d.ts"));
    
    if (!isTyphexFile) {
      return false; // At least one declaration is not from typhex
    }
  }
  
  return true; // All declarations are from typhex
}

/** Check if an expression is a Typhex Table or QueryBuilder type. */
export function isTyphexType(
  receiver: ts.Expression,
  checker: ts.TypeChecker
): boolean {
  try {
    const receiverType = checker.getTypeAtLocation(receiver);
    
    // Get the type's symbol - for generic types like Table<T>, this gets the base class
    let typeSymbol = receiverType.getSymbol();
    
    // For generic instantiations, try to get symbol from constructor
    if (!typeSymbol) {
      const props = receiverType.getProperties();
      const constructorProp = props.find(p => p.getName() === "constructor");
      if (constructorProp) {
        const constructorType = checker.getTypeOfSymbolAtLocation(constructorProp, receiver);
        const constructorSig = constructorType.getCallSignatures();
        if (constructorSig.length > 0) {
          const returnType = constructorSig[0].getReturnType();
          typeSymbol = returnType.getSymbol();
        }
      }
    }
    
    // Also check alias symbol for type aliases
    if (!typeSymbol && receiverType.aliasSymbol) {
      typeSymbol = receiverType.aliasSymbol;
    }
    
    if (!typeSymbol) {
      return false;
    }
    
    return checkSymbolIsTyphex(typeSymbol);
  } catch {
    // If type checking fails, be conservative and skip transformation
    return false;
  }
}

/** Extract member path from property access expression (e.g. u.foo.bar => ["foo", "bar"]). */
export function memberPath(
  expr: ts.PropertyAccessExpression,
  paramName: string
): string[] | null {
  const parts: string[] = [];
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current) && current.text === paramName) return parts;
  return null;
}

/** Unwrap parenthesized expression to get inner object literal if present. */
export function unwrapObjectLiteral(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  const inner = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  return ts.isObjectLiteralExpression(inner) ? inner : null;
}
