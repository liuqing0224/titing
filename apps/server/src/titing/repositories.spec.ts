import {
  PgAgentRepository,
  PgExecutionLogRepository,
  PgPluginConfigRepository,
  PgRepairGoalRepository,
  PgTaskRepository
} from "./repositories";
import { AgentRecord, ExecutionLogRecord, PluginConfig, RepairGoal, TitingTask } from "@titing/plugin-api";

describe("PG repository JSON schema envelopes", () => {
  it("writes versioned envelopes for task JSON fields", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const pool = createPool(async (sql, values) => {
      queries.push({ sql, values });
      return { rows: [] };
    });
    const repository = new PgTaskRepository(pool);

    await repository.save(createTask());

    const values = queries[0]?.values ?? [];
    expect(values[11]).toEqual(JSON.stringify({ schemaVersion: "2026-05-11", data: ["safe"] }));
    expect(values[12]).toEqual(JSON.stringify({ schemaVersion: "2026-05-11", data: ["passes"] }));
    expect(values[13]).toEqual(JSON.stringify({ schemaVersion: "2026-05-11", data: { env: "dev" } }));
  });

  it("reads legacy and envelope task JSON formats", async () => {
    const legacyPool = createPool(async () => ({
      rows: [{
        id: "task-1",
        source: "manual",
        external_id: null,
        title: "Fix build",
        instruction: "do work",
        repo: "repo",
        branch: "main",
        priority: "medium",
        status: "queued",
        executor: "codex",
        trace_id: "trace-1",
        constraints_json: ["legacy"],
        acceptance_criteria_json: ["ok"],
        metadata_json: { mode: "legacy" },
        retry_count: 0,
        repair_count: 0,
        started_at: null,
        completed_at: null,
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z"
      }]
    }));
    const envelopePool = createPool(async () => ({
      rows: [{
        id: "task-2",
        source: "manual",
        external_id: null,
        title: "Fix build",
        instruction: "do work",
        repo: "repo",
        branch: "main",
        priority: "medium",
        status: "queued",
        executor: "codex",
        trace_id: "trace-2",
        constraints_json: { schemaVersion: "2026-05-11", data: ["wrapped"] },
        acceptance_criteria_json: { schemaVersion: "2026-05-11", data: ["good"] },
        metadata_json: { schemaVersion: "2026-05-11", data: { mode: "wrapped" } },
        retry_count: 0,
        repair_count: 0,
        started_at: null,
        completed_at: null,
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z"
      }]
    }));

    const legacy = await new PgTaskRepository(legacyPool).getById("task-1");
    const wrapped = await new PgTaskRepository(envelopePool).getById("task-2");

    expect(legacy).toEqual(expect.objectContaining({
      constraints: ["legacy"],
      acceptanceCriteria: ["ok"],
      metadata: { mode: "legacy" }
    }));
    expect(wrapped).toEqual(expect.objectContaining({
      constraints: ["wrapped"],
      acceptanceCriteria: ["good"],
      metadata: { mode: "wrapped" }
    }));
  });

  it("writes and reads envelopes for execution logs, agents, repair goals, and plugin configs", async () => {
    const logQueries: Array<{ values: unknown[] }> = [];
    const logPool = createPool(async (_sql, values) => {
      logQueries.push({ values });
      return { rows: [] };
    });
    await new PgExecutionLogRepository(logPool).append(createExecutionLog());
    expect(logQueries[0]?.values[5]).toEqual(
      JSON.stringify({ schemaVersion: "2026-05-11", data: { correlation: { traceId: "trace-1" } } })
    );

    const agentPool = createPool(async () => ({
      rows: [{
        id: "agent-1",
        status: "idle",
        task_id: null,
        executor: "codex",
        labels_json: { schemaVersion: "2026-05-11", data: ["local"] },
        last_heartbeat_at: "2026-05-11T00:00:00.000Z",
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z"
      }]
    }));
    const repairPool = createPool(async () => ({
      rows: [{
        id: "goal-1",
        task_id: "task-1",
        objective: "repair",
        constraints_json: { schemaVersion: "2026-05-11", data: ["no force push"] },
        done_when_json: { schemaVersion: "2026-05-11", data: ["tests pass"] },
        status: "repairing",
        iteration: 1,
        max_iterations: 3,
        last_failure_hash: null,
        created_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z"
      }]
    }));
    const pluginPool = createPool(async () => ({
      rows: [{
        id: "plugin-1",
        plugin_id: "meegle",
        kind: "task-integration",
        enabled: true,
        priority: 10,
        config_json: { schemaVersion: "2026-05-11", data: { mode: "poll" } },
        updated_at: "2026-05-11T00:00:00.000Z"
      }]
    }));

    expect(await new PgAgentRepository(agentPool).list()).toEqual([
      expect.objectContaining({ labels: ["local"] })
    ]);
    expect(await new PgRepairGoalRepository(repairPool).getByTaskId("task-1")).toEqual(
      expect.objectContaining({ constraints: ["no force push"], doneWhen: ["tests pass"] })
    );
    expect(await new PgPluginConfigRepository(pluginPool).getByPluginId("meegle")).toEqual(
      expect.objectContaining({ config: { mode: "poll" } })
    );
  });
});

function createPool(
  handler: (sql: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
) {
  return {
    query: async (sql: string, values: unknown[] = []) => handler(sql, values)
  } as any;
}

function createTask(): TitingTask {
  const now = new Date("2026-05-11T00:00:00.000Z");
  return {
    id: "task-1",
    source: "manual",
    externalId: null,
    title: "Fix build",
    instruction: "do work",
    repo: "repo",
    branch: "main",
    priority: "medium",
    status: "queued",
    executor: "codex",
    traceId: "trace-1",
    constraints: ["safe"],
    acceptanceCriteria: ["passes"],
    metadata: { env: "dev" },
    retryCount: 0,
    repairCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function createExecutionLog(): ExecutionLogRecord {
  return {
    id: "log-1",
    taskId: "task-1",
    executionId: "exec-1",
    eventType: "task.transition",
    message: "queued",
    data: { correlation: { traceId: "trace-1" } },
    createdAt: new Date("2026-05-11T00:00:00.000Z")
  };
}
