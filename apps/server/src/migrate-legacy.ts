/**
 * CLI：在应用当前迁移前先检测并重命名旧表，再将历史数据填入新 schema（见 legacy-migrate）。
 */
import { createDatabase } from "./titing/database";
import { migrateLegacySchema } from "./titing/legacy-migrate";
import { formatStartupError, verifyDatabaseConnection } from "./titing/startup-errors";

async function main(): Promise<void> {
  const database = createDatabase();
  try {
    await verifyDatabaseConnection(database.pool);
    const result = await migrateLegacySchema(database.pool);
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    console.error(formatStartupError(error));
    process.exitCode = 1;
  } finally {
    await database.pool.end();
  }
}

void main();
