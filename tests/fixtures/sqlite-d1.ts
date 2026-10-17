import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function sqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' ||
    typeof value === 'bigint' || value instanceof Uint8Array) return value;
  throw new TypeError('Unsupported bound SQL value.');
}

export class SqliteD1 implements D1Database {
  readonly sqlite = new DatabaseSync(':memory:');

  constructor(migrations = ['0001_initial.sql', '0002_private_contact.sql', '0003_social_login.sql', '0004_threaded_discussions.sql', '0005_lesson_content.sql']) {
    for (const file of migrations) {
      this.sqlite.exec(readFileSync(join(process.cwd(), 'migrations', file), 'utf8'));
    }
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteStatement(this, query);
  }

  execute<T>(statement: SqliteStatement): D1Result<T> {
    const rows = this.sqlite.prepare(statement.query).all(...statement.values);
    const counters = this.sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS lastRowId').get();
    if (typeof counters?.changes !== 'number' || typeof counters.lastRowId !== 'number') throw new Error('Missing SQLite counters.');
    const changes = /^(?:SELECT|PRAGMA)\b/iu.test(statement.query) ? 0 : counters.changes;
    return {
      success: true, results: rows as T[],
      meta: { duration: 0, size_after: 0, rows_read: rows.length, rows_written: changes, last_row_id: counters.lastRowId, changed_db: changes > 0, changes },
    };
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteStatement) || statement.database !== this) throw new TypeError('Statement belongs to another database.');
        return this.execute<T>(statement);
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.sqlite.exec(query);
    return { count: 1, duration: 0 };
  }

  withSession(): D1DatabaseSession {
    throw new Error('Session bookmarks are not used by this in-memory test adapter.');
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('Database exports are not used by this in-memory test adapter.');
  }

  close(): void {
    this.sqlite.close();
  }
}

class SqliteStatement implements D1PreparedStatement {
  constructor(readonly database: SqliteD1, readonly query: string, readonly values: SQLInputValue[] = []) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteStatement(this.database, this.query, values.map(sqlValue));
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.database.execute<Record<string, unknown>>(this).results[0];
    if (!row) return null;
    if (column && !Object.hasOwn(row, column)) throw new Error('SQL column was not returned.');
    return (column ? row[column] : row) as T;
  }

  async run<T>(): Promise<D1Result<T>> {
    return this.database.execute<T>(this);
  }

  async all<T>(): Promise<D1Result<T>> {
    return this.database.execute<T>(this);
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw(): Promise<never> {
    throw new Error('Raw result arrays are not used by this in-memory test adapter.');
  }
}
