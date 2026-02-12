/**
 * Query Intermediate Representation (IR).
 * Produced by the TS transformer or runtime parser; consumed by the SQL compiler.
 */

export type IrNode =
  | IrBinary
  | IrUnary
  | IrMember
  | IrConst
  | IrParam
  | IrCall
  | IrIn;

export interface IrBinary {
  kind: "binary";
  op: "&&" | "||" | "===" | "!==" | ">" | ">=" | "<" | "<=" | "==" | "!=";
  left: IrNode;
  right: IrNode;
}

export interface IrUnary {
  kind: "unary";
  op: "!";
  operand: IrNode;
}

export interface IrMember {
  kind: "member";
  /** Parameter name (e.g. "u") and property path ["age"] => u.age */
  param: string;
  path: string[];
}

export interface IrConst {
  kind: "const";
  value: unknown;
}

export interface IrParam {
  kind: "param";
  /** Runtime key to look up in params map */
  key: string;
}

export interface IrIn {
  kind: "in";
  left: IrNode;
  right: IrNode; // IrConst with array value or IrParam
}

export interface IrCall {
  kind: "call";
  /** e.g. "startsWith", "includes" */
  method: string;
  receiver: IrNode;
  args: IrNode[];
}

export type OrderDirection = "asc" | "desc";

export interface IrOrderBy {
  param: string;
  path: string[];
  direction: OrderDirection;
}

export interface IrSelect {
  param: string;
  /** Empty = select all columns for this param */
  paths: string[][];
}

export function isIrNode(node: unknown): node is IrNode {
  if (node == null || typeof node !== "object") return false;
  const k = (node as { kind?: string }).kind;
  return (
    k === "binary" ||
    k === "unary" ||
    k === "member" ||
    k === "const" ||
    k === "param" ||
    k === "in" ||
    k === "call"
  );
}
