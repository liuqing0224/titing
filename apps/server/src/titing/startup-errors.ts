/**
 * 启动阶段错误类型与包装：连接 / 迁移 / 通用 bootstrap，供 `main` 统一 `formatStartupError` 输出。
 */
import { DatabaseClient } from "./database";

export type StartupStage = "connection" | "migration" | "bootstrap";

/** 带阶段的 DB 启动失败，文案前缀 `[database:${stage}]` 便于 grep。 */
export class DatabaseStartupError extends Error {
  constructor(
    readonly stage: StartupStage,
    message: string,
    readonly cause?: unknown
  ) {
    super(`[database:${stage}] ${message}`);
    this.name = "DatabaseStartupError";
  }
}

/** 首次 `select 1`，失败归类为 connection 阶段。 */
export async function verifyDatabaseConnection(pool: DatabaseClient): Promise<void> {
  try {
    await pool.query("select 1");
  } catch (error) {
    throw new DatabaseStartupError("connection", describeError("Unable to connect to SQLite", error), error);
  }
}

/** 迁移异常统一为 migration 阶段的 `DatabaseStartupError`。 */
export function wrapMigrationError(error: unknown): DatabaseStartupError {
  if (error instanceof DatabaseStartupError) {
    return error;
  }
  return new DatabaseStartupError("migration", describeError("Failed to apply database migrations", error), error);
}

/** 顶层 catch：沿用 DB 结构化错误，否则包一层通用 bootstrap 文案。 */
export function wrapBootstrapError(error: unknown): Error {
  if (error instanceof DatabaseStartupError) {
    return error;
  }
  return new Error(describeError("Server bootstrap failed", error), { cause: error });
}

/** 控制台输出：优先 `Error.message`。 */
export function formatStartupError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function describeError(prefix: string, error: unknown): string {
  if (error instanceof Error) {
    return `${prefix}: ${error.message}`;
  }
  return `${prefix}: ${String(error)}`;
}
