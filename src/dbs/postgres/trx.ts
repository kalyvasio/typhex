/**
 * PostgreSQL transaction scope: BEGIN [ISOLATION LEVEL ...], SAVEPOINT nesting.
 */

import { Trx } from "../../orm/trx.js";

export class PostgresTrx extends Trx {
  /** PostgreSQL default: READ COMMITTED (Postgres's own default isolation level). */
  static override readonly defaultOptions = { isolationLevel: "READ_COMMITTED" as const };

  protected validateOptions(): void {
    // sqliteMode must never appear — check user options (it can't come from our Postgres defaults).
    if (this._options?.sqliteMode !== undefined) {
      throw new Error("TransactionOptions.sqliteMode is not supported by PostgreSQL. Use isolationLevel, readOnly, or deferrable instead.");
    }
    // Deferrable preconditions apply to the effective options (user may have omitted isolationLevel,
    // relying on the default READ_COMMITTED — which is not valid for DEFERRABLE).
    if (this._options.deferrable) {
      if (this._options.isolationLevel !== "SERIALIZABLE") {
        throw new Error("TransactionOptions.deferrable requires isolationLevel: \"SERIALIZABLE\".");
      }
      if (!this._options.readOnly) {
        throw new Error("TransactionOptions.deferrable requires readOnly: true.");
      }
    }
  }

  private compileBeginStatement(): string {
    const parts: string[] = ["BEGIN"];
    const iso = this._options.isolationLevel?.replace(/_/g, " ");
    if (iso) parts.push(`ISOLATION LEVEL ${iso}`);
    if (this._options.readOnly) parts.push("READ ONLY");
    if (this._options.deferrable) parts.push("DEFERRABLE");
    return parts.join(" ");
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
