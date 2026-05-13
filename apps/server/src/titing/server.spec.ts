import { InMemoryEventStream } from "./event-stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildServerWithState, seedAgents } from "./server";
import { CONFIG_DEFAULTS, ServerConfig } from "./config";
import { createBuiltinPlugins } from "./plugins";
import { NotFoundError, TitingServices } from "@titing/core";
import {
  AgentRecord,
  CreateTaskInput,
  EvalResult,
  ExecutionLogRecord,
  ExecutionRecord,
  ObservabilityEvent,
  PluginConfig,
  RepairGoal,
  TaskTransition,
  TitingTask
} from "@titing/plugin-api";

const execFileAsync = promisify(execFile);

describe("titing server handlers", () => {
  it("revives seeded offline agents on startup so queued tasks remain dispatchable", async () => {
    const existingOffline = {
      ...createAgent(),
      id: "codex-agent-1",
      status: "offline" as const,
      executor: "codex",
      taskId: null,
      lastHeartbeatAt: new Date("2026-05-10T00:00:00.000Z"),
      updatedAt: new Date("2026-05-10T00:00:00.000Z")
    };
    const upserts: AgentRecord[] = [];
    const services = {
      listAgents: async () => [existingOffline],
      upsertAgent: async (agent: AgentRecord) => {
        upserts.push(agent);
      }
    } as Pick<TitingServices, "listAgents" | "upsertAgent"> as TitingServices;

    await seedAgents(services, 1);

    expect(upserts).toEqual([
      expect.objectContaining({
        id: "codex-agent-1",
        status: "idle",
        executor: "codex",
        taskId: null
      }),
      expect.objectContaining({
        id: "cursor-agent-1",
        status: "idle",
        executor: "cursor",
        taskId: null
      })
    ]);
  });

  it("returns structured health and readiness payloads", async () => {
    const server = await buildServerWithState(createState(), { startScheduler: false });
    try {
      const health = await server.inject({ method: "GET", url: "/api/health" });
      const readiness = await server.inject({ method: "GET", url: "/api/readiness" });

      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual(expect.objectContaining({
        ok: true,
        status: "alive",
        schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION,
        service: "titing"
      }));
      expect(readiness.statusCode).toBe(200);
      expect(readiness.json()).toEqual(expect.objectContaining({
        ok: true,
        status: "ready",
        schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION
      }));
    } finally {
      await server.close();
    }
  });

  it("keeps readiness green when no quality plugin is registered", async () => {
    const state = createState({
      listPlugins: async () => createPlugins().filter((plugin) => plugin.kind !== "quality")
    });
    const server = await buildServerWithState(state, { startScheduler: false });
    try {
      const readiness = await server.inject({ method: "GET", url: "/api/readiness" });

      expect(readiness.statusCode).toBe(200);
      expect(readiness.json()).toEqual(expect.objectContaining({
        ok: true,
        status: "ready",
        checks: expect.objectContaining({
          plugins: expect.objectContaining({
            ok: true,
            requiredKinds: {
              environment: true,
              execution: true,
              "observability-governance": true
            }
          })
        })
      }));
    } finally {
      await server.close();
    }
  });

  it("validates task creation payloads before calling the service", async () => {
    const state = createState();
    const server = await buildServerWithState(state, { startScheduler: false });
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "missing fields" }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "title, instruction, and repo are required" });
      expect(state.calls.createTask).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("uses configured default executor for manual task creation when request omits executor", async () => {
    const state = createState();
    const server = await buildServerWithState(state, { startScheduler: false });
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          title: "Fix build",
          instruction: "Run build and fix errors",
          repo: "https://example.com/repo.git"
        }
      });

      expect(response.statusCode).toBe(201);
      expect(state.calls.createTask).toHaveLength(1);
      expect(state.calls.createTask[0]).toEqual(expect.objectContaining({
        executor: "codex"
      }));
    } finally {
      await server.close();
    }
  });

  it("serves trace aggregates from the trace endpoint", async () => {
    const state = createState();
    const server = await buildServerWithState(state, { startScheduler: false });
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/traces/trace-shared"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expect.objectContaining({
        schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION,
        traceId: "trace-shared",
        tasks: [expect.objectContaining({ id: "task-1" })],
        transitions: [expect.objectContaining({ taskId: "task-1", to: "queued" })]
      }));
      expect(state.calls.getTraceView).toEqual(["trace-shared"]);
    } finally {
      await server.close();
    }
  });

  it("exposes manual sync and dispatch debug handlers", async () => {
    const state = createState();
    const server = await buildServerWithState(state, { startScheduler: false });
    try {
      const sync = await server.inject({ method: "POST", url: "/api/debug/sync" });
      const dispatch = await server.inject({ method: "POST", url: "/api/debug/scheduler" });

      expect(sync.statusCode).toBe(200);
      expect(sync.json()).toEqual({ integrations: 1, pulledTasks: 2 });
      expect(dispatch.statusCode).toBe(200);
      expect(dispatch.json()).toEqual({ queuedBefore: 3 });
      expect(state.calls.runTaskSyncNow).toBe(1);
      expect(state.calls.runSchedulerDispatchNow).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("aggregates global ops events into ranked counts and abnormal tasks", async () => {
    const state = createState({
      listTasks: async () => [
        createTask(),
        {
          ...createTask(),
          id: "task-2",
          title: "Repair tests",
          status: "blocked",
          traceId: "trace-2",
          retryCount: 2,
          repairCount: 1
        }
      ]
    });
    await seedOpsEvents(state.events);
    const server = await buildServerWithState(state, { startScheduler: false });
    try {
      const response = await server.inject({ method: "GET", url: "/api/ops/events" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        focusEventTypes: expect.arrayContaining([
          "execution.blocked",
          "execution.retry_scheduled",
          "scheduler.tick_skipped",
          "agent.offline",
          "plugin.integration_skipped"
        ]),
        watchedEventCount: 5,
        eventTypeCounts: {
          "execution.blocked": 1,
          "execution.retry_scheduled": 2,
          "scheduler.tick_skipped": 1,
          "agent.offline": 1
        },
        eventTypeRanking: [
          { eventType: "execution.retry_scheduled", count: 2 },
          { eventType: "agent.offline", count: 1 },
          { eventType: "execution.blocked", count: 1 },
          { eventType: "scheduler.tick_skipped", count: 1 }
        ],
        recentAbnormalTasks: [
          expect.objectContaining({
            taskId: "task-1",
            title: "Fix build",
            eventType: "execution.retry_scheduled"
          }),
          expect.objectContaining({
            taskId: "task-2",
            title: "Repair tests",
            eventType: "execution.blocked"
          })
        ]
      });
    } finally {
      await server.close();
    }
  });

  it("maps service not found and invalid transition errors to HTTP status codes", async () => {
    const state = createState({
      getTask: async () => {
        throw new NotFoundError("Task missing");
      },
      retryTask: async () => {
        const error = new Error("bad transition");
        error.name = "InvalidTransitionError";
        throw error;
      }
    });
    const server = await buildServerWithState(state, { startScheduler: false });
    try {
      const missing = await server.inject({ method: "GET", url: "/api/tasks/missing" });
      const invalid = await server.inject({ method: "POST", url: "/api/tasks/task-1/retry" });

      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "Task missing" });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: "bad transition" });
    } finally {
      await server.close();
    }
  });

  it("accepts Meegle webhook tasks when webhook mode and secret are valid", async () => {
    const state = createState();
    const server = await buildServerWithState(state, { startScheduler: false });
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/integrations/meegle/webhook",
        headers: {
          "x-titing-webhook-secret": "secret-1"
        },
        payload: {
          task: {
            id: "MEEGLE-2",
            title: "Webhook task",
            instruction: "Fix from webhook",
            repo: "https://example.com/repo.git",
            branch: "main",
            executor: "codex"
          }
        }
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        accepted: 1,
        externalIds: ["MEEGLE-2"]
      });
      expect(state.calls.ingestTaskFromIntegration).toEqual([
        expect.objectContaining({
          externalId: "MEEGLE-2",
          source: "meegle"
        })
      ]);
    } finally {
      await server.close();
    }
  });

  it("rejects Meegle webhook requests with invalid secret and exposes Meegle health", async () => {
    const state = createState();
    const server = await buildServerWithState(state, { startScheduler: false });
    try {
      const denied = await server.inject({
        method: "POST",
        url: "/api/integrations/meegle/webhook",
        headers: {
          "x-titing-webhook-secret": "wrong"
        },
        payload: {
          task: { id: "MEEGLE-3", title: "bad", instruction: "bad", repo: "repo" }
        }
      });
      const health = await server.inject({
        method: "GET",
        url: "/api/integrations/meegle/health"
      });

      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: "Invalid Meegle webhook secret" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({
        ok: true,
        pluginId: "meegle",
        healthy: true,
        message: "Meegle webhook integration ready"
      });
    } finally {
      await server.close();
    }
  });

  it("exposes Meegle browser authorization routes from the plugin registry", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-server-meegle-auth-"));
    const previousAuthState = process.env.MEEGLE_TEST_AUTH_STATE;
    try {
      const bin = join(sandbox, "fake-meegle");
      await writeServerFakeMeegleCli(bin);
      process.env.MEEGLE_TEST_AUTH_STATE = "unauthenticated";

      const state = createState();
      state.config = {
        ...state.config,
        plugins: {
          ...state.config.plugins,
          meegle: {
            ...state.config.plugins.meegle,
            mode: "polling",
            cliBin: bin,
            tasksFile: null,
            resultsFile: null,
            webhookSecret: null
          }
        }
      };
      state.plugins = createBuiltinPlugins(state.config);
      const server = await buildServerWithState(state, { startScheduler: false });
      try {
        const status = await server.inject({ method: "GET", url: "/api/integrations/meegle/auth/status" });
        const start = await server.inject({ method: "POST", url: "/api/integrations/meegle/auth/start" });
        const started = start.json();
        const pending = await server.inject({
          method: "POST",
          url: "/api/integrations/meegle/auth/poll",
          payload: {
            deviceCode: started.deviceCode,
            clientId: started.clientId,
            intervalSeconds: started.intervalSeconds,
            expiresInSeconds: started.expiresInSeconds
          }
        });
        process.env.MEEGLE_TEST_AUTH_STATE = "authenticated";
        const authenticated = await server.inject({
          method: "POST",
          url: "/api/integrations/meegle/auth/poll",
          payload: {
            deviceCode: started.deviceCode,
            clientId: started.clientId,
            intervalSeconds: started.intervalSeconds,
            expiresInSeconds: started.expiresInSeconds
          }
        });

        expect(status.statusCode).toBe(200);
        expect(status.json()).toEqual(expect.objectContaining({
          status: "unauthenticated",
          authenticated: false
        }));
        expect(start.statusCode).toBe(200);
        expect(started).toEqual(expect.objectContaining({
          status: "pending",
          authorizationUrl: "https://project.feishu.cn/auth/device"
        }));
        expect(pending.statusCode).toBe(200);
        expect(pending.json()).toEqual(expect.objectContaining({
          status: "pending",
          authenticated: false
        }));
        expect(authenticated.statusCode).toBe(200);
        expect(authenticated.json()).toEqual(expect.objectContaining({
          status: "authenticated",
          authenticated: true
        }));
      } finally {
        await server.close();
      }
    } finally {
      process.env.MEEGLE_TEST_AUTH_STATE = previousAuthState;
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

function createState(overrides: Partial<RouteServiceMocks> = {}) {
  const calls = {
    createTask: [] as CreateTaskInput[],
    getTraceView: [] as string[],
    runTaskSyncNow: 0,
    runSchedulerDispatchNow: 0,
    ingestTaskFromIntegration: [] as TitingTask[]
  };
  const task = createTask();
  const traceView = {
    schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION,
    traceId: "trace-shared",
    tasks: [task],
    transitions: [createTransition(task)],
    executions: [createExecution(task.id)],
    executionLogs: [createExecutionLog(task.id)],
    evalResults: [createEvalResult(task.id)],
    repairGoals: [createRepairGoal(task.id)]
  };
  const services: RouteServiceMocks = {
    createTask: async (input) => {
      calls.createTask.push(input);
      return task;
    },
    listTasks: async () => [task],
    getTask: async () => task,
    validateTask: async () => ({ ...task, status: "validated" }),
    queueTask: async () => ({ ...task, status: "queued" }),
    retryTask: async () => ({ ...task, status: "queued" }),
    blockTask: async () => ({ ...task, status: "blocked" }),
    markNeedsHuman: async () => ({ ...task, status: "needs_human" }),
    recoverTask: async () => ({ ...task, status: "queued" }),
    cancelTask: async () => ({ ...task, status: "cancelled" }),
    listExecutions: async () => [createExecution(task.id)],
    listTaskTransitions: async () => [createTransition(task)],
    listExecutionLogs: async () => [createExecutionLog(task.id)],
    getTaskObservability: async () => ({
      schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION,
      taskId: task.id,
      transitions: [createTransition(task)],
      executionLogs: [createExecutionLog(task.id)]
    }),
    getTraceView: async (traceId) => {
      calls.getTraceView.push(traceId);
      return { ...traceView, traceId };
    },
    listEvalResults: async () => [createEvalResult(task.id)],
    getRepairGoal: async () => createRepairGoal(task.id),
    listAgents: async () => [createAgent()],
    heartbeatAgent: async () => createAgent(),
    disableAgent: async () => ({ ...createAgent(), status: "disabled" }),
    enableAgent: async () => createAgent(),
    recoverAgent: async () => createAgent(),
    listPlugins: async () => createPlugins(),
    listPluginConfigs: async () => [createPluginConfig()],
    upsertPluginConfig: async (input) => ({
      ...createPluginConfig(),
      pluginId: input.pluginId,
      kind: input.kind,
      enabled: input.enabled,
      priority: input.priority,
      config: input.config
    }),
    dashboard: async () => ({
      tasks: { total: 1, byStatus: { queued: 1 } },
      agents: { total: 1, byStatus: { idle: 1 } },
      plugins: { total: 4, healthy: 4 }
    }),
    runTaskSyncNow: async () => {
      calls.runTaskSyncNow += 1;
      return { integrations: 1, pulledTasks: 2 };
    },
    runSchedulerDispatchNow: async () => {
      calls.runSchedulerDispatchNow += 1;
      return { queuedBefore: 3 };
    },
    runSchedulerTick: async () => undefined,
    upsertAgent: async () => undefined,
    ingestTaskFromIntegration: async (task) => {
      calls.ingestTaskFromIntegration.push(task);
      return task;
    },
    ...overrides
  };

  return {
    services,
    calls,
    events: new InMemoryEventStream(),
    config: createConfig(),
    plugins: createBuiltinPlugins(createConfig()),
    pool: {
      query: async () => ({ rows: [], rowCount: 0 }),
      end: async () => undefined
    }
  };
}

type RouteServiceMocks = Pick<
  TitingServices,
  | "createTask"
  | "listTasks"
  | "getTask"
  | "validateTask"
  | "queueTask"
  | "retryTask"
  | "blockTask"
  | "markNeedsHuman"
  | "recoverTask"
  | "cancelTask"
  | "listExecutions"
  | "listTaskTransitions"
  | "listExecutionLogs"
  | "getTaskObservability"
  | "getTraceView"
  | "listEvalResults"
  | "getRepairGoal"
  | "listAgents"
  | "heartbeatAgent"
  | "disableAgent"
  | "enableAgent"
  | "recoverAgent"
  | "listPlugins"
  | "listPluginConfigs"
  | "upsertPluginConfig"
  | "dashboard"
  | "runTaskSyncNow"
  | "runSchedulerDispatchNow"
  | "runSchedulerTick"
  | "upsertAgent"
  | "ingestTaskFromIntegration"
>;

function createConfig(): ServerConfig {
  return {
    ...CONFIG_DEFAULTS,
    workspace: {
      ...CONFIG_DEFAULTS.workspace,
      root: "/tmp/titing-workspaces",
      repoCacheRoot: "/tmp/titing-repos"
    },
    plugins: {
      ...CONFIG_DEFAULTS.plugins,
      execution: {
        ...CONFIG_DEFAULTS.plugins.execution,
        defaultExecutor: "codex"
      },
      meegle: {
        mode: "webhook",
        tasksFile: null,
        resultsFile: null,
        webhookSecret: "secret-1"
      }
    }
  };
}

function createTask(): TitingTask {
  const now = new Date("2026-05-11T00:00:00.000Z");
  return {
    id: "task-1",
    source: "manual",
    externalId: null,
    title: "Fix build",
    instruction: "Run build and fix errors",
    repo: "repo",
    branch: "main",
    priority: "medium",
    status: "queued",
    executor: "codex",
    traceId: "trace-shared",
    constraints: [],
    acceptanceCriteria: [],
    metadata: {},
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
    from: "created",
    to: "queued",
    reason: "queued",
    operator: "api",
    timestamp: new Date("2026-05-11T00:01:00.000Z")
  };
}

function createExecution(taskId: string): ExecutionRecord {
  return {
    id: "execution-1",
    taskId,
    agentId: "agent-1",
    workspace: "/tmp/task-1",
    status: "completed",
    summary: "done",
    executor: "codex",
    startedAt: new Date("2026-05-11T00:02:00.000Z"),
    endedAt: new Date("2026-05-11T00:03:00.000Z")
  };
}

function createExecutionLog(taskId: string): ExecutionLogRecord {
  return {
    id: "log-1",
    taskId,
    executionId: "execution-1",
    eventType: "task.transition",
    message: "queued",
    data: { to: "queued" },
    createdAt: new Date("2026-05-11T00:01:00.000Z")
  };
}

function createEvalResult(taskId: string): EvalResult {
  return {
    id: "eval-1",
    taskId,
    executionId: "execution-1",
    passed: true,
    score: 100,
    riskLevel: "low",
    report: {},
    createdAt: new Date("2026-05-11T00:03:30.000Z")
  };
}

function createRepairGoal(taskId: string): RepairGoal {
  return {
    id: "goal-1",
    taskId,
    objective: "repair build",
    constraints: [],
    doneWhen: ["tests pass"],
    status: "achieved",
    currentIteration: 1,
    maxIterations: 3,
    lastFailureHash: null,
    createdAt: new Date("2026-05-11T00:03:00.000Z"),
    updatedAt: new Date("2026-05-11T00:04:00.000Z")
  };
}

function createAgent(): AgentRecord {
  const now = new Date("2026-05-11T00:00:00.000Z");
  return {
    id: "agent-1",
    status: "idle",
    taskId: null,
    executor: "codex",
    labels: ["local"],
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function createPluginConfig(): PluginConfig {
  return {
    id: "plugin-config-1",
    pluginId: "meegle",
    kind: "task-integration",
    enabled: true,
    priority: 10,
    config: { mode: "poll" },
    updatedAt: new Date("2026-05-11T00:00:00.000Z")
  };
}

function createPlugins() {
  return [
    {
      id: "env",
      kind: "environment" as const,
      priority: 100,
      capabilities: ["local"],
      health: { healthy: true, message: "ok" }
    },
    {
      id: "codex",
      kind: "execution" as const,
      priority: 100,
      capabilities: ["codex"],
      health: { healthy: true, message: "ok" }
    },
    {
      id: "quality",
      kind: "quality" as const,
      priority: 100,
      capabilities: ["checks"],
      health: { healthy: true, message: "ok" }
    },
    {
      id: "governance",
      kind: "observability-governance" as const,
      priority: 100,
      capabilities: ["events"],
      health: { healthy: true, message: "ok" }
    }
  ];
}

async function seedOpsEvents(stream: InMemoryEventStream): Promise<void> {
  const base = new Date("2026-05-11T00:00:00.000Z");
  const events: ObservabilityEvent[] = [
    createOpsEvent({
      id: "event-1",
      taskId: "task-1",
      traceId: "trace-shared",
      eventType: "execution.retry_scheduled",
      message: "Execution failure scheduled for retry",
      createdAt: new Date(base.getTime() + 1_000)
    }),
    createOpsEvent({
      id: "event-2",
      taskId: "task-2",
      traceId: "trace-2",
      eventType: "execution.blocked",
      message: "Execution failure blocked task",
      createdAt: new Date(base.getTime() + 2_000)
    }),
    createOpsEvent({
      id: "event-3",
      traceId: "scheduler",
      eventType: "scheduler.tick_skipped",
      message: "Scheduler tick skipped",
      createdAt: new Date(base.getTime() + 3_000)
    }),
    createOpsEvent({
      id: "event-4",
      taskId: "task-1",
      traceId: "trace-shared",
      eventType: "execution.retry_scheduled",
      message: "Execution failure scheduled for retry",
      createdAt: new Date(base.getTime() + 4_000)
    }),
    createOpsEvent({
      id: "event-5",
      traceId: "agent:agent-1",
      eventType: "agent.offline",
      message: "Agent marked offline after heartbeat timeout",
      createdAt: new Date(base.getTime() + 5_000)
    })
  ];

  for (const event of events) {
    await stream.publish(event);
  }
}

function createOpsEvent(
  input: Partial<ObservabilityEvent> & Pick<ObservabilityEvent, "id" | "traceId" | "eventType" | "message" | "createdAt">
): ObservabilityEvent {
  return {
    schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION,
    data: {},
    ...input
  };
}

async function writeServerFakeMeegleCli(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const print = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "auth" && args[1] === "status") {
  if (process.env.MEEGLE_TEST_AUTH_STATE === "unauthenticated") {
    process.stderr.write("Meegle authorization required");
    process.exit(1);
  }
  print({ authenticated: true, host: "project.feishu.cn" });
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login" && args.includes("--phase") && args.includes("init")) {
  print({
    authorization_url: "https://project.feishu.cn/auth/device",
    device_code: "device-123",
    client_id: "client-123",
    interval: 2,
    expires_in: 600
  });
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login" && args.includes("--phase") && args.includes("poll")) {
  if (process.env.MEEGLE_TEST_AUTH_STATE === "authenticated") {
    print({ authenticated: true, host: "project.feishu.cn" });
    process.exit(0);
  }
  print({ status: "pending", authenticated: false });
  process.exit(0);
}
process.exit(1);
`
  );
  await execFileAsync("chmod", ["+x", path]);
}
