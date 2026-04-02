/**
 * Base Trx class and active-transaction storage.
 * QueryExecutor interface lives in db.ts.
 * Kept in its own file to avoid circular imports:
 * dialect trx subclasses → this file (no orm/db.ts dependency).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Connection, TransactionOptions } from "../driver/types.js";
import type { Dialect } from "../dialect.js";

const _txStorage = new AsyncLocalStorage<Trx>();
export function getActiveTrx(): Trx | undefined { return _txStorage.getStore(); }
export function runInTrxStorage<T>(trx: Trx, fn: () => Promise<T>): Promise<T> {
  return _txStorage.run(trx, fn);
}

/** @internal */
interface TrxContext {
  spRoot: { n: number };
  isNested: boolean;
}

export abstract class Trx {
  /** Dialect-level defaults merged with user-provided options. Override in subclasses. */
  static readonly defaultOptions: TransactionOptions = {};

  protected _depth = 0;
  protected readonly _spRoot: { n: number };
  protected readonly _savepointName?: string;
  protected _cleanup?: () => Promise<void>;
  protected readonly _isNested: boolean;
  /** Effective options: dialect defaults merged with caller-provided options. */
  protected readonly _options: TransactionOptions;

  constructor(
    protected readonly _conn: Connection,
    options?: TransactionOptions,
    ctx?: TrxContext,
  ) {
    this._spRoot = ctx?.spRoot ?? { n: 0 };
    this._isNested = ctx?.isNested ?? false;
    this._savepointName = this._isNested ? `sp_${++this._spRoot.n}` : undefined;
    this._options = { ...(this.constructor as typeof Trx).defaultOptions, ...options };
    this.validateOptions();
  }

  // ── QueryExecutor ──────────────────────────────────────────────────────────

  get dialect(): Dialect { return this._conn.dialect; }

  query(sql: string, params?: unknown[]): Promise<unknown[]> {
    return this._conn.execute(sql, params).then(r => r.rows);
  }

  run(sql: string, params?: unknown[]): Promise<{ lastID?: number; changes: number }> {
    return this._conn.execute(sql, params).then(r => ({ lastID: r.lastID, changes: r.changes }));
  }

  // ── Callback API ───────────────────────────────────────────────────────────

  async transaction<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return !this._isNested && this._depth === 0
      ? this._beginTransaction(fn)
      : this._nestedTransaction(fn);
  }

  protected async _beginTransaction<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    await this.begin();
    try {
      const result = await fn(this);
      await this.commit();
      return result;
    } catch (e) {
      try { await this.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      this._depth = 0;
    }
  }

  protected async _nestedTransaction<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    const nested = await this.beginTrx();
    try {
      const result = await fn(nested);
      await nested.commit();
      return result;
    } catch (e) {
      await nested.rollback();
      throw e;
    }
  }

  // ── Explicit API ───────────────────────────────────────────────────────────

  /** Create a savepoint-scoped child Trx and begin it. */
  async beginTrx(): Promise<Trx> {
    const Ctor = this.constructor as new (conn: Connection, options?: TransactionOptions, ctx?: TrxContext) => Trx;
    const nested = new Ctor(this._conn, this._options, { spRoot: this._spRoot, isNested: true });
    await nested.begin();
    return nested;
  }

  /** Commit this transaction (COMMIT) or release the savepoint (RELEASE SAVEPOINT). */
  abstract commit(): Promise<void>;

  /** Roll back this transaction (ROLLBACK) or the savepoint (ROLLBACK TO SAVEPOINT). */
  abstract rollback(): Promise<void>;

  // ── Internals ─────────────────────────────────────────────────────────────

  /** @internal — set the connection-release callback and issue BEGIN. Called by Db.beginTrx(). */
  async _initRoot(cleanup: () => Promise<void>): Promise<void> {
    this._cleanup = cleanup;
    await this.begin();
  }

  /**
   * Validate options before beginning a root transaction.
   * Dialect subclasses override this to reject options that are unsupported or contradictory.
   * Only called for root transactions, not savepoints.
   */
  protected validateOptions(): void {}

  /** Issue BEGIN (root) or SAVEPOINT (nested). */
  protected abstract begin(): Promise<void>;
}
