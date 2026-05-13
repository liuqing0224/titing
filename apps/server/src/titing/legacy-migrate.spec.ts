jest.mock("./migration-runner", () => ({
  runMigrations: jest.fn(async () => undefined)
}));

import { migrateLegacySchema } from "./legacy-migrate";
import { runMigrations } from "./migration-runner";

describe("migrateLegacySchema", () => {
  it("renames legacy tables, runs migrations, and backfills data", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const tables = new Set(["tasks", "agents", "execution_logs"]);
    const columns = new Map<string, Set<string>>([
      ["tasks", new Set(["id", "task_type", "claimed_at", "agent_id"])],
      ["agents", new Set(["id", "container_name", "heartbeat_at"])],
      ["execution_logs", new Set(["id", "status", "metadata"])]
    ]);
    const legacyRows = {
      legacy_tasks: [{
        id: "task-1",
        source: "legacy",
        title: "Fix build",
        description: "legacy desc",
        repo: "repo",
        branch: "",
        priority: "high",
        status: "queued",
        constraints: ["safe"],
        retry_count: 2,
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:01.000Z"
      }],
      legacy_agents: [{
        id: "agent-1",
        status: "running",
        task_id: "task-1",
        container_name: "demo",
        container_id: "abc",
        heartbeat_at: "2026-05-11T00:00:02.000Z",
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:02.000Z"
      }],
      legacy_execution_logs: [{
        id: "log-1",
        task_id: "task-1",
        status: "done",
        agent_id: "agent-1",
        message: "finished",
        metadata: { step: "quality" },
        created_at: "2026-05-11T00:00:03.000Z"
      }]
    };
    const inserts = {
      tasks: [] as unknown[][],
      agents: [] as unknown[][],
      execution_logs: [] as unknown[][]
    };
    const pool = createPool(async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes("sqlite_master")) {
        return { rows: tables.has(String(values[0])) ? [{ name: values[0] }] : [], rowCount: tables.has(String(values[0])) ? 1 : 0 };
      }
      if (sql.includes("pragma_table_info")) {
        const tableName = String(values[0]);
        const columnName = String(values[1]);
        return {
          rows: columns.get(tableName)?.has(columnName) ? [{ name: columnName }] : [],
          rowCount: columns.get(tableName)?.has(columnName) ? 1 : 0
        };
      }
      if (sql === "alter table tasks rename to legacy_tasks") {
        tables.delete("tasks");
        tables.add("legacy_tasks");
        columns.set("legacy_tasks", columns.get("tasks") ?? new Set());
        columns.delete("tasks");
        return { rows: [], rowCount: 0 };
      }
      if (sql === "alter table agents rename to legacy_agents") {
        tables.delete("agents");
        tables.add("legacy_agents");
        columns.set("legacy_agents", columns.get("agents") ?? new Set());
        columns.delete("agents");
        return { rows: [], rowCount: 0 };
      }
      if (sql === "alter table execution_logs rename to legacy_execution_logs") {
        tables.delete("execution_logs");
        tables.add("legacy_execution_logs");
        columns.set("legacy_execution_logs", columns.get("execution_logs") ?? new Set());
        columns.delete("execution_logs");
        return { rows: [], rowCount: 0 };
      }
      if (sql === "select * from legacy_tasks") {
        return { rows: legacyRows.legacy_tasks, rowCount: legacyRows.legacy_tasks.length };
      }
      if (sql === "select * from legacy_agents") {
        return { rows: legacyRows.legacy_agents, rowCount: legacyRows.legacy_agents.length };
      }
      if (sql === "select * from legacy_execution_logs") {
        return { rows: legacyRows.legacy_execution_logs, rowCount: legacyRows.legacy_execution_logs.length };
      }
      if (sql.includes("insert into tasks")) {
        inserts.tasks.push(values);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into agents")) {
        inserts.agents.push(values);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into execution_logs")) {
        inserts.execution_logs.push(values);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await migrateLegacySchema(pool as any);

    expect(result).toEqual({
      renamedTables: [
        "tasks->legacy_tasks",
        "agents->legacy_agents",
        "execution_logs->legacy_execution_logs"
      ],
      migrated: {
        tasks: 1,
        agents: 1,
        executionLogs: 1
      }
    });
    expect(runMigrations).toHaveBeenCalledWith(pool);
    expect(String(inserts.tasks[0]?.[10])).toBe("legacy:task-1");
    expect(JSON.parse(String(inserts.agents[0]?.[4]))).toEqual({
      schemaVersion: "2026-05-11",
      data: ["legacy", "container_name:demo", "container_id:abc"]
    });
    expect(JSON.parse(String(inserts.execution_logs[0]?.[5]))).toEqual({
      schemaVersion: "2026-05-11",
      data: {
        legacySourceTable: "legacy_execution_logs",
        legacyStatus: "done",
        agentId: "agent-1",
        metadata: { step: "quality" }
      }
    });
    expect(queries.some((entry) => entry.sql.includes("sqlite_master"))).toBe(true);
  });

  it("is a no-op when no legacy schema is present", async () => {
    const pool = createPool(async (sql) => {
      if (sql.includes("sqlite_master") || sql.includes("pragma_table_info")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await migrateLegacySchema(pool as any);

    expect(result).toEqual({
      renamedTables: [],
      migrated: {
        tasks: 0,
        agents: 0,
        executionLogs: 0
      }
    });
    expect(runMigrations).toHaveBeenCalledWith(pool);
  });
});

function createPool(
  handler: (sql: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>
) {
  return {
    query: async (sql: string, values: unknown[] = []) => handler(sql, values)
  };
}
