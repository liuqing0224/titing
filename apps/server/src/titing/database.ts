import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type QueryResultRow = Record<string, unknown>;

export type QueryResult = {
  rows: QueryResultRow[];
  rowCount: number;
};

export interface DatabaseClient {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}

export function createDatabase() {
  const databasePath = resolve(process.env.DATABASE_FILE ?? ".titing/sqlite/titing.sqlite");
  ensureParentDir(databasePath);
  const database = new DatabaseSync(databasePath);
  database.exec("pragma foreign_keys = on");
  database.exec("pragma journal_mode = wal");
  database.exec("pragma busy_timeout = 5000");

  const pool: DatabaseClient = {
    query: async (sql: string, values: unknown[] = []) => executeQuery(database, sql, values),
    end: async () => {
      database.close();
    }
  };

  return { pool, databasePath };
}

function executeQuery(database: DatabaseSync, sql: string, values: unknown[]): QueryResult {
  const normalizedSql = normalizeSql(sql);
  if (values.length === 0 && hasMultipleStatements(normalizedSql)) {
    database.exec(normalizedSql);
    return {
      rows: [],
      rowCount: 0
    };
  }
  const statement = database.prepare(normalizedSql);
  const boundValues = values.map(normalizeValue) as Array<string | number | bigint | Uint8Array | null>;

  if (/^\s*select\b/i.test(normalizedSql) || /\breturning\b/i.test(normalizedSql)) {
    const rows = statement.all(...boundValues) as QueryResultRow[];
    return {
      rows,
      rowCount: rows.length
    };
  }

  const result = statement.run(...boundValues);
  return {
    rows: [],
    rowCount: Number(result.changes ?? 0)
  };
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\$([0-9]+)/g, "?$1")
    .replace(/::jsonb/g, "")
    .replace(/::json/g, "")
    .replace(/::timestamptz/g, "")
    .replace(/::text/g, "");
}

function hasMultipleStatements(sql: string): boolean {
  const trimmed = sql.trim();
  const firstSemicolon = trimmed.indexOf(";");
  return firstSemicolon >= 0 && firstSemicolon < trimmed.length - 1;
}

function normalizeValue(value: unknown): string | number | bigint | Uint8Array | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "bigint"
    || value instanceof Uint8Array
  ) {
    return value;
  }
  return String(value);
}

function ensureParentDir(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}
