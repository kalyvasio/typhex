import type { OnConflictClause } from "../dbs/types.js";
import type { AnyEntityClass, EntityInstance } from "../entity/entity.js";
import { getQueryCompilerOrThrow } from "./helpers/query-plan/query-plan.js";
import { buildQueryPlan, logSql } from "./query-execution-context.js";
import type { QueryState } from "./query-state.js";
import { Statement, type SqlAndParams } from "./statement.js";

type FetchInsertedRow<C extends AnyEntityClass> = (
  row: Record<string, unknown>,
) => Promise<EntityInstance<C> | undefined>;

/**
 * Deferred insert returned by `insert()` / `insertMany()`.
 * Awaitable directly, or chain `.onConflict(cols).doUpdate()` / `.doNothing()`.
 *
 * @example
 * await qb.insert(row);
 * await qb.insert(row).onConflict(["sku"]).doUpdate();
 * await qb.insertMany(rows).onConflict(["sku"]).doNothing();
 */
export class InsertBuilder<C extends AnyEntityClass, R> implements PromiseLike<R> {
  private conflictColumns?: string[];

  /** @internal */
  constructor(
    private readonly state: QueryState<EntityInstance<C>>,
    private readonly payload: Record<string, unknown> | Record<string, unknown>[],
    private readonly fetchInsertedRow: FetchInsertedRow<C>,
  ) {}

  /** Store the conflict target columns; returns `this` for chaining. */
  onConflict(columns: string[]): this {
    this.conflictColumns = columns;
    return this;
  }

  /** `ON CONFLICT (...) DO UPDATE SET ...`.
   *  Await to execute, or call `toSql()` to compile without executing. */
  doUpdate(updateColumns?: string[]): Statement<R> {
    return this.conflictStatement({
      conflictColumns: this.conflictColumns!,
      action: "update",
      updateColumns,
    });
  }

  /** `ON CONFLICT (...) DO NOTHING`.
   *  Await to execute, or call `toSql()` to compile without executing. */
  doNothing(): Statement<R> {
    return this.conflictStatement({
      conflictColumns: this.conflictColumns!,
      action: "nothing",
    });
  }

  /** PromiseLike: allows `await insert(row)` without a conflict clause. */
  then<T1 = R, T2 = never>(
    res?: ((value: R) => T1 | PromiseLike<T1>) | null,
    rej?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.execute().then(res, rej);
  }

  /** Compile the INSERT to SQL and bound parameters without executing it. */
  toSql(): SqlAndParams {
    return this.compilePayload();
  }

  private conflictStatement(clause: OnConflictClause): Statement<R> {
    return new Statement(
      () => this.execute(clause),
      () => this.compilePayload(clause),
    );
  }

  private execute(onConflict?: OnConflictClause): Promise<R> {
    return (
      Array.isArray(this.payload)
        ? this.insertMany(this.payload, onConflict)
        : this.insertOne(this.payload, onConflict)
    ) as Promise<R>;
  }

  private compilePayload(onConflict?: OnConflictClause): SqlAndParams {
    const { sql, params } = Array.isArray(this.payload)
      ? this.compileInsertMany(this.payload, onConflict)
      : this.compileInsert(this.payload, onConflict);
    return { sql, params };
  }

  private compileInsert(row: Record<string, unknown>, onConflict?: OnConflictClause) {
    const columns = this.state.columnNames.filter((column) => row[column] !== undefined);
    this.state.insertIr = undefined;
    return getQueryCompilerOrThrow(this.state).compilePlan(
      buildQueryPlan(this.state, {
        kind: "insert",
        columns,
        values: columns.map((column) => row[column]),
        pk: this.state.pkColumns,
        onConflict,
      }),
    );
  }

  private compileInsertMany(rows: Record<string, unknown>[], onConflict?: OnConflictClause) {
    const columns = this.state.columnNames.filter((column) =>
      rows.some((row) => row[column] !== undefined),
    );
    const paramRows = rows.map((row) => columns.map((column) => row[column] ?? null));
    this.state.insertIr = undefined;
    return getQueryCompilerOrThrow(this.state).compilePlan(
      buildQueryPlan(this.state, {
        kind: "insertMany",
        columns,
        rows: paramRows,
        pk: this.state.pkColumns,
        onConflict,
      }),
    );
  }

  private async insertOne(
    row: Record<string, unknown>,
    onConflict?: OnConflictClause,
  ): Promise<EntityInstance<C> | undefined> {
    const { qe, hydrate } = this.state;
    const compiled = this.compileInsert(row, onConflict);
    logSql(compiled.sql, compiled.params);

    if (compiled.returningRow) {
      const rows = (await qe.query(compiled.sql, compiled.params)) as Record<string, unknown>[];
      const raw = rows[0];
      if (raw == null) throw new Error("insert: RETURNING returned no row");
      return hydrate ? await hydrate(raw) : (raw as EntityInstance<C>);
    }

    const result = await qe.run(compiled.sql, compiled.params);
    const pkColumns = this.state.pkColumns;
    if (pkColumns.length === 0) return undefined;
    const pkRow =
      pkColumns.length === 1 && result.lastID != null
        ? { ...row, [pkColumns[0]]: result.lastID }
        : row;
    const inserted = await this.fetchInsertedRow(pkRow);
    if (!inserted) throw new Error("insert: insert succeeded but row not found");
    return inserted;
  }

  private async insertMany(
    rows: Record<string, unknown>[],
    onConflict?: OnConflictClause,
  ): Promise<EntityInstance<C>[]> {
    if (rows.length === 0) return [];
    const { qe, hydrate } = this.state;
    const compiled = this.compileInsertMany(rows, onConflict);
    logSql(compiled.sql, compiled.params);

    if (compiled.returningRow) {
      const returned = (await qe.query(compiled.sql, compiled.params)) as Record<string, unknown>[];
      if (!hydrate) return returned as EntityInstance<C>[];
      const hydrated: EntityInstance<C>[] = [];
      for (const row of returned) {
        hydrated.push(await hydrate(row));
      }
      return hydrated;
    }

    await qe.run(compiled.sql, compiled.params);
    return [];
  }
}
