/**
 * 旧 SQLite 升级：识别旧表 → rename 为 `legacy_*` → 跑当前迁移 → 将数据灌入新 schema。
 */
import { DatabaseClient } from "./database";
import { runMigrations } from "./migration-runner";
import { wrapMigrationError } from "./startup-errors";

/** 回填/中间 JSON 与 `repositories` 中信封版本对齐。 */
const JSON_SCHEMA_VERSION = "2026-05-11";

export type LegacyMigrationResult = {
  renamedTables: string[];
  migrated: {
    tasks: number;
    agents: number;
    executionLogs: number;
  };
};

/** 幂等：无 legacy 检测命中时仍可安全重复调用（已通过 `schema_migrations` 跳过 SQL）。 */
export async function migrateLegacySchema(pool: DatabaseClient): Promise<LegacyMigrationResult> {
  try {
    const renamedTables: string[] = [];
    const legacyTasks = await detectLegacyTasks(pool);
    const legacyAgents = await detectLegacyAgents(pool);
    const legacyExecutionLogs = await detectLegacyExecutionLogs(pool);

    if (legacyTasks && !(await tableExists(pool, "legacy_tasks"))) {
      await pool.query("alter table tasks rename to legacy_tasks");
      renamedTables.push("tasks->legacy_tasks");
    }
    if (legacyAgents && !(await tableExists(pool, "legacy_agents"))) {
      await pool.query("alter table agents rename to legacy_agents");
      renamedTables.push("agents->legacy_agents");
    }
    if (legacyExecutionLogs && !(await tableExists(pool, "legacy_execution_logs"))) {
      await pool.query("alter table execution_logs rename to legacy_execution_logs");
      renamedTables.push("execution_logs->legacy_execution_logs");
    }

    await runMigrations(pool);

    const migrated = {
      tasks: await migrateLegacyTasks(pool),
      agents: await migrateLegacyAgents(pool),
      executionLogs: await migrateLegacyExecutionLogs(pool)
    };

    return { renamedTables, migrated };
  } catch (error) {
    throw wrapMigrationError(error);
  }
}

async function detectLegacyTasks(pool: DatabaseClient): Promise<boolean> {
  return (await tableExists(pool, "tasks"))
    && (await hasColumn(pool, "tasks", "task_type"))
    && !(await hasColumn(pool, "tasks", "trace_id"));
}

async function detectLegacyAgents(pool: DatabaseClient): Promise<boolean> {
  return (await tableExists(pool, "agents"))
    && (await hasColumn(pool, "agents", "container_name"))
    && !(await hasColumn(pool, "agents", "executor"));
}

async function detectLegacyExecutionLogs(pool: DatabaseClient): Promise<boolean> {
  return (await tableExists(pool, "execution_logs"))
    && (await hasColumn(pool, "execution_logs", "status"))
    && !(await hasColumn(pool, "execution_logs", "event_type"));
}

async function migrateLegacyTasks(pool: DatabaseClient): Promise<number> {
  if (!(await tableExists(pool, "legacy_tasks"))) {
    return 0;
  }

  const result = await pool.query("select * from legacy_tasks");
  for (const row of result.rows) {
    const id = String(row.id);
    await pool.query(
      `insert into tasks (
        id, source, external_id, title, instruction, repo, branch, priority, status, executor, trace_id,
        constraints_json, acceptance_criteria_json, metadata_json, retry_count, repair_count, started_at,
        completed_at, created_at, updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
      )
      on conflict (id) do update set
        source = excluded.source,
        external_id = excluded.external_id,
        title = excluded.title,
        instruction = excluded.instruction,
        repo = excluded.repo,
        branch = excluded.branch,
        priority = excluded.priority,
        status = excluded.status,
        executor = excluded.executor,
        trace_id = excluded.trace_id,
        constraints_json = excluded.constraints_json,
        acceptance_criteria_json = excluded.acceptance_criteria_json,
        metadata_json = excluded.metadata_json,
        retry_count = excluded.retry_count,
        repair_count = excluded.repair_count,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at`,
      [
        id,
        normalizeString(row.source) || "manual",
        nullableString(row.external_id),
        String(row.title ?? id),
        normalizeString(row.instruction) || normalizeString(row.description) || String(row.title ?? id),
        String(row.repo ?? ""),
        normalizeString(row.branch) || "main",
        normalizePriority(row.priority),
        normalizeTaskStatus(row.status),
        "codex",
        `legacy:${id}`,
        JSON.stringify(wrapArray(parseJsonArray(row.constraints))),
        JSON.stringify(wrapArray([])),
        JSON.stringify(wrapObject(stripNullValues({
          legacySourceTable: "legacy_tasks",
          description: nullableString(row.description),
          taskType: nullableString(row.task_type),
          claimedAt: nullableString(row.claimed_at),
          legacyAgentId: nullableString(row.agent_id)
        }))),
        Number(row.retry_count ?? 0),
        0,
        nullableString(row.started_at),
        nullableString(row.completed_at),
        String(row.created_at ?? new Date().toISOString()),
        String(row.updated_at ?? row.created_at ?? new Date().toISOString())
      ]
    );
  }
  return result.rows.length;
}

async function migrateLegacyAgents(pool: DatabaseClient): Promise<number> {
  if (!(await tableExists(pool, "legacy_agents"))) {
    return 0;
  }

  const result = await pool.query("select * from legacy_agents");
  for (const row of result.rows) {
    const labels = ["legacy"];
    if (nullableString(row.container_name)) {
      labels.push(`container_name:${String(row.container_name)}`);
    }
    if (nullableString(row.container_id)) {
      labels.push(`container_id:${String(row.container_id)}`);
    }

    await pool.query(
      `insert into agents (
        id, status, task_id, executor, labels_json, last_heartbeat_at, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (id) do update set
        status = excluded.status,
        task_id = excluded.task_id,
        executor = excluded.executor,
        labels_json = excluded.labels_json,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at`,
      [
        String(row.id),
        normalizeAgentStatus(row.status),
        nullableString(row.task_id),
        "codex",
        JSON.stringify(wrapArray(labels)),
        String(row.heartbeat_at ?? row.updated_at ?? row.created_at ?? new Date().toISOString()),
        String(row.created_at ?? new Date().toISOString()),
        String(row.updated_at ?? row.created_at ?? new Date().toISOString())
      ]
    );
  }
  return result.rows.length;
}

async function migrateLegacyExecutionLogs(pool: DatabaseClient): Promise<number> {
  if (!(await tableExists(pool, "legacy_execution_logs"))) {
    return 0;
  }

  const result = await pool.query("select * from legacy_execution_logs");
  for (const row of result.rows) {
    await pool.query(
      `insert into execution_logs (
        id, task_id, execution_id, event_type, message, data_json, created_at
      ) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (id) do update set
        task_id = excluded.task_id,
        execution_id = excluded.execution_id,
        event_type = excluded.event_type,
        message = excluded.message,
        data_json = excluded.data_json,
        created_at = excluded.created_at`,
      [
        String(row.id),
        String(row.task_id),
        null,
        "legacy.execution_log",
        String(row.message ?? ""),
        JSON.stringify(wrapObject(stripNullValues({
          legacySourceTable: "legacy_execution_logs",
          legacyStatus: nullableString(row.status),
          agentId: nullableString(row.agent_id),
          metadata: parseJsonObject(row.metadata)
        }))),
        String(row.created_at ?? new Date().toISOString())
      ]
    );
  }
  return result.rows.length;
}

async function tableExists(pool: DatabaseClient, tableName: string): Promise<boolean> {
  const result = await pool.query(
    "select name from sqlite_master where type = 'table' and name = $1 limit 1",
    [tableName]
  );
  return result.rowCount > 0;
}

async function hasColumn(pool: DatabaseClient, tableName: string, columnName: string): Promise<boolean> {
  const result = await pool.query(
    "select name from pragma_table_info($1) where name = $2 limit 1",
    [tableName, columnName]
  );
  return result.rowCount > 0;
}

function wrapArray(values: string[]) {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    data: values
  };
}

function wrapObject(values: Record<string, unknown>) {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    data: values
  };
}

function parseJsonArray(value: unknown): string[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map(String);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stripNullValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function normalizeString(value: unknown): string {
  return nullableString(value) ?? "";
}

function normalizePriority(value: unknown): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}

function normalizeTaskStatus(value: unknown): "pending" | "queued" | "running" | "done" | "failed" {
  if (value === "pending" || value === "queued" || value === "running" || value === "done" || value === "failed") {
    return value;
  }
  return "pending";
}

function normalizeAgentStatus(value: unknown): "idle" | "busy" | "offline" {
  if (value === "running") {
    return "busy";
  }
  if (value === "idle" || value === "busy" || value === "offline") {
    return value;
  }
  return "idle";
}
