import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import {
  AgentRecord,
  CreateTaskInput,
  ObservabilityEvent,
  PluginConfigRepository,
  RuntimePlugin,
  TitingTask
} from "@titing/plugin-api";
import { NotFoundError, PluginRuntime, TitingServices } from "@titing/core";
import { readConfig, ServerConfig } from "./config";
import { createDatabase, DatabaseClient } from "./database";
import { EventStreamView } from "./event-stream";
import { isHttpRoutePlugin } from "./http-plugin";
import { FileExecutionLogRepository, FileLogEventStream } from "./log-adapters";
import { runMigrations } from "./migration-runner";
import { verifyDatabaseConnection } from "./startup-errors";
import {
  PgAgentRepository,
  PgEvalResultRepository,
  PgExecutionRepository,
  PgPluginConfigRepository,
  PgRepairGoalRepository,
  PgTaskRepository,
  PgTaskTransitionRepository
} from "./repositories";
import { createResolvedPlugins } from "./external-plugins";

type RouteServices = Pick<
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

type ServerPool = DatabaseClient;

type BootstrapState = {
  services: RouteServices;
  events: EventStreamView;
  pool: ServerPool;
  config: ServerConfig;
  plugins: RuntimePlugin[];
};

export async function buildServer(config: ServerConfig = readConfig()) {
  const database = createDatabase();
  try {
    await verifyDatabaseConnection(database.pool);
    await runMigrations(database.pool);
  } catch (error) {
    await database.pool.end().catch(() => undefined);
    throw error;
  }

  const tasks = new PgTaskRepository(database.pool);
  const taskTransitions = new PgTaskTransitionRepository(database.pool);
  const executions = new PgExecutionRepository(database.pool);
  const agents = new PgAgentRepository(database.pool);
  const repairGoals = new PgRepairGoalRepository(database.pool);
  const evalResults = new PgEvalResultRepository(database.pool);
  const pluginConfigs: PluginConfigRepository = new PgPluginConfigRepository(database.pool);
  const runtime = new PluginRuntime(await createResolvedPlugins(config), await pluginConfigs.list());
  await runtime.init();
  const logPlugin = runtime.selectLogPlugin();
  const events = new FileLogEventStream(logPlugin);
  const executionLogs = new FileExecutionLogRepository(logPlugin);

  const services = new TitingServices({
    tasks,
    taskTransitions,
    executions,
    executionLogs,
    agents,
    repairGoals,
    evalResults,
    pluginConfigs,
    events,
    runtime,
    agentOfflineTimeoutMs: config.scheduler.agentOfflineTimeoutMs,
    environmentRetryLimit: config.goalRecovery.environmentRetryLimit,
    executionRetryLimit: config.goalRecovery.executionRetryLimit,
    maxRepairIterations: config.goalRecovery.maxRepairIterations,
    enableNeedsHumanLoop: config.goalRecovery.enableNeedsHumanLoop,
    createId: () => randomUUID()
  });

  await seedAgents(services, config.scheduler.agentCount);
  return buildServerWithState(
    { services, events, pool: database.pool, config, plugins: runtime.list() },
    { schedulerIntervalMs: config.scheduler.intervalMs, logger: true, startScheduler: true }
  );
}

export async function buildServerWithState(
  state: BootstrapState,
  options: { schedulerIntervalMs?: number; logger?: boolean; startScheduler?: boolean } = {}
) {
  const fastify = Fastify({ logger: options.logger ?? false });
  await fastify.register(cors, { origin: true });
  wireRoutes(fastify, state);

  const startScheduler = options.startScheduler ?? true;
  const schedulerTimer = startScheduler
    ? setInterval(() => {
        void state.services.runSchedulerTick().catch((error: unknown) => {
          fastify.log.error(error);
        });
      }, options.schedulerIntervalMs ?? 30_000)
    : null;
  schedulerTimer?.unref?.();

  if (startScheduler) {
    void state.services.runSchedulerTick().catch((error: unknown) => {
      fastify.log.error(error);
    });
  }

  fastify.addHook("onClose", async () => {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
    }
    await state.pool.end();
  });

  return fastify;
}

function wireRoutes(fastify: FastifyInstance, state: BootstrapState): void {
  fastify.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof NotFoundError) {
      void reply.status(404).send({ error: error.message });
      return;
    }
    const statusCode = error.name === "InvalidTransitionError" ? 400 : 500;
    void reply.status(statusCode).send({ error: error.message });
  });

  fastify.get("/api/health", async () => ({
    ok: true,
    status: "alive",
    schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION,
    service: "titing",
    timestamp: new Date().toISOString()
  }));

  fastify.get("/api/readiness", async (_request: FastifyRequest, reply: FastifyReply) => {
    const readiness = await buildReadiness(state);
    return reply.status(readiness.ok ? 200 : 503).send(readiness);
  });

  fastify.get("/api/tasks", async (request: FastifyRequest) => {
    const query = request.query as { status?: TitingTask["status"]; executor?: string };
    return state.services.listTasks(query);
  });

  fastify.post("/api/tasks", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Partial<CreateTaskInput>;
    if (!body?.title || !body?.instruction || !body?.repo) {
      return reply.status(400).send({ error: "title, instruction, and repo are required" });
    }
    const task = await state.services.createTask({
      title: body.title,
      instruction: body.instruction,
      repo: body.repo,
      branch: body.branch,
      priority: body.priority,
      executor: body.executor ?? state.config.plugins.execution.defaultExecutor,
      source: body.source,
      externalId: body.externalId,
      constraints: body.constraints,
      acceptanceCriteria: body.acceptanceCriteria,
      metadata: body.metadata
    });
    return reply.status(201).send(task);
  });

  fastify.get("/api/tasks/:id", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.getTask(params.id);
  });

  fastify.post("/api/tasks/:id/validate", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.validateTask(params.id, "api");
  });

  fastify.post("/api/tasks/:id/queue", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.queueTask(params.id, "api");
  });

  fastify.post("/api/tasks/:id/retry", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.retryTask(params.id, "api");
  });

  fastify.post("/api/tasks/:id/block", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string };
    return state.services.blockTask(params.id, body.reason, "api");
  });

  fastify.post("/api/tasks/:id/needs-human", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string };
    return state.services.markNeedsHuman(params.id, body.reason, "api");
  });

  fastify.post("/api/tasks/:id/recover", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { reason?: string };
    return state.services.recoverTask(params.id, "api", body.reason);
  });

  fastify.post("/api/tasks/:id/cancel", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.cancelTask(params.id, "api");
  });

  fastify.get("/api/tasks/:id/executions", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.listExecutions(params.id);
  });

  fastify.get("/api/tasks/:id/transitions", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.listTaskTransitions(params.id);
  });

  fastify.get("/api/tasks/:id/logs", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.listExecutionLogs(params.id);
  });

  fastify.get("/api/tasks/:id/observability", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.getTaskObservability(params.id);
  });

  fastify.get("/api/traces/:traceId", async (request: FastifyRequest) => {
    const params = request.params as { traceId: string };
    return state.services.getTraceView(params.traceId);
  });

  fastify.get("/api/tasks/:id/eval-results", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.listEvalResults(params.id);
  });

  fastify.get("/api/tasks/:id/repair-goal", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.getRepairGoal(params.id);
  });

  fastify.get("/api/agents", async () => state.services.listAgents());
  fastify.post("/api/agents/:id/heartbeat", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { status?: AgentRecord["status"] };
    return state.services.heartbeatAgent(params.id, body.status);
  });
  fastify.post("/api/agents/:id/disable", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.disableAgent(params.id);
  });
  fastify.post("/api/agents/:id/enable", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.enableAgent(params.id);
  });
  fastify.post("/api/agents/:id/recover", async (request: FastifyRequest) => {
    const params = request.params as { id: string };
    return state.services.recoverAgent(params.id);
  });
  fastify.get("/api/plugins", async () => state.services.listPlugins());
  fastify.get("/api/plugin-configs", async () => state.services.listPluginConfigs());
  fastify.post("/api/plugin-configs", async (request: FastifyRequest) => {
    const body = request.body as {
      pluginId: string;
      kind: "task-integration" | "execution" | "environment" | "quality" | "observability-governance" | "log";
      enabled: boolean;
      priority: number;
      config?: Record<string, unknown>;
    };
    return state.services.upsertPluginConfig({
      pluginId: body.pluginId,
      kind: body.kind,
      enabled: body.enabled,
      priority: body.priority,
      config: body.config ?? {}
    });
  });
  fastify.get("/api/dashboard", async () => state.services.dashboard());
  fastify.get("/api/ops/events", async () => {
    const [tasks, events] = await Promise.all([state.services.listTasks(), Promise.resolve(state.events.snapshot())]);
    return buildOpsEventSnapshot(tasks, events);
  });
  fastify.post("/api/debug/sync", async () => state.services.runTaskSyncNow());
  fastify.post("/api/debug/scheduler", async () => state.services.runSchedulerDispatchNow());

  fastify.get("/api/events", async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    for (const event of state.events.snapshot()) {
      reply.raw.write(formatSseEvent(event.eventType, event));
    }

    const unsubscribe = state.events.subscribe((event) => {
      reply.raw.write(formatSseEvent(event.eventType, event));
    });

    reply.raw.on("close", () => {
      unsubscribe();
    });

    return reply.hijack();
  });

  for (const plugin of state.plugins) {
    if (!isHttpRoutePlugin(plugin)) {
      continue;
    }
    plugin.registerRoutes?.(fastify, {
      services: state.services,
      config: state.config
    });
  }
}

function formatSseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const OPS_WATCH_EVENT_TYPES = [
  "execution.blocked",
  "execution.retry_scheduled",
  "scheduler.tick_skipped",
  "agent.offline",
  "plugin.integration_skipped"
] as const;

function buildOpsEventSnapshot(tasks: TitingTask[], events: ObservabilityEvent[]) {
  const watchSet = new Set<string>(OPS_WATCH_EVENT_TYPES);
  const sortedEvents = [...events].sort((left, right) => {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
  const watchedEvents = sortedEvents.filter((event) => watchSet.has(event.eventType));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const countsByEventType = watchedEvents.reduce<Record<string, number>>((result, event) => {
    result[event.eventType] = (result[event.eventType] ?? 0) + 1;
    return result;
  }, {});

  const recentAbnormalTasks = new Map<
    string,
    {
      taskId: string;
      title: string;
      status: string;
      traceId: string;
      eventType: string;
      message: string;
      createdAt: Date;
      retryCount: number;
      repairCount: number;
    }
  >();
  for (const event of watchedEvents) {
    if (!event.taskId || recentAbnormalTasks.has(event.taskId)) {
      continue;
    }
    const task = taskById.get(event.taskId);
    if (!task) {
      continue;
    }
    recentAbnormalTasks.set(event.taskId, {
      taskId: task.id,
      title: task.title,
      status: task.status,
      traceId: task.traceId,
      eventType: event.eventType,
      message: event.message,
      createdAt: event.createdAt,
      retryCount: task.retryCount,
      repairCount: task.repairCount
    });
  }

  return {
    focusEventTypes: [...OPS_WATCH_EVENT_TYPES],
    watchedEventCount: watchedEvents.length,
    eventTypeCounts: countsByEventType,
    eventTypeRanking: Object.entries(countsByEventType)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([eventType, count]) => ({ eventType, count })),
    recentWatchedEvents: watchedEvents.slice(0, 12).map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString()
    })),
    recentAbnormalTasks: [...recentAbnormalTasks.values()].slice(0, 8).map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString()
    }))
  };
}

async function buildReadiness(state: BootstrapState) {
  const databaseCheck = await checkDatabase(state.pool);
  const plugins = await state.services.listPlugins();
  const pluginReadiness = evaluatePluginReadiness(plugins);
  const ok = databaseCheck.ok && pluginReadiness.ok;
  return {
    ok,
    status: ok ? "ready" : "degraded",
    schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION,
    service: "titing",
    timestamp: new Date().toISOString(),
    checks: {
      database: databaseCheck,
      plugins: pluginReadiness
    }
  };
}

async function checkDatabase(pool: Pick<ServerPool, "query">): Promise<{ ok: boolean; message: string }> {
  try {
    await pool.query("select 1");
    return { ok: true, message: "Database connection is ready" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function evaluatePluginReadiness(
  plugins: Awaited<ReturnType<TitingServices["listPlugins"]>>
): {
  ok: boolean;
  message: string;
  total: number;
  healthy: number;
  requiredKinds: Record<string, boolean>;
  items: Awaited<ReturnType<TitingServices["listPlugins"]>>;
} {
  const requiredKinds = {
    environment: plugins.some((plugin) => plugin.kind === "environment" && plugin.health.healthy),
    execution: plugins.some((plugin) => plugin.kind === "execution" && plugin.health.healthy),
    "observability-governance": plugins.some(
      (plugin) => plugin.kind === "observability-governance" && plugin.health.healthy
    )
  };
  const ok = Object.values(requiredKinds).every(Boolean);
  return {
    ok,
    message: ok ? "Required plugin kinds are ready" : "One or more required plugin kinds are unhealthy",
    total: plugins.length,
    healthy: plugins.filter((plugin) => plugin.health.healthy).length,
    requiredKinds,
    items: plugins
  };
}

export async function seedAgents(services: TitingServices, agentCount: number): Promise<void> {
  const existing = await services.listAgents();
  const byKey = new Map(existing.map((agent) => [agent.id, agent]));
  const now = new Date();
  const desired: AgentRecord[] = [];
  for (let index = 1; index <= agentCount; index += 1) {
    desired.push({
      id: `codex-agent-${index}`,
      status: "idle",
      taskId: null,
      executor: "codex",
      labels: ["local"],
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now
    });
    desired.push({
      id: `cursor-agent-${index}`,
      status: "idle",
      taskId: null,
      executor: "cursor",
      labels: ["local"],
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now
    });
  }

  for (const agent of desired) {
    const existingAgent = byKey.get(agent.id);
    if (!existingAgent) {
      await services.upsertAgent(agent);
      continue;
    }
    if (existingAgent.status === "offline" && existingAgent.taskId === null) {
      await services.upsertAgent({
        ...existingAgent,
        status: "idle",
        executor: agent.executor,
        labels: agent.labels,
        lastHeartbeatAt: now,
        updatedAt: now
      });
    }
  }
}
