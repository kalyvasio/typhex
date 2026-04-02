/**
 * SQLite transaction scope: BEGIN DEFERRED/IMMEDIATE, SAVEPOINT nesting.
 */

import { Trx } from "../../orm/trx.js";

export class SqliteTrx extends Trx {
  static override readonly defaultOptions = {};

  protected validateOptions(): void {
    // Validate only user-provided options — defaults are always safe.
    const options = this._options;

    if (options.readOnly !== undefined) {
      throw new Error("TransactionOptions.readOnly is not supported by SQLite. Use sqliteMode: \"immediate\" or \"exclusive\" to control locking.");
    }
    if (options.deferrable !== undefined) {
      throw new Error("TransactionOptions.deferrable is not supported by SQLite.");
    }
    if (options.sqliteMode && options.isolationLevel) {
      throw new Error(
        "TransactionOptions.sqliteMode and isolationLevel are mutually exclusive for SQLite. " +
        "Use sqliteMode for native SQLite transaction modes, or isolationLevel: \"SERIALIZABLE\" for the ANSI level."
      );
    }
    if (options.isolationLevel && options.isolationLevel !== "SERIALIZABLE") {
      throw new Error(
        `SQLite does not support the "${options.isolationLevel}" isolation level. ` +
        `Only "SERIALIZABLE" is supported (mapped to BEGIN IMMEDIATE). ` +
        `Use sqliteMode: "immediate" | "exclusive" | "deferred" for fine-grained control.`
      );
    }
  }

  private compileBeginStatement(): string {
    // User-provided options take precedence over dialect defaults.
    // If the user explicitly set isolationLevel (without sqliteMode), map it and ignore the default sqliteMode.
    if (this._options?.sqliteMode) return `BEGIN ${this._options.sqliteMode.toUpperCase()}`;
    if (this._options?.isolationLevel === "SERIALIZABLE") return "BEGIN IMMEDIATE";
    // Fall back to effective options (default sqliteMode: "deferred").
    return `BEGIN ${(this._options.sqliteMode ?? "DEFERRED").toUpperCase()}`;
  }

  async begin(): Promise<void> {
    if (this._isNested) {
      await this._conn.execute(`SAVEPOINT ${this._savepointName}`, []);
    } else {
      await this._conn.execute(this.compileBeginStatement(), []);
      this._depth = 1;
    }
  }


  async commit(): Promise<void> {
    if (this._savepointName) {
      await this._conn.execute(`RELEASE SAVEPOINT ${this._savepointName}`, []);
    } else {
      await this._conn.execute("COMMIT", []);
      await this._cleanup?.();
    }
  }

  async rollback(): Promise<void> {
    if (this._savepointName) {
      await this._conn.execute(`ROLLBACK TO SAVEPOINT ${this._savepointName}`, []);
    } else {
      try { await this._conn.execute("ROLLBACK", []); } catch { /* ignore */ }
      await this._cleanup?.();
    }
  }


}
