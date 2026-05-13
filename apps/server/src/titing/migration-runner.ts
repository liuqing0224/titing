/**
 * SQL 迁移：维护 `schema_migrations` 表，按文件名排序幂等执行 `*.sql`（优先 `dist` 下编译产物目录）。
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseClient } from "./database";
import { wrapMigrationError } from "./startup-errors";

/** 每个迁移文件单次事务，失败 rollback 后抛出带 `migration` 阶段的启动错误。 */
export async function runMigrations(pool: DatabaseClient): Promise<void> {
  try {
    await pool.query(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at text not null default current_timestamp
      )
    `);

    const distDir = join(__dirname, "migrations");
    const sourceDir = join(process.cwd(), "src", "titing", "migrations");
    const migrationsDir = existsSync(distDir) ? distDir : sourceDir;
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const existing = await pool.query("select id from schema_migrations where id = $1", [file]);
      if (existing.rowCount) {
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), "utf8");
      await pool.query("begin");
      try {
        await pool.query(sql);
        await pool.query("insert into schema_migrations (id) values ($1)", [file]);
        await pool.query("commit");
      } catch (error) {
        await pool.query("rollback");
        throw error;
      }
    }
  } catch (error) {
    throw wrapMigrationError(error);
  }
}
