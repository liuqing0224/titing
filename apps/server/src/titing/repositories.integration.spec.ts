import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "./database";
import { runMigrations } from "./migration-runner";
import {
  PgAgentRepository,
  PgEvalResultRepository,
  PgExecutionLogRepository,
  PgExecutionRepository,
  PgPluginConfigRepository,
  PgRepairGoalRepository,
  PgTaskRepository,
  PgTaskTransitionRepository
} from "./repositories";
import {
  AgentRecord,
  EvalResult,
  ExecutionLogRecord,
  ExecutionRecord,
  PluginConfig,
  RepairGoal,
  TaskTransition,
  TitingTask
} from "@titing/plugin-api";

describe("SQLite repositories integration", () => {
  let workspaceDir: string;
  let databaseFile: string;
  let pool: Awaited<ReturnType<typeof createDatabase>>["pool"];

  beforeAll(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "titing-sqlite-repos-"));
    databaseFile = join(workspaceDir, "repos.sqlite");
    ({ pool } = withDatabaseFile(databaseFile, () => createDatabase()));
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it("round-trips tasks, transitions, executions, logs, eval results, and repair goals", async () => {
    const tasks = new PgTaskRepository(pool);
    const transitions = new PgTaskTransitionRepository(pool);
    const executions = new PgExecutionRepository(pool);
    const logs = new PgExecutionLogRepository(pool);
    const evalResults = new PgEvalResultRepository(pool);
    const repairGoals = new PgRepairGoalRepository(pool);

    const task = createTask();
    await tasks.create(task);
    await transitions.append(createTransition(task));
    await executions.create(createExecution(task.id));
    await logs.append(createExecutionLog(task.id));
    await evalResults.create(createEvalResult(task.id));
    await repairGoals.upsert(createRepairGoal(task.id));

    const fetchedTask = await tasks.getById(task.id);
    const traceTasks = await tasks.listByTraceId(task.traceId);
    const fetchedTransitions = await transitions.listByTraceId(task.traceId);
    const fetchedExecutions = await executions.listByTask(task.id);
    const latestExecution = await executions.getLatestByTask(task.id);
    const fetchedLogs = await logs.listByTask(task.id);
    const fetchedEvalResults = await evalResults.listByTask(task.id);
    const fetchedRepairGoal = await repairGoals.getByTaskId(task.id);

    expect(fetchedTask).toEqual(expect.objectContaining({
      id: task.id,
      constraints: ["safe"],
      acceptanceCriteria: ["build passes"],
      metadata: { env: "dev" }
    }));
    expect(traceTasks.map((item) => item.id)).toEqual([task.id]);
    expect(fetchedTransitions).toEqual([
      expect.objectContaining({
        taskId: task.id,
        traceId: task.traceId,
        to: "queued"
      })
    ]);
    expect(fetchedExecutions).toEqual([
      expect.objectContaining({
        id: "exec-1",
        taskId: task.id,
        status: "executing"
      })
    ]);
    expect(latestExecution?.id).toBe("exec-1");
    expect(fetchedLogs).toEqual([
      expect.objectContaining({
        taskId: task.id,
        data: { correlation: { traceId: task.traceId } }
      })
    ]);
    expect(fetchedEvalResults).toEqual([
      expect.objectContaining({
        taskId: task.id,
        report: { checks: [] }
      })
    ]);
    expect(fetchedRepairGoal).toEqual(expect.objectContaining({
      taskId: task.id,
      constraints: ["do not force push"],
      doneWhen: ["tests pass"]
    }));
  });

  it("supports task and agent claim semantics against SQLite", async () => {
    const tasks = new PgTaskRepository(pool);
    const agents = new PgAgentRepository(pool);
    const now = new Date("2026-05-11T00:05:00.000Z");
    const queuedTask = createTask();
    const secondTask = {
      ...createTask(),
      id: "task-2",
      externalId: "EXT-2",
      traceId: "trace-2",
      createdAt: new Date("2026-05-11T00:06:00.000Z"),
      updatedAt: new Date("2026-05-11T00:06:00.000Z")
    };
    const idleAgent = createAgent();

    await tasks.create(queuedTask);
    await tasks.create(secondTask);
    await agents.upsert(idleAgent);

    const claimedTask = await tasks.claimQueued(queuedTask.id, now);
    const missedTask = await tasks.claimQueued(queuedTask.id, now);
    const claimedAgent = await agents.claimIdle("codex", queuedTask.id, now);
    const missedAgent = await agents.claimIdle("codex", secondTask.id, now);

    expect(claimedTask).toEqual(expect.objectContaining({
      id: queuedTask.id,
      status: "running",
      startedAt: now
    }));
    expect(missedTask).toBeNull();
    expect(claimedAgent).toEqual(expect.objectContaining({
      id: idleAgent.id,
      status: "busy",
      taskId: queuedTask.id
    }));
    expect(missedAgent).toBeNull();
  });

  it("round-trips agents and plugin configs with envelope-backed fields", async () => {
    const agents = new PgAgentRepository(pool);
    const pluginConfigs = new PgPluginConfigRepository(pool);

    await agents.upsert(createAgent());
    await pluginConfigs.upsert(createPluginConfig());

    const storedAgents = await agents.list();
    const storedAgent = await agents.getById("agent-1");
    const storedPluginConfigs = await pluginConfigs.list();
    const storedPluginConfig = await pluginConfigs.getByPluginId("meegle");

    expect(storedAgents).toEqual([
      expect.objectContaining({
        id: "agent-1",
        labels: ["local", "gpu"]
      })
    ]);
    expect(storedAgent).toEqual(expect.objectContaining({
      id: "agent-1",
      status: "idle",
      labels: ["local", "gpu"]
    }));
    expect(storedPluginConfigs).toEqual([
      expect.objectContaining({
        pluginId: "meegle",
        config: { mode: "poll" }
      })
    ]);
    expect(storedPluginConfig).toEqual(expect.objectContaining({
      pluginId: "meegle",
      config: { mode: "poll" }
    }));
  });
});

async function truncateAll(pool: Awaited<ReturnType<typeof createDatabase>>["pool"]): Promise<void> {
  await pool.query("delete from eval_results");
  await pool.query("delete from execution_logs");
  await pool.query("delete from repair_goals");
  await pool.query("delete from executions");
  await pool.query("delete from task_transitions");
  await pool.query("delete from agents");
  await pool.query("delete from plugin_configs");
  await pool.query("delete from tasks");
}

function withDatabaseFile<T>(databaseFile: string, factory: () => T): T {
  const previous = process.env.DATABASE_FILE;
  process.env.DATABASE_FILE = databaseFile;
  try {
    return factory();
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_FILE;
    } else {
      process.env.DATABASE_FILE = previous;
    }
  }
}

function createTask(): TitingTask {
  const now = new Date("2026-05-11T00:00:00.000Z");
  return {
    id: "task-1",
    source: "manual",
    externalId: "EXT-1",
    title: "Fix build",
    instruction: "do work",
    repo: "repo",
    branch: "main",
    priority: "medium",
    status: "queued",
    executor: "codex",
    traceId: "trace-1",
    constraints: ["safe"],
    acceptanceCriteria: ["build passes"],
    metadata: { env: "dev" },
    retryCount: 0,
    repairCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function createTransition(task: TitingTask): TaskTransition {
  return {
    taskId: task.id,
    traceId: task.traceId,
    from: "pending",
    to: "queued",
    reason: "queued",
    operator: "api",
    timestamp: new Date("2026-05-11T00:00:01.000Z")
  };
}

function createExecution(taskId: string): ExecutionRecord {
  return {
    id: "exec-1",
    taskId,
    agentId: "agent-1",
    workspace: "/tmp/workspace",
    status: "executing",
    summary: "running",
    executor: "codex",
    startedAt: new Date("2026-05-11T00:00:02.000Z"),
    endedAt: null
  };
}

function createExecutionLog(taskId: string): ExecutionLogRecord {
  return {
    id: "log-1",
    taskId,
    executionId: "exec-1",
    eventType: "task.transition",
    message: "queued",
    data: { correlation: { traceId: "trace-1" } },
    createdAt: new Date("2026-05-11T00:00:03.000Z")
  };
}

function createEvalResult(taskId: string): EvalResult {
  return {
    id: "eval-1",
    taskId,
    executionId: "exec-1",
    passed: true,
    score: 100,
    riskLevel: "low",
    report: { checks: [] },
    createdAt: new Date("2026-05-11T00:00:04.000Z")
  };
}

function createRepairGoal(taskId: string): RepairGoal {
  return {
    id: "goal-1",
    taskId,
    objective: "repair",
    constraints: ["do not force push"],
    doneWhen: ["tests pass"],
    status: "repairing",
    currentIteration: 1,
    maxIterations: 3,
    lastFailureHash: null,
    createdAt: new Date("2026-05-11T00:00:05.000Z"),
    updatedAt: new Date("2026-05-11T00:00:05.000Z")
  };
}

function createAgent(): AgentRecord {
  return {
    id: "agent-1",
    status: "idle",
    taskId: null,
    executor: "codex",
    labels: ["local", "gpu"],
    lastHeartbeatAt: new Date("2026-05-11T00:00:06.000Z"),
    createdAt: new Date("2026-05-11T00:00:06.000Z"),
    updatedAt: new Date("2026-05-11T00:00:06.000Z")
  };
}

function createPluginConfig(): PluginConfig {
  return {
    id: "plugin-1",
    pluginId: "meegle",
    kind: "task-integration",
    enabled: true,
    priority: 10,
    config: { mode: "poll" },
    updatedAt: new Date("2026-05-11T00:00:07.000Z")
  };
}
