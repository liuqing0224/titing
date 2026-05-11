import { DatabaseClient } from "./database";

export type StartupStage = "connection" | "migration" | "bootstrap";

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

export async function verifyDatabaseConnection(pool: DatabaseClient): Promise<void> {
  try {
    await pool.query("select 1");
  } catch (error) {
    throw new DatabaseStartupError("connection", describeError("Unable to connect to SQLite", error), error);
  }
}

export function wrapMigrationError(error: unknown): DatabaseStartupError {
  if (error instanceof DatabaseStartupError) {
    return error;
  }
  return new DatabaseStartupError("migration", describeError("Failed to apply database migrations", error), error);
}

export function wrapBootstrapError(error: unknown): Error {
  if (error instanceof DatabaseStartupError) {
    return error;
  }
  return new Error(describeError("Server bootstrap failed", error), { cause: error });
}

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
