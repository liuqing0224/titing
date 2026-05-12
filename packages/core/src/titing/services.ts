import {
  AgentRecord,
  AgentRepository,
  CreateTaskInput,
  EvalResult,
  EvalResultRepository,
  EventSink,
  HumanReply,
  ExecutionLogRecord,
  ExecutionLogRepository,
  ExecutionRecord,
  ExecutionRepository,
  NeedsHumanPayload,
  ObservabilityCorrelation,
  PluginConfig,
  PluginConfigRepository,
  PreparedWorkspace,
  RepairGoal,
  RepairGoalRepository,
  TaskIntegrationPlugin,
  TaskListQuery,
  TaskRepository,
  TaskStatus,
  TaskTransition,
  TaskTransitionRepository,
  TitingTask,
  ExecutionResult
} from "@titing/plugin-api";
import { NotFoundError } from "./errors";
import { PluginRuntime } from "./plugin-runtime";
import { assertValidTransition } from "./state-machine";
import { randomUUID } from "node:crypto";

export type ServiceDependencies = {
  tasks: TaskRepository;
  taskTransitions: TaskTransitionRepository;
  executions: ExecutionRepository;
  executionLogs: ExecutionLogRepository;
  agents: AgentRepository;
  repairGoals: RepairGoalRepository;
  evalResults: EvalResultRepository;
  pluginConfigs: PluginConfigRepository;
  events: EventSink;
  runtime: PluginRuntime;
  now?: () => Date;
  createId?: () => string;
  agentOfflineTimeoutMs?: number;
  environmentRetryLimit?: number;
  executionRetryLimit?: number;
  maxRepairIterations?: number;
  enableNeedsHumanLoop?: boolean;
  executionHeartbeatIntervalMs?: number;
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
};

export class TitingServices {
  static readonly OBSERVABILITY_SCHEMA_VERSION = "2026-05-11";
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly agentOfflineTimeoutMs: number;
  private readonly environmentRetryLimit: number;
  private readonly executionRetryLimit: number;
  private readonly maxRepairIterations: number;
  private readonly enableNeedsHumanLoop: boolean;
  private readonly executionHeartbeatIntervalMs: number;
  private readonly setIntervalFn: (callback: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (timer: unknown) => void;
  private schedulerTickInFlight = false;

  constructor(private readonly deps: ServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.createId = deps.createId ?? (() => randomUUID());
    this.agentOfflineTimeoutMs = deps.agentOfflineTimeoutMs ?? 5 * 60 * 1000;
    this.environmentRetryLimit = deps.environmentRetryLimit ?? 2;
    this.executionRetryLimit = deps.executionRetryLimit ?? 2;
    this.maxRepairIterations = deps.maxRepairIterations ?? 3;
    this.enableNeedsHumanLoop = deps.enableNeedsHumanLoop ?? false;
    this.executionHeartbeatIntervalMs = deps.executionHeartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.agentOfflineTimeoutMs / 3));
    this.setIntervalFn = deps.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  }

  async createTask(input: CreateTaskInput): Promise<TitingTask> {
    const now = this.now();
    const task: TitingTask = {
      id: this.createId(),
      source: input.source ?? "manual",
      externalId: input.externalId ?? null,
      title: input.title,
      instruction: input.instruction,
      repo: input.repo,
      branch: input.branch ?? "main",
      priority: input.priority ?? "medium",
      status: "created",
      executor: input.executor ?? "codex",
      traceId: this.createId(),
      constraints: input.constraints ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      metadata: input.metadata ?? {},
      retryCount: 0,
      repairCount: 0,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now
    };
    await this.deps.tasks.create(task);
    await this.emitStatus(task, "created", "Task created", "system");
    return task;
  }

  async listTasks(query: TaskListQuery = {}): Promise<TitingTask[]> {
    return this.deps.tasks.list(query);
  }

  async getTask(id: string): Promise<TitingTask> {
    const task = await this.deps.tasks.getById(id);
    if (!task) {
      throw new NotFoundError(`Task ${id} not found`);
    }
    return task;
  }

  async validateTask(id: string, operator = "system"): Promise<TitingTask> {
    const task = await this.getTask(id);
    if (!task.instruction.trim() || !task.repo.trim() || !task.branch.trim()) {
      return this.transitionTask(task, "failed", "Task validation failed", operator);
    }
    return this.transitionTask(task, "validated", "Task validated", operator);
  }

  async queueTask(id: string, operator = "system"): Promise<TitingTask> {
    const task = await this.getTask(id);
    const ready = task.status === "created" ? await this.validateTask(id, operator) : task;
    const pending = ready.status === "validated"
      ? await this.transitionTask(ready, "pending", "Task moved to pending", operator)
      : ready;
    return this.transitionTask(pending, "queued", "Task queued", operator);
  }

  async retryTask(id: string, operator = "system"): Promise<TitingTask> {
    const task = await this.getTask(id);
    if (!["failed", "needs_human", "blocked"].includes(task.status)) {
      throw new Error(`Task ${task.id} cannot be retried from ${task.status}`);
    }
    task.retryCount += 1;
    task.startedAt = null;
    task.completedAt = null;
    task.updatedAt = this.now();
    await this.deps.tasks.save(task);
    return this.transitionTask(task, "queued", "Task retried", operator);
  }

  async blockTask(id: string, reason = "Task blocked by operator", operator = "system"): Promise<TitingTask> {
    const task = await this.getTask(id);
    if (!["created", "validated", "pending", "queued", "running"].includes(task.status)) {
      throw new Error(`Task ${task.id} cannot be blocked from ${task.status}`);
    }
    return this.transitionTask(task, "blocked", reason, operator);
  }

  async markNeedsHuman(
    id: string,
    reason = "Task requires human intervention",
    operator = "system"
  ): Promise<TitingTask> {
    const task = await this.getTask(id);
    if (!["evaluating", "repairing", "queued", "running"].includes(task.status)) {
      throw new Error(`Task ${task.id} cannot be marked needs_human from ${task.status}`);
    }
    const updatedTask = await this.transitionTask(task, "needs_human", reason, operator);
    updatedTask.completedAt = this.now();
    await this.deps.tasks.save(updatedTask);
    return updatedTask;
  }

  async recoverTask(
    id: string,
    operator = "system",
    reason = "Task manually recovered to queue"
  ): Promise<TitingTask> {
    const task = await this.getTask(id);
    if (!["blocked", "needs_human", "cancelled"].includes(task.status)) {
      throw new Error(`Task ${task.id} cannot be recovered from ${task.status}`);
    }
    task.startedAt = null;
    task.completedAt = null;
    task.updatedAt = this.now();
    await this.deps.tasks.save(task);
    return this.transitionTask(task, "queued", reason, operator);
  }

  async cancelTask(id: string, operator = "system"): Promise<TitingTask> {
    const task = await this.getTask(id);
    return this.transitionTask(task, "cancelled", "Task cancelled", operator);
  }

  async listExecutions(taskId: string): Promise<ExecutionRecord[]> {
    return this.deps.executions.listByTask(taskId);
  }

  async listExecutionLogs(taskId: string): Promise<ExecutionLogRecord[]> {
    return this.deps.executionLogs.listByTask(taskId);
  }

  async listTaskTransitions(taskId: string): Promise<TaskTransition[]> {
    return this.deps.taskTransitions.listByTask(taskId);
  }

  async getTaskObservability(taskId: string): Promise<{
    schemaVersion: string;
    taskId: string;
    transitions: TaskTransition[];
    executionLogs: ExecutionLogRecord[];
  }> {
    await this.getTask(taskId);
    const [transitions, executionLogs] = await Promise.all([
      this.deps.taskTransitions.listByTask(taskId),
      this.deps.executionLogs.listByTask(taskId)
    ]);
    return {
      schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION,
      taskId,
      transitions,
      executionLogs
    };
  }

  async getTraceView(traceId: string): Promise<{
    schemaVersion: string;
    traceId: string;
    tasks: TitingTask[];
    transitions: TaskTransition[];
    executions: ExecutionRecord[];
    executionLogs: ExecutionLogRecord[];
    evalResults: EvalResult[];
    repairGoals: RepairGoal[];
  }> {
    const tasks = await this.deps.tasks.listByTraceId(traceId);
    if (tasks.length === 0) {
      throw new NotFoundError(`Trace ${traceId} not found`);
    }
    const [transitions, executionArtifacts] = await Promise.all([
      this.deps.taskTransitions.listByTraceId(traceId),
      Promise.all(tasks.map(async (task) => ({
        executions: await this.deps.executions.listByTask(task.id),
        executionLogs: await this.deps.executionLogs.listByTask(task.id),
        evalResults: await this.deps.evalResults.listByTask(task.id),
        repairGoal: await this.deps.repairGoals.getByTaskId(task.id)
      })))
    ]);
    return {
      schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION,
      traceId,
      tasks,
      transitions,
      executions: executionArtifacts.flatMap((item) => item.executions),
      executionLogs: executionArtifacts.flatMap((item) => item.executionLogs),
      evalResults: executionArtifacts.flatMap((item) => item.evalResults),
      repairGoals: executionArtifacts.flatMap((item) => (item.repairGoal ? [item.repairGoal] : []))
    };
  }

  async listEvalResults(taskId: string): Promise<EvalResult[]> {
    return this.deps.evalResults.listByTask(taskId);
  }

  async getRepairGoal(taskId: string): Promise<RepairGoal | null> {
    return this.deps.repairGoals.getByTaskId(taskId);
  }

  private async syncHumanRepliesForIntegration(
    integration: TaskIntegrationPlugin & Required<Pick<TaskIntegrationPlugin, "pullHumanReplies">>
  ): Promise<void> {
    const tasks = (await this.deps.tasks.list({ status: "needs_human" }))
      .filter((task) => task.source === integration.id && Boolean(task.externalId));
    if (tasks.length === 0) {
      return;
    }
    const replies = await integration.pullHumanReplies(tasks);
    for (const reply of sortHumanReplies(replies)) {
      await this.applyHumanReply(integration, tasks, reply);
    }
  }

  private async applyHumanReply(
    integration: TaskIntegrationPlugin,
    candidateTasks: TitingTask[],
    reply: HumanReply
  ): Promise<void> {
    const task = candidateTasks.find((item) => item.id === reply.taskId)
      ?? candidateTasks.find((item) => item.externalId === reply.externalId)
      ?? await this.deps.tasks.getById(reply.taskId)
      ?? await this.deps.tasks.getByExternalId(integration.id, reply.externalId);
    if (!task || task.status !== "needs_human") {
      return;
    }

    const humanLoop = readHumanLoopMetadata(task.metadata);
    if (!humanLoop.requestedAt || humanLoop.seenReplyIds.includes(reply.replyId)) {
      return;
    }
    if (new Date(reply.createdAt).getTime() < new Date(humanLoop.requestedAt).getTime()) {
      return;
    }

    task.instruction = appendHumanReplyToInstruction(task.instruction, reply);
    task.metadata = {
      ...task.metadata,
      humanLoop: {
        ...humanLoop,
        lastReplyId: reply.replyId,
        lastReplyAt: reply.createdAt,
        lastReplyAuthor: reply.author,
        lastReplyBody: reply.body,
        seenReplyIds: trimReplyIds([...humanLoop.seenReplyIds, reply.replyId])
      }
    };
    task.updatedAt = this.now();
    await this.deps.tasks.save(task);

    const goal = await this.deps.repairGoals.getByTaskId(task.id);
    if (goal) {
      await this.deps.repairGoals.upsert({
        ...goal,
        status: "repairing",
        constraints: appendHumanGuidanceConstraint(goal.constraints, reply.body),
        updatedAt: this.now()
      });
    }

    await this.appendExecutionLog(task, null, "goal.human_reply_received", "Human reply received from integration comment", {
      replyId: reply.replyId,
      externalId: reply.externalId,
      author: reply.author,
      createdAt: reply.createdAt
    }, this.buildCorrelation({ task, pluginId: integration.id }));
    await this.recoverTask(task.id, integration.id, "Recovered from integration comment reply");
  }

  private async handleNeedsHumanStopReason(
    task: TitingTask,
    execution: ExecutionRecord,
    goal: RepairGoal,
    stopReason: "high_risk" | "repeated_failure" | "no_effective_diff",
    result: ExecutionResult,
    evalResult: EvalResult,
    operator: string,
    agentId: string
  ): Promise<{ task: TitingTask; goal: RepairGoal } | null> {
    const integration = this.deps.runtime.getTaskIntegrations().find((plugin) => (
      plugin.id === task.source && typeof plugin.reportNeedsHuman === "function"
    ));
    if (!integration?.reportNeedsHuman) {
      return null;
    }

    const requestedAt = this.now();
    const requestId = this.createId();
    task.metadata = {
      ...task.metadata,
      humanLoop: {
        ...readHumanLoopMetadata(task.metadata),
        requestId,
        requestedAt: requestedAt.toISOString()
      }
    };
    task.updatedAt = requestedAt;
    await this.deps.tasks.save(task);

    const nextGoal: RepairGoal = {
      ...goal,
      status: "needs_human",
      updatedAt: requestedAt
    };
    await this.deps.repairGoals.upsert(nextGoal);

    const summary = describeStopReason(stopReason);
    const payload: NeedsHumanPayload = {
      reason: summary,
      stopReason,
      summary: result.summary,
      requestId,
      requestedAt: requestedAt.toISOString(),
      evalResultId: evalResult.id,
      executionId: execution.id
    };
    await this.appendExecutionLog(
      task,
      execution,
      "goal.needs_human_requested",
      summary,
      {
        stopReason,
        requestId,
        riskLevel: evalResult.riskLevel,
        iteration: nextGoal.currentIteration,
        maxIterations: nextGoal.maxIterations,
        evalResultId: evalResult.id,
        executionId: execution.id,
        score: evalResult.score
      },
      this.buildCorrelation({ task, execution, pluginId: integration.id, agentId })
    );
    await integration.reportNeedsHuman(task, payload);
    await this.updateExecutionStatus(execution, task, "failed", `Human input required: ${summary}`, {
      stopReason,
      requestId,
      riskLevel: evalResult.riskLevel
    });
    const needsHumanTask = await this.transitionTask(task, "needs_human", summary, operator, execution);
    needsHumanTask.completedAt = requestedAt;
    await this.deps.tasks.save(needsHumanTask);
    return { task: needsHumanTask, goal: nextGoal };
  }

  async listAgents(): Promise<AgentRecord[]> {
    return this.deps.agents.list();
  }

  async upsertAgent(agent: AgentRecord): Promise<void> {
    await this.deps.agents.upsert(agent);
  }

  async heartbeatAgent(id: string, status?: AgentRecord["status"]): Promise<AgentRecord> {
    const agent = await this.deps.agents.getById(id);
    if (!agent) {
      throw new NotFoundError(`Agent ${id} not found`);
    }
    if (status && !["idle", "busy"].includes(status)) {
      throw new Error(`Heartbeat cannot set agent ${id} to ${status}`);
    }
    if (agent.status === "disabled" || agent.status === "error") {
      throw new Error(`Agent ${id} cannot heartbeat while ${agent.status}`);
    }
    agent.status = status ?? (agent.status === "offline" ? "idle" : agent.status);
    agent.lastHeartbeatAt = this.now();
    agent.updatedAt = this.now();
    await this.deps.agents.upsert(agent);
    await this.publishAgentEvent("agent.heartbeat", "Agent heartbeat refreshed", agent);
    return agent;
  }

  async disableAgent(id: string): Promise<AgentRecord> {
    const agent = await this.requireAgent(id);
    if (agent.status === "busy") {
      throw new Error(`Agent ${id} cannot be disabled while busy`);
    }
    agent.status = "disabled";
    agent.updatedAt = this.now();
    await this.deps.agents.upsert(agent);
    await this.publishAgentEvent("agent.disabled", "Agent disabled", agent);
    return agent;
  }

  async enableAgent(id: string): Promise<AgentRecord> {
    const agent = await this.requireAgent(id);
    if (agent.status !== "disabled") {
      throw new Error(`Agent ${id} is not disabled`);
    }
    agent.status = "idle";
    agent.taskId = null;
    agent.lastHeartbeatAt = this.now();
    agent.updatedAt = this.now();
    await this.deps.agents.upsert(agent);
    await this.publishAgentEvent("agent.enabled", "Agent enabled", agent);
    return agent;
  }

  async recoverAgent(id: string): Promise<AgentRecord> {
    const agent = await this.requireAgent(id);
    if (!["offline", "error"].includes(agent.status)) {
      throw new Error(`Agent ${id} cannot be recovered from ${agent.status}`);
    }
    agent.status = "idle";
    agent.taskId = null;
    agent.lastHeartbeatAt = this.now();
    agent.updatedAt = this.now();
    await this.deps.agents.upsert(agent);
    await this.publishAgentEvent("agent.recovered", "Agent recovered", agent);
    return agent;
  }

  async listPlugins() {
    const plugins = this.deps.runtime.list();
    return Promise.all(
      plugins.map(async (plugin) => ({
        id: plugin.id,
        kind: plugin.kind,
        priority: plugin.priority,
        capabilities: plugin.capabilities,
        health: await plugin.health()
      }))
    );
  }

  async listPluginConfigs() {
    return this.deps.pluginConfigs.list();
  }

  async upsertPluginConfig(input: {
    pluginId: string;
    kind: PluginConfig["kind"];
    enabled: boolean;
    priority: number;
    config: Record<string, unknown>;
  }) {
    const existing = await this.deps.pluginConfigs.getByPluginId(input.pluginId);
    const config = {
      id: existing?.id ?? this.createId(),
      pluginId: input.pluginId,
      kind: input.kind,
      enabled: input.enabled,
      priority: input.priority,
      config: input.config,
      updatedAt: this.now()
    };
    await this.deps.pluginConfigs.upsert(config);
    await this.publishEvent({
      correlation: this.buildCorrelation({
        traceId: `plugin:${config.pluginId}`,
        pluginId: config.pluginId
      }),
      eventType: "plugin.config_updated",
      message: "Plugin config updated",
      data: {
        kind: config.kind,
        enabled: config.enabled,
        priority: config.priority
      }
    });
    return config;
  }

  async dashboard() {
    const tasks = await this.deps.tasks.list();
    const agents = await this.deps.agents.list();
    const plugins = await this.listPlugins();
    const statusCounts = countBy(tasks.map((task) => task.status));
    return {
      tasks: {
        total: tasks.length,
        byStatus: statusCounts
      },
      agents: {
        total: agents.length,
        byStatus: countBy(agents.map((agent) => agent.status))
      },
      plugins: {
        total: plugins.length,
        healthy: plugins.filter((plugin) => plugin.health.healthy).length
      }
    };
  }

  async runSchedulerTick(): Promise<void> {
    if (this.schedulerTickInFlight) {
      await this.publishEvent({
        correlation: this.buildCorrelation({ traceId: "scheduler" }),
        eventType: "scheduler.tick_skipped",
        message: "Scheduler tick skipped because a previous tick is still running",
        data: {}
      });
      return;
    }
    this.schedulerTickInFlight = true;
    try {
      await this.publishEvent({
        correlation: this.buildCorrelation({ traceId: "scheduler" }),
        eventType: "scheduler.tick_started",
        message: "Scheduler tick started",
        data: {}
      });
      await this.syncTaskIntegrations();
      await this.recoverOfflineAgentsAndTasks();
      await this.dispatchQueuedTasks();
    } finally {
      await this.publishEvent({
        correlation: this.buildCorrelation({ traceId: "scheduler" }),
        eventType: "scheduler.tick_completed",
        message: "Scheduler tick completed",
        data: {}
      });
      this.schedulerTickInFlight = false;
    }
  }

  async runTaskSyncNow(): Promise<{ integrations: number; pulledTasks: number }> {
    const integrations = this.deps.runtime.getTaskIntegrations();
    let pulledTasks = 0;
    await this.publishEvent({
      correlation: this.buildCorrelation({ traceId: "scheduler" }),
      eventType: "scheduler.sync_started",
      message: "Task integration sync started",
      data: { integrations: integrations.length }
    });
    for (const integration of integrations) {
      const health = await integration.health();
      if (!health.healthy) {
        await this.publishEvent({
          correlation: this.buildCorrelation({
            traceId: `plugin:${integration.id}`,
            pluginId: integration.id
          }),
          eventType: "plugin.integration_skipped",
          message: "Task integration skipped because plugin is unhealthy",
          data: { health }
        });
        continue;
      }
      const tasks = await integration.pullTasks();
      pulledTasks += tasks.length;
      await this.publishEvent({
        correlation: this.buildCorrelation({
          traceId: `plugin:${integration.id}`,
          pluginId: integration.id
        }),
        eventType: "plugin.integration_pulled",
        message: "Task integration pulled tasks",
        data: { count: tasks.length }
      });
      for (const task of tasks) {
        await this.ingestPulledTask(task, integration.id);
      }
      if (this.enableNeedsHumanLoop && integration.pullHumanReplies) {
        try {
          await this.syncHumanRepliesForIntegration(
            integration as TaskIntegrationPlugin & Required<Pick<TaskIntegrationPlugin, "pullHumanReplies">>
          );
        } catch (error) {
          await this.publishEvent({
            correlation: this.buildCorrelation({
              traceId: `plugin:${integration.id}`,
              pluginId: integration.id
            }),
            eventType: "plugin.human_reply_sync_failed",
            message: "Human reply sync failed",
            data: {
              error: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
    }
    await this.publishEvent({
      correlation: this.buildCorrelation({ traceId: "scheduler" }),
      eventType: "scheduler.sync_completed",
      message: "Task integration sync completed",
      data: { integrations: integrations.length, pulledTasks }
    });
    return { integrations: integrations.length, pulledTasks };
  }

  async runSchedulerDispatchNow(): Promise<{ queuedBefore: number }> {
    const queuedBefore = (await this.deps.tasks.list({ status: "queued" })).length;
    await this.publishEvent({
      correlation: this.buildCorrelation({ traceId: "scheduler" }),
      eventType: "scheduler.dispatch_started",
      message: "Scheduler dispatch started",
      data: { queuedBefore }
    });
    await this.dispatchQueuedTasks();
    await this.publishEvent({
      correlation: this.buildCorrelation({ traceId: "scheduler" }),
      eventType: "scheduler.dispatch_completed",
      message: "Scheduler dispatch completed",
      data: { queuedBefore }
    });
    return { queuedBefore };
  }

  async syncTaskIntegrations(): Promise<void> {
    await this.runTaskSyncNow();
  }

  async ingestTaskFromIntegration(task: TitingTask, operator: string): Promise<TitingTask | null> {
    const ingested = await this.ingestPulledTask(task, operator);
    return ingested;
  }

  private async dispatchQueuedTasks(): Promise<void> {
    const queuedTasks = (await this.deps.tasks.list({ status: "queued" })).sort(sortTaskPriority);
    for (const task of queuedTasks) {
      const now = this.now();
      const agent = await this.deps.agents.claimIdle(task.executor, task.id, now);
      if (!agent) {
        break;
      }

      const claimedTask = await this.deps.tasks.claimQueued(task.id, now);
      if (!claimedTask) {
        await this.releaseAgent(agent);
        continue;
      }

      await this.recordTaskMutation(claimedTask, "queued", "running", "Task claimed by scheduler", "scheduler");
      await this.runTask(claimedTask, agent);
    }
  }

  private async recoverOfflineAgentsAndTasks(): Promise<void> {
    const staleBefore = new Date(this.now().getTime() - this.agentOfflineTimeoutMs);
    const agents = await this.deps.agents.list();
    for (const agent of agents) {
      if (agent.lastHeartbeatAt > staleBefore) {
        continue;
      }
      if (agent.status === "busy" && agent.taskId) {
        const task = await this.deps.tasks.getById(agent.taskId);
        if (task?.status === "running") {
          await this.transitionTask(task, "queued", "Agent heartbeat timed out; task re-queued", "scheduler");
          await this.appendExecutionLog(task, null, "scheduler.task_requeued", "Task re-queued after agent timeout", {
            agentId: agent.id,
            lastHeartbeatAt: agent.lastHeartbeatAt.toISOString()
          }, this.buildCorrelation({ task, agentId: agent.id }));
          await this.publish("scheduler.task_requeued", "Task re-queued after agent timeout", task, {
            agentId: agent.id,
            lastHeartbeatAt: agent.lastHeartbeatAt.toISOString()
          }, { agentId: agent.id });
        }
      }
      if (agent.status === "busy" || agent.status === "idle") {
        agent.status = "offline";
        agent.updatedAt = this.now();
        await this.deps.agents.upsert(agent);
        await this.publishAgentEvent("agent.offline", "Agent marked offline after heartbeat timeout", agent);
      }
    }
  }

  private async runTask(task: TitingTask, agent: AgentRecord): Promise<void> {
    const environment = this.deps.runtime.selectEnvironmentPlugin();
    const executionPlugin = this.deps.runtime.selectExecutionPlugin(task.executor);
    const qualityPlugin = this.deps.runtime.getPrimaryQualityPlugin();
    const governancePlugins = this.deps.runtime.getGovernancePlugins();
    let currentTask = task;
    let workspace: PreparedWorkspace | null = null;
    let execution: ExecutionRecord | null = null;
    const stopHeartbeat = this.startAgentHeartbeatLoop(agent.id);

    await this.publish("scheduler.agent_selected", "Agent selected", currentTask, { agentId: agent.id });

    try {
      workspace = await environment.prepareWorkspace(currentTask);
      let goal = await this.deps.repairGoals.getByTaskId(currentTask.id);
      let loopCount = goal?.currentIteration ?? 0;
      let previousResult: ExecutionResult | null = null;
      let previousFailureHash: string | null = goal?.lastFailureHash ?? null;
      let repeatedFailureCount = 0;
      let noDiffStreak = 0;

      while (true) {
        execution = await this.createExecution(currentTask, agent.id, workspace);
        await this.updateExecutionStatus(execution, currentTask, "executing", "Execution started", {
          agentId: agent.id,
          iteration: loopCount + 1
        });

        const result: ExecutionResult = goal && previousResult?.sessionId && executionPlugin.continueSession
          ? await executionPlugin.continueSession(previousResult.sessionId, currentTask, workspace, goal)
          : await executionPlugin.execute(currentTask, workspace, goal);
        execution.summary = result.summary;
        execution.endedAt = this.now();
        await this.deps.executions.save(execution);
        await this.appendExecutionLog(currentTask, execution, "executor.completed", result.summary, {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          sessionId: result.sessionId,
          errorCategory: result.errorCategory,
          timeoutCategory: result.timeoutCategory,
          stdout: result.stdout,
          stderr: result.stderr,
          metadata: result.metadata
        }, this.buildCorrelation({ task: currentTask, execution, agentId: agent.id }));
        await this.recordGovernanceEntries(currentTask, execution, result.metadata, agent.id);

        const retriedTask = await this.handleRetryableExecutionFailure(currentTask, execution, agent, result);
        if (retriedTask) {
          currentTask = retriedTask;
          break;
        }

        if (!qualityPlugin) {
          const correlation = this.buildCorrelation({ task: currentTask, execution, agentId: agent.id });
          await this.appendExecutionLog(
            currentTask,
            execution,
            "execution.quality_skipped",
            "Quality plugin disabled; skipping evaluation",
            {
              sessionId: result.sessionId,
              qualityEnabled: false
            },
            correlation
          );
          await this.publish(
            "execution.quality_skipped",
            "Quality plugin disabled; skipping evaluation",
            currentTask,
            {
              executionId: execution.id,
              qualityEnabled: false,
              sessionId: result.sessionId
            },
            { execution, correlation }
          );

          if (result.exitCode === 0) {
            await this.reportTaskResultIfNeeded(currentTask, result.summary);
            if (goal) {
              await this.deps.repairGoals.upsert({
                ...goal,
                status: "achieved",
                updatedAt: this.now()
              });
            }
            await this.updateExecutionStatus(execution, currentTask, "completed", "Execution completed without quality evaluation", {
              sessionId: result.sessionId,
              qualityEnabled: false
            });
            currentTask = await this.transitionTask(
              currentTask,
              "done",
              "Execution completed without quality evaluation",
              executionPlugin.id,
              execution
            );
            currentTask.completedAt = this.now();
            await this.deps.tasks.save(currentTask);
            break;
          }

          const failureHash = buildFailureHash(result, []);
          repeatedFailureCount = failureHash === previousFailureHash ? repeatedFailureCount + 1 : 1;
          previousFailureHash = failureHash;
          loopCount += 1;
          const stopReason = decideStopReasonWithoutQuality({
            repeatedFailureCount,
            iteration: loopCount,
            maxIterations: goal?.maxIterations ?? this.maxRepairIterations
          });
          const nextGoalStatus: RepairGoal["status"] = stopReason === "budget_limited" ? "budget_limited" : "repairing";
          const nextGoal: RepairGoal = {
            id: goal?.id ?? this.createId(),
            taskId: currentTask.id,
            objective: buildRepairObjective(currentTask, result, []),
            constraints: [...currentTask.constraints],
            doneWhen: buildRepairDoneWhenWithoutQuality(currentTask),
            status: nextGoalStatus,
            currentIteration: loopCount,
            maxIterations: goal?.maxIterations ?? this.maxRepairIterations,
            lastFailureHash: failureHash,
            createdAt: goal?.createdAt ?? this.now(),
            updatedAt: this.now()
          };
          goal = nextGoal;
          await this.deps.repairGoals.upsert(goal);

          if (stopReason === "budget_limited") {
            const summary = describeStopReason(stopReason);
            await this.appendExecutionLog(
              currentTask,
              execution,
              "goal.budget_exhausted",
              summary,
              {
                stopReason,
                iteration: loopCount,
                maxIterations: nextGoal.maxIterations,
                qualityEnabled: false
              },
              this.buildCorrelation({ task: currentTask, execution, agentId: agent.id })
            );
            await this.updateExecutionStatus(execution, currentTask, "failed", summary, {
              iteration: loopCount,
              maxIterations: nextGoal.maxIterations,
              stopReason,
              qualityEnabled: false
            });
            currentTask = await this.transitionTask(currentTask, "failed", summary, executionPlugin.id, execution);
            currentTask.completedAt = this.now();
            await this.deps.tasks.save(currentTask);
            await this.reportTaskResultIfNeeded(currentTask, summary);
            break;
          }

          if (stopReason) {
            await this.appendExecutionLog(
              currentTask,
              execution,
              "goal.stop_reason_continued",
              `Continuing repair after stop signal: ${stopReason}`,
              {
                stopReason,
                iteration: loopCount,
                maxIterations: nextGoal.maxIterations,
                qualityEnabled: false
              },
              this.buildCorrelation({ task: currentTask, execution, agentId: agent.id })
            );
          }

          await this.updateExecutionStatus(execution, currentTask, "repairing", "Execution requires repair without quality evaluation", {
            sessionId: result.sessionId,
            errorCategory: result.errorCategory,
            qualityEnabled: false
          });
          if (currentTask.status !== "repairing") {
            currentTask = await this.transitionTask(currentTask, "repairing", "Execution failed", executionPlugin.id, execution);
          }
          currentTask.repairCount = loopCount;
          await this.deps.tasks.save(currentTask);
          await this.publish("goal.iteration_started", "Repair iteration started", currentTask, {
            iteration: loopCount,
            objective: nextGoal.objective,
            sessionId: result.sessionId
          });
          previousResult = result;
          continue;
        }

        await this.updateExecutionStatus(execution, currentTask, "evaluating", "Execution output ready for evaluation", {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          sessionId: result.sessionId
        });
        currentTask = await this.transitionTask(
          currentTask,
          "evaluating",
          "Execution finished",
          executionPlugin.id,
          execution
        );

        const quality = await qualityPlugin.evaluate({ task: currentTask, workspace, execution: result });
        const evalResult: EvalResult = {
          id: this.createId(),
          taskId: currentTask.id,
          executionId: execution.id,
          passed: quality.passed,
          score: quality.score,
          riskLevel: quality.riskLevel,
          report: {
            checks: quality.checks,
            ...quality.report
          },
          createdAt: this.now()
        };
        for (const governance of governancePlugins) {
          await governance.afterEval?.(evalResult);
        }
        await this.deps.evalResults.create(evalResult);
        await this.recordGovernanceEntries(currentTask, execution, evalResult.report, agent.id);
        await this.publish("eval.completed", "Evaluation completed", currentTask, {
          passed: evalResult.passed,
          score: evalResult.score,
          riskLevel: evalResult.riskLevel
        });

        const evalChecks = readQualityChecks(evalResult.report);
        if (evalResult.passed) {
          await this.reportTaskResultIfNeeded(currentTask, result.summary);
          if (goal) {
            await this.deps.repairGoals.upsert({
              ...goal,
              status: "achieved",
              updatedAt: this.now()
            });
          }
          await this.updateExecutionStatus(execution, currentTask, "completed", "Execution passed quality checks", {
            score: evalResult.score,
            riskLevel: evalResult.riskLevel
          });
          currentTask = await this.transitionTask(currentTask, "done", "Evaluation passed", qualityPlugin.id, execution);
          currentTask.completedAt = this.now();
          await this.deps.tasks.save(currentTask);
          break;
        }

        const failureHash = buildFailureHash(result, evalChecks);
        repeatedFailureCount = failureHash === previousFailureHash ? repeatedFailureCount + 1 : 1;
        previousFailureHash = failureHash;
        const diffStats = readDiffStats(evalResult.report);
        noDiffStreak = diffStats.filesChanged === 0 ? noDiffStreak + 1 : 0;
        loopCount += 1;
        const stopReason = decideStopReason({
          qualityRiskLevel: evalResult.riskLevel,
          repeatedFailureCount,
          noDiffStreak,
          iteration: loopCount,
          maxIterations: goal?.maxIterations ?? this.maxRepairIterations
        });
        const nextGoalStatus: RepairGoal["status"] = stopReason === "budget_limited" ? "budget_limited" : "repairing";
        const nextGoal: RepairGoal = {
          id: goal?.id ?? this.createId(),
          taskId: currentTask.id,
          objective: buildRepairObjective(currentTask, result, evalChecks),
          constraints: buildRepairConstraints(currentTask, evalResult.riskLevel),
          doneWhen: buildRepairDoneWhen(currentTask, evalChecks),
          status: nextGoalStatus,
          currentIteration: loopCount,
          maxIterations: goal?.maxIterations ?? this.maxRepairIterations,
          lastFailureHash: failureHash,
          createdAt: goal?.createdAt ?? this.now(),
          updatedAt: this.now()
        };
        goal = nextGoal;
        await this.deps.repairGoals.upsert(goal);

        if (stopReason === "budget_limited") {
          const summary = describeStopReason(stopReason);
          await this.appendExecutionLog(
            currentTask,
            execution,
            "goal.budget_exhausted",
            summary,
            {
              stopReason,
              iteration: loopCount,
              maxIterations: nextGoal.maxIterations,
              riskLevel: evalResult.riskLevel,
              evalResultId: evalResult.id,
              score: evalResult.score
            },
            this.buildCorrelation({ task: currentTask, execution, agentId: agent.id })
          );
          await this.updateExecutionStatus(execution, currentTask, "failed", summary, {
            iteration: loopCount,
            maxIterations: nextGoal.maxIterations,
            stopReason
          });
          currentTask = await this.transitionTask(currentTask, "failed", summary, qualityPlugin.id, execution);
          currentTask.completedAt = this.now();
          await this.deps.tasks.save(currentTask);
          await this.reportTaskResultIfNeeded(currentTask, summary);
          break;
        }

        if (stopReason && this.enableNeedsHumanLoop) {
          const handledByHumanLoop = await this.handleNeedsHumanStopReason(
            currentTask,
            execution,
            nextGoal,
            stopReason,
            result,
            evalResult,
            qualityPlugin.id,
            agent.id
          );
          if (handledByHumanLoop) {
            currentTask = handledByHumanLoop.task;
            goal = handledByHumanLoop.goal;
            break;
          }
        }

        if (stopReason) {
          await this.appendExecutionLog(
            currentTask,
            execution,
            "goal.stop_reason_continued",
            `Continuing repair after stop signal: ${stopReason}`,
            {
              stopReason,
              riskLevel: evalResult.riskLevel,
              iteration: loopCount,
              maxIterations: nextGoal.maxIterations,
              evalResultId: evalResult.id,
              score: evalResult.score,
              evalPassed: evalResult.passed
            },
            this.buildCorrelation({ task: currentTask, execution, agentId: agent.id })
          );
        }

        await this.updateExecutionStatus(execution, currentTask, "repairing", "Execution requires repair", {
          score: evalResult.score,
          riskLevel: evalResult.riskLevel,
          sessionId: result.sessionId
        });
        currentTask = await this.transitionTask(currentTask, "repairing", "Evaluation failed", qualityPlugin.id, execution);
        currentTask.repairCount = loopCount;
        await this.deps.tasks.save(currentTask);
        await this.publish("goal.iteration_started", "Repair iteration started", currentTask, {
          iteration: loopCount,
          objective: nextGoal.objective,
          sessionId: result.sessionId
        });
        previousResult = result;
      }
    } catch (error) {
      if (isEnvironmentPreparationError(error)) {
        currentTask = await this.handleEnvironmentFailure(currentTask, agent, error);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (execution) {
        execution.summary = message;
        execution.endedAt = this.now();
        await this.updateExecutionStatus(execution, currentTask, "failed", message, {});
      }
      const failedTask = await this.transitionTask(currentTask, "failed", message, "scheduler", execution);
      failedTask.completedAt = this.now();
      await this.deps.tasks.save(failedTask);
      await this.appendExecutionLog(
        failedTask,
        execution,
        "executor.failed",
        message,
        {},
        this.buildCorrelation({ task: failedTask, execution, agentId: agent.id })
      );
      await this.reportTaskResultIfNeeded(failedTask, message);
    } finally {
      stopHeartbeat();
      if (workspace) {
        await environment.cleanupWorkspace(currentTask, workspace);
      }
      await this.releaseAgent(agent);
    }
  }

  private startAgentHeartbeatLoop(agentId: string): () => void {
    let active = true;
    let heartbeatInFlight = false;
    const timer = this.setIntervalFn(() => {
      if (!active || heartbeatInFlight) {
        return;
      }
      heartbeatInFlight = true;
      void this.heartbeatAgent(agentId, "busy")
        .catch(() => undefined)
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, this.executionHeartbeatIntervalMs);

    return () => {
      active = false;
      this.clearIntervalFn(timer);
    };
  }

  private async createExecution(task: TitingTask, agentId: string, workspace: PreparedWorkspace): Promise<ExecutionRecord> {
    const execution: ExecutionRecord = {
      id: this.createId(),
      taskId: task.id,
      agentId,
      workspace: workspace.workspacePath,
      status: "preparing",
      summary: null,
      executor: task.executor,
      startedAt: this.now(),
      endedAt: null
    };
    await this.deps.executions.create(execution);
    await this.appendExecutionLog(task, execution, "execution.preparing", "Workspace prepared for execution", {
      workspacePath: workspace.workspacePath,
      repoPath: workspace.repoPath,
      branch: workspace.branch
    }, this.buildCorrelation({ task, execution, agentId }));
    return execution;
  }

  private async transitionTask(
    task: TitingTask,
    to: TaskStatus,
    reason: string,
    operator: string,
    execution: ExecutionRecord | null = null
  ): Promise<TitingTask> {
    assertValidTransition(task.status, to);
    return this.recordTaskMutation(task, task.status, to, reason, operator, execution);
  }

  private async recordTaskMutation(
    task: TitingTask,
    from: TaskStatus,
    to: TaskStatus,
    reason: string,
    operator: string,
    execution: ExecutionRecord | null = null
  ): Promise<TitingTask> {
    task.status = to;
    task.updatedAt = this.now();
    await this.deps.tasks.save(task);
    const transition: TaskTransition = {
      taskId: task.id,
      traceId: task.traceId,
      from,
      to,
      reason,
      operator,
      timestamp: this.now()
    };
    await this.deps.taskTransitions.append(transition);
    const correlation = this.buildCorrelation({
      task,
      execution,
      pluginId: operator,
      eventId: this.createId()
    });
    await this.appendExecutionLog(task, execution, "task.transition", reason, {
      traceId: task.traceId,
      from,
      to,
      operator
    }, correlation);
    await this.publish(`task.${to}`, reason, task, {
      from,
      to,
      operator
    }, { execution, pluginId: operator, correlation });
    return task;
  }

  private async emitStatus(task: TitingTask, to: TaskStatus, reason: string, operator: string): Promise<void> {
    await this.deps.taskTransitions.append({
      taskId: task.id,
      traceId: task.traceId,
      from: to,
      to,
      reason,
      operator,
      timestamp: this.now()
    });
    const correlation = this.buildCorrelation({
      task,
      pluginId: operator,
      eventId: this.createId()
    });
    await this.appendExecutionLog(task, null, "task.transition", reason, {
      traceId: task.traceId,
      from: to,
      to,
      operator
    }, correlation);
    await this.publish(`task.${to}`, reason, task, { from: to, to, operator }, { pluginId: operator, correlation });
  }

  private async appendExecutionLog(
    task: TitingTask,
    execution: ExecutionRecord | null,
    eventType: string,
    message: string,
    data: Record<string, unknown>,
    correlation: ObservabilityCorrelation
  ): Promise<void> {
    await this.deps.executionLogs.append({
      id: this.createId(),
      taskId: task.id,
      executionId: execution?.id ?? null,
      eventType,
      message,
      data: {
        ...data,
        correlation
      },
      createdAt: this.now()
    });
  }

  private async updateExecutionStatus(
    execution: ExecutionRecord,
    task: TitingTask,
    status: ExecutionRecord["status"],
    message: string,
    data: Record<string, unknown>
  ): Promise<void> {
    execution.status = status;
    if (status === "completed" || status === "failed") {
      execution.endedAt = execution.endedAt ?? this.now();
    }
    await this.deps.executions.save(execution);
    const correlation = this.buildCorrelation({
      task,
      execution,
      eventId: this.createId()
    });
    await this.appendExecutionLog(task, execution, `execution.${status}`, message, data, correlation);
    await this.publish(`execution.${status}`, message, task, {
      executionId: execution.id,
      status,
      ...data
    }, { execution, correlation });
  }

  private async recordGovernanceEntries(
    task: TitingTask,
    execution: ExecutionRecord | null,
    container: Record<string, unknown>,
    agentId?: string
  ): Promise<void> {
    const entries = readGovernanceEntries(container);
    for (const entry of entries) {
      const eventType = entry.phase === "after_eval" ? "governance.eval" : "governance.command";
      const correlation = this.buildCorrelation({
        task,
        execution,
        pluginId: entry.pluginId,
        agentId,
        eventId: this.createId()
      });
      await this.appendExecutionLog(task, execution, eventType, entry.message, {
        phase: entry.phase,
        outcome: entry.outcome,
        findings: entry.findings,
        metadata: entry.metadata
      }, correlation);
      await this.publish(eventType, entry.message, task, {
        phase: entry.phase,
        outcome: entry.outcome,
        findings: entry.findings,
        metadata: entry.metadata
      }, { execution, pluginId: entry.pluginId, agentId, correlation });
    }
  }

  private async releaseAgent(agent: AgentRecord): Promise<void> {
    agent.status = "idle";
    agent.taskId = null;
    agent.updatedAt = this.now();
    agent.lastHeartbeatAt = this.now();
    await this.deps.agents.upsert(agent);
  }

  private async handleEnvironmentFailure(
    task: TitingTask,
    agent: AgentRecord,
    error: EnvironmentFailureShape
  ): Promise<TitingTask> {
    const reason = `[environment:${error.stage}] ${error.message}`;
    const attempt = task.retryCount + 1;
    task.retryCount = attempt;
    task.updatedAt = this.now();
    await this.deps.tasks.save(task);
    await this.appendExecutionLog(task, null, "environment.failed", reason, {
      agentId: agent.id,
      stage: error.stage,
      retryable: error.retryable,
      detail: error.detail,
      attempt,
      retryLimit: this.environmentRetryLimit
    }, this.buildCorrelation({ task, agentId: agent.id }));

    if (error.retryable && attempt <= this.environmentRetryLimit) {
      const requeuedTask = await this.transitionTask(
        task,
        "queued",
        `${reason}; retry scheduled (${attempt}/${this.environmentRetryLimit})`,
        "scheduler"
      );
      await this.publish("environment.retry_scheduled", "Environment failure scheduled for retry", requeuedTask, {
        agentId: agent.id,
        stage: error.stage,
        detail: error.detail,
        attempt,
        retryLimit: this.environmentRetryLimit
      }, { agentId: agent.id });
      return requeuedTask;
    }

    const blockedTask = await this.transitionTask(
      task,
      "blocked",
      error.retryable
        ? `${reason}; retry budget exhausted`
        : `${reason}; manual intervention required`,
      "scheduler"
    );
    blockedTask.completedAt = this.now();
    await this.deps.tasks.save(blockedTask);
    await this.publish("environment.blocked", "Environment failure blocked task", blockedTask, {
      agentId: agent.id,
      stage: error.stage,
      detail: error.detail,
      retryable: error.retryable,
      attempt,
      retryLimit: this.environmentRetryLimit
    }, { agentId: agent.id });
    await this.reportTaskResultIfNeeded(blockedTask, blockedTask.status === "blocked" ? reason : blockedTask.status);
    return blockedTask;
  }

  private async handleRetryableExecutionFailure(
    task: TitingTask,
    execution: ExecutionRecord,
    agent: AgentRecord,
    result: ExecutionResult
  ): Promise<TitingTask | null> {
    const retryDecision = getExecutionRetryDecision(result);
    if (!retryDecision.retryable) {
      return null;
    }

    const attempt = task.retryCount + 1;
    task.retryCount = attempt;
    task.updatedAt = this.now();
    await this.deps.tasks.save(task);

    const reason = `[execution:${retryDecision.reason}] ${result.summary}`;
    await this.updateExecutionStatus(execution, task, "failed", reason, {
      agentId: agent.id,
      attempt,
      retryLimit: this.executionRetryLimit,
      errorCategory: result.errorCategory,
      timeoutCategory: result.timeoutCategory
    });

    if (attempt <= this.executionRetryLimit) {
      const requeuedTask = await this.transitionTask(
        task,
        "queued",
        `${reason}; retry scheduled (${attempt}/${this.executionRetryLimit})`,
        "scheduler",
        execution
      );
      await this.publish("execution.retry_scheduled", "Execution failure scheduled for retry", requeuedTask, {
        agentId: agent.id,
        attempt,
        retryLimit: this.executionRetryLimit,
        errorCategory: result.errorCategory,
        timeoutCategory: result.timeoutCategory
      }, { execution, agentId: agent.id });
      return requeuedTask;
    }

    const blockedTask = await this.transitionTask(
      task,
      "blocked",
      `${reason}; retry budget exhausted`,
      "scheduler",
      execution
    );
    blockedTask.completedAt = this.now();
    await this.deps.tasks.save(blockedTask);
    await this.publish("execution.blocked", "Execution failure blocked task", blockedTask, {
      agentId: agent.id,
      attempt,
      retryLimit: this.executionRetryLimit,
      errorCategory: result.errorCategory,
      timeoutCategory: result.timeoutCategory
    }, { execution, agentId: agent.id });
    await this.reportTaskResultIfNeeded(blockedTask, result.summary);
    return blockedTask;
  }

  private async requireAgent(id: string): Promise<AgentRecord> {
    const agent = await this.deps.agents.getById(id);
    if (!agent) {
      throw new NotFoundError(`Agent ${id} not found`);
    }
    return agent;
  }

  private async publishAgentEvent(eventType: string, message: string, agent: AgentRecord): Promise<void> {
    await this.publishEvent({
      correlation: this.buildCorrelation({
        traceId: `agent:${agent.id}`,
        taskId: agent.taskId ?? undefined,
        agentId: agent.id
      }),
      eventType,
      message,
      data: {
        status: agent.status,
        executor: agent.executor
      }
    });
  }

  private async ingestPulledTask(pulledTask: TitingTask, operator: string): Promise<TitingTask | null> {
    if (!pulledTask.externalId) {
      return null;
    }

    const existing = await this.deps.tasks.getByExternalId(pulledTask.source, pulledTask.externalId);
    const task = existing
      ? await this.updatePulledTask(existing, pulledTask)
      : await this.createPulledTask(pulledTask);

    if (!task.instruction.trim() || !task.repo.trim() || !task.branch.trim()) {
      if (task.status === "created") {
        return this.transitionTask(task, "blocked", "Pulled task is missing required fields", operator);
      }
      return task;
    }

    if (["created", "validated", "pending"].includes(task.status)) {
      return this.queueTask(task.id, operator);
    }
    return task;
  }

  private async createPulledTask(pulledTask: TitingTask): Promise<TitingTask> {
    const now = this.now();
    const task: TitingTask = {
      ...pulledTask,
      id: this.createId(),
      traceId: this.createId(),
      status: "created",
      retryCount: 0,
      repairCount: 0,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now
    };
    await this.deps.tasks.create(task);
    await this.emitStatus(task, "created", "Task pulled from integration", task.source);
    return task;
  }

  private async updatePulledTask(existing: TitingTask, pulledTask: TitingTask): Promise<TitingTask> {
    existing.title = pulledTask.title;
    existing.instruction = pulledTask.instruction;
    existing.repo = pulledTask.repo;
    existing.branch = pulledTask.branch;
    existing.priority = pulledTask.priority;
    existing.executor = pulledTask.executor;
    existing.constraints = [...pulledTask.constraints];
    existing.acceptanceCriteria = [...pulledTask.acceptanceCriteria];
    existing.metadata = { ...existing.metadata, ...pulledTask.metadata };
    existing.updatedAt = this.now();
    await this.deps.tasks.save(existing);
    return existing;
  }

  private async reportTaskResultIfNeeded(task: TitingTask, summary: string): Promise<void> {
    if (!task.externalId) {
      return;
    }
    const integrations = this.deps.runtime.getTaskIntegrations().filter((plugin) => plugin.id === task.source);
    for (const integration of integrations) {
      await integration.reportResult(task, summary);
      await this.publishEvent({
        correlation: this.buildCorrelation({
          task,
          pluginId: integration.id
        }),
        eventType: "plugin.result_reported",
        message: "Task result reported to integration",
        data: {
          externalId: task.externalId,
          status: task.status
        }
      });
    }
  }

  private async publish(
    eventType: string,
    message: string,
    task: TitingTask,
    data: Record<string, unknown>,
    options: {
      execution?: ExecutionRecord | null;
      pluginId?: string;
      agentId?: string;
      correlation?: ObservabilityCorrelation;
    } = {}
  ): Promise<void> {
    await this.publishEvent({
      correlation: options.correlation ?? this.buildCorrelation({
        task,
        execution: options.execution ?? null,
        pluginId: options.pluginId,
        agentId: options.agentId
      }),
      eventType,
      message,
      data
    });
  }

  private buildCorrelation(input: {
    traceId?: string;
    task?: TitingTask;
    taskId?: string;
    execution?: ExecutionRecord | null;
    executionId?: string;
    pluginId?: string;
    agentId?: string;
    eventId?: string;
  }): ObservabilityCorrelation {
    return {
      correlationId: this.createId(),
      traceId: input.task?.traceId ?? input.traceId ?? "system",
      taskId: input.task?.id ?? input.taskId,
      executionId: input.execution?.id ?? input.executionId,
      pluginId: input.pluginId,
      agentId: input.agentId,
      eventId: input.eventId
    };
  }

  private async publishEvent(input: {
    correlation: ObservabilityCorrelation;
    eventType: string;
    message: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    const eventId = input.correlation.eventId ?? this.createId();
    const correlation = {
      ...input.correlation,
      eventId
    };
    await this.deps.events.publish({
      id: eventId,
      schemaVersion: TitingServices.OBSERVABILITY_SCHEMA_VERSION,
      traceId: correlation.traceId,
      taskId: correlation.taskId,
      executionId: correlation.executionId,
      pluginId: correlation.pluginId,
      agentId: correlation.agentId,
      eventType: input.eventType,
      message: input.message,
      data: {
        ...input.data,
        correlation
      },
      createdAt: this.now()
    });
  }
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function sortTaskPriority(left: TitingTask, right: TitingTask): number {
  const rank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  return rank[right.priority] - rank[left.priority] || left.createdAt.getTime() - right.createdAt.getTime();
}

function readDiffStats(report: Record<string, unknown>): { filesChanged: number; insertions: number; deletions: number } {
  const diff = report.diff;
  if (!diff || typeof diff !== "object") {
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
  const value = diff as Record<string, unknown>;
  return {
    filesChanged: toNumber(value.filesChanged),
    insertions: toNumber(value.insertions),
    deletions: toNumber(value.deletions)
  };
}

function buildFailureHash(
  result: ExecutionResult,
  checks: Array<{ name: string; passed: boolean }>
): string {
  const failedChecks = checks
    .filter((check) => !check.passed)
    .map((check) => check.name)
    .sort();
  return JSON.stringify({
    errorCategory: result.errorCategory,
    timeoutCategory: result.timeoutCategory,
    summary: result.summary,
    failedChecks
  });
}

function decideStopReason(input: {
  qualityRiskLevel: "low" | "medium" | "high";
  repeatedFailureCount: number;
  noDiffStreak: number;
  iteration: number;
  maxIterations: number;
}): "high_risk" | "repeated_failure" | "no_effective_diff" | "budget_limited" | null {
  if (input.iteration >= input.maxIterations) {
    return "budget_limited";
  }
  if (input.qualityRiskLevel === "high") {
    return "high_risk";
  }
  if (input.repeatedFailureCount >= 2) {
    return "repeated_failure";
  }
  if (input.noDiffStreak >= 2) {
    return "no_effective_diff";
  }
  return null;
}

function decideStopReasonWithoutQuality(input: {
  repeatedFailureCount: number;
  iteration: number;
  maxIterations: number;
}): "repeated_failure" | "budget_limited" | null {
  if (input.iteration >= input.maxIterations) {
    return "budget_limited";
  }
  if (input.repeatedFailureCount >= 2) {
    return "repeated_failure";
  }
  return null;
}

function describeStopReason(reason: "high_risk" | "repeated_failure" | "no_effective_diff" | "budget_limited"): string {
  switch (reason) {
    case "high_risk":
      return "High-risk modification detected";
    case "repeated_failure":
      return "Repeated failure pattern detected";
    case "no_effective_diff":
      return "Two consecutive repair rounds produced no effective diff";
    case "budget_limited":
      return "Repair budget exhausted";
  }
}

function getExecutionRetryDecision(result: ExecutionResult): {
  retryable: boolean;
  reason: "timeout" | "launch_error" | null;
} {
  if (result.timeoutCategory === "execution_timeout" || result.errorCategory === "timeout") {
    return {
      retryable: true,
      reason: "timeout"
    };
  }
  if (result.errorCategory === "launch_error") {
    return {
      retryable: true,
      reason: "launch_error"
    };
  }
  return {
    retryable: false,
    reason: null
  };
}

function buildRepairObjective(
  task: TitingTask,
  result: ExecutionResult,
  checks: Array<{ name: string; passed: boolean; detail: string }>
): string {
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  if (failedChecks.length > 0) {
    return `Fix ${failedChecks.join(", ")} while preserving task intent for ${task.title}`;
  }
  return `Address ${result.errorCategory} and complete ${task.title}`;
}

function buildRepairConstraints(task: TitingTask, riskLevel: "low" | "medium" | "high"): string[] {
  const constraints = [...task.constraints];
  if (riskLevel !== "low") {
    constraints.push(`Avoid ${riskLevel} risk changes`);
  }
  return constraints;
}

function buildRepairDoneWhen(
  task: TitingTask,
  checks: Array<{ name: string; passed: boolean }>
): string[] {
  const failedChecks = checks.filter((check) => !check.passed).map((check) => `Pass ${check.name}`);
  if (task.acceptanceCriteria.length > 0) {
    return [...task.acceptanceCriteria, ...failedChecks];
  }
  return failedChecks.length > 0 ? failedChecks : ["All checks pass"];
}

function buildRepairDoneWhenWithoutQuality(task: TitingTask): string[] {
  return task.acceptanceCriteria.length > 0 ? [...task.acceptanceCriteria] : ["Successful execution"];
}

function readQualityChecks(report: Record<string, unknown>): Array<{ name: string; passed: boolean; detail: string }> {
  const checks = report.checks;
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "unknown",
      passed: item.passed === true,
      detail: typeof item.detail === "string" ? item.detail : ""
    }));
}

function readGovernanceEntries(container: Record<string, unknown>): Array<{
  phase: string;
  outcome: string;
  message: string;
  findings: string[];
  metadata: Record<string, unknown>;
  pluginId?: string;
}> {
  const governance = container.governance;
  const entries = Array.isArray(governance) ? governance : governance ? [governance] : [];
  return entries
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      phase: typeof item.phase === "string" ? item.phase : "unknown",
      outcome: typeof item.outcome === "string" ? item.outcome : "flagged",
      message: typeof item.message === "string" ? item.message : "Governance policy applied",
      findings: Array.isArray(item.findings)
        ? item.findings.filter((finding): finding is string => typeof finding === "string")
        : [],
      metadata: typeof item.metadata === "object" && item.metadata !== null
        ? item.metadata as Record<string, unknown>
        : {},
      pluginId: typeof item.pluginId === "string" ? item.pluginId : undefined
    }));
}

function sortHumanReplies(replies: HumanReply[]): HumanReply[] {
  return [...replies].sort((left, right) => {
    const byTime = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    if (byTime !== 0) {
      return byTime;
    }
    return left.replyId.localeCompare(right.replyId);
  });
}

function appendHumanReplyToInstruction(instruction: string, reply: HumanReply): string {
  const author = reply.author?.trim() ? `, ${reply.author.trim()}` : "";
  return `${instruction.trim()}\n\nHuman reply (${reply.createdAt}${author}):\n${reply.body.trim()}`.trim();
}

function appendHumanGuidanceConstraint(constraints: string[], body: string): string[] {
  return [...constraints, `Human guidance: ${body.trim()}`];
}

function trimReplyIds(replyIds: string[]): string[] {
  return replyIds.slice(-20);
}

function readHumanLoopMetadata(metadata: Record<string, unknown>): {
  requestId?: string;
  requestedAt?: string;
  seenReplyIds: string[];
} {
  const humanLoop = metadata.humanLoop;
  if (!humanLoop || typeof humanLoop !== "object") {
    return { seenReplyIds: [] };
  }
  const value = humanLoop as Record<string, unknown>;
  return {
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    requestedAt: typeof value.requestedAt === "string" ? value.requestedAt : undefined,
    seenReplyIds: Array.isArray(value.seenReplyIds)
      ? value.seenReplyIds.filter((item): item is string => typeof item === "string")
      : []
  };
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type EnvironmentFailureShape = {
  message: string;
  stage: string;
  detail: string;
  retryable: boolean;
};

function isEnvironmentPreparationError(error: unknown): error is EnvironmentFailureShape {
  if (!error || typeof error !== "object") {
    return false;
  }
  const value = error as Record<string, unknown>;
  return value.name === "EnvironmentPreparationError"
    && typeof value.message === "string"
    && typeof value.stage === "string"
    && typeof value.detail === "string"
    && typeof value.retryable === "boolean";
}
