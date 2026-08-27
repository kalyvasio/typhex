/** One secondary eager-load query compiled by `toSql()` (WHERE IN follow-up). */
export interface RelationFetchSql {
  /** Relation path, e.g. `"posts"` or `"posts (junction post_tags)"`. */
  relation: string;
  sql: string;
  params: unknown[];
}

/** Compiled SQL and bound parameters, as returned by `toSql()`. */
export interface SqlAndParams {
  sql: string;
  params: unknown[];
  /**
   * Secondary WHERE IN queries used to eager-load relations after the main SELECT.
   * Parent key values are shown as `«column»` sentinels (unknown until execution).
   */
  relationFetches?: RelationFetchSql[];
}

/**
 * Lazy terminal statement returned by query terminals: `await` it to execute,
 * or call `toSql()` to compile SQL and bound parameters without executing.
 */
export class Statement<T> implements PromiseLike<T> {
  private promise?: Promise<T>;

  /** @internal */
  constructor(
    private readonly run: () => Promise<T>,
    private readonly compile: () => SqlAndParams,
  ) {}

  /** Compile to SQL and bound parameters without executing. */
  toSql(): SqlAndParams {
    return this.compile();
  }

  then<T1 = T, T2 = never>(
    res?: ((value: T) => T1 | PromiseLike<T1>) | null,
    rej?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this.execute().then(res, rej);
  }

  catch<T2 = never>(rej?: ((reason: unknown) => T2 | PromiseLike<T2>) | null): Promise<T | T2> {
    return this.execute().catch(rej);
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.execute().finally(onFinally);
  }

  private execute(): Promise<T> {
    return (this.promise ??= this.run());
  }
}
