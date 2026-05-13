/**
 * 后台调度：`runSchedulerTick` 串联 **集成拉单**（`pullTasks`）、**心跳超时的 Agent/任务恢复**、
 * **按优先级派发 `queued` 任务**（claim agent → `claimQueued` → `ServiceExecution.runTask`）。
 *
 * `schedulerTickInFlight` 避免重入；并行 tick 会发出 `scheduler.tick_skipped`。
 */
import { AgentRecord, PluginConfig, TaskIntegrationPlugin, TitingTask } from "@titing/plugin-api";
import { ServiceSupport } from "./service-support";
import {
  appendHumanGuidanceConstraint,
  appendHumanReplyToInstruction,
  attachBranchMetadata,
  buildDefaultTaskBranch,
  normalizeOptionalBranch,
  readHumanLoopMetadata,
  ServiceConfig,
  ServiceDependencies,
  sortHumanReplies,
  sortTaskPriority,
  trimReplyIds
} from "./service-shared";
import { ServiceExecution } from "./service-execution";

type SchedulerTaskHost = {
  queueTask(id: string, operator?: string): Promise<TitingTask>;
};

/**
 * @param taskHost - 通常为 `TitingServices`，仅需 `queueTask` 将集成拉取的任务推进到队列。
 */
export class ServiceScheduler {
  private schedulerTickInFlight = false;

  constructor(
    private readonly deps: ServiceDependencies,
    private readonly config: ServiceConfig,
    private readonly support: ServiceSupport,
    private readonly execution: ServiceExecution,
    private readonly taskHost: SchedulerTaskHost
  ) {}

  /**
   * 单线程 tick：sync（拉单+可选人工回复）→ recoverOffline → dispatch。
   * 若上一 tick 未结束则跳过并打点。
   */
  async runSchedulerTick(): Promise<void> {
    if (this.schedulerTickInFlight) {
      await this.support.publishEvent({
        correlation: this.support.buildCorrelation({ traceId: "scheduler" }),
        eventType: "scheduler.tick_skipped",
        message: "Scheduler tick skipped because a previous tick is still running",
        data: {}
      });
      return;
    }
    this.schedulerTickInFlight = true;
    try {
      await this.support.publishEvent({
        correlation: this.support.buildCorrelation({ traceId: "scheduler" }),
        eventType: "scheduler.tick_started",
        message: "Scheduler tick started",
        data: {}
      });
      await this.syncTaskIntegrations();
      await this.recoverOfflineAgentsAndTasks();
      await this.dispatchQueuedTasks();
    } finally {
      await this.support.publishEvent({
        correlation: this.support.buildCorrelation({ traceId: "scheduler" }),
        eventType: "scheduler.tick_completed",
        message: "Scheduler tick completed",
        data: {}
      });
      this.schedulerTickInFlight = false;
    }
  }

  /**
   * 逐个 integration `pullTasks`，不健康则跳过；可选 `pullHumanReplies`（`enableNeedsHumanLoop`）。
   * 返回集成的数量与拉取到的任务条数（条数包含多插件之和）。
   */
  async runTaskSyncNow(): Promise<{ integrations: number; pulledTasks: number }> {
    const integrations = this.deps.runtime.getTaskIntegrations();
    let pulledTasks = 0;
    await this.support.publishEvent({
      correlation: this.support.buildCorrelation({ traceId: "scheduler" }),
      eventType: "scheduler.sync_started",
      message: "Task integration sync started",
      data: { integrations: integrations.length }
    });
    for (const integration of integrations) {
      const health = await integration.health();
      if (!health.healthy) {
        await this.support.publishEvent({
          correlation: this.support.buildCorrelation({
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
      await this.support.publishEvent({
        correlation: this.support.buildCorrelation({
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
      if (this.config.enableNeedsHumanLoop && integration.pullHumanReplies) {
        try {
          await this.syncHumanRepliesForIntegration(
            integration as TaskIntegrationPlugin & Required<Pick<TaskIntegrationPlugin, "pullHumanReplies">>
          );
        } catch (error) {
          await this.support.publishEvent({
            correlation: this.support.buildCorrelation({
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
    await this.support.publishEvent({
      correlation: this.support.buildCorrelation({ traceId: "scheduler" }),
      eventType: "scheduler.sync_completed",
      message: "Task integration sync completed",
      data: { integrations: integrations.length, pulledTasks }
    });
    return { integrations: integrations.length, pulledTasks };
  }

  /** 仅执行派发阶段并返回 tick 前队列深度（调试用）。 */
  async runSchedulerDispatchNow(): Promise<{ queuedBefore: number }> {
    const queuedBefore = (await this.deps.tasks.list({ status: "queued" })).length;
    await this.support.publishEvent({
      correlation: this.support.buildCorrelation({ traceId: "scheduler" }),
      eventType: "scheduler.dispatch_started",
      message: "Scheduler dispatch started",
      data: { queuedBefore }
    });
    await this.dispatchQueuedTasks();
    await this.support.publishEvent({
      correlation: this.support.buildCorrelation({ traceId: "scheduler" }),
      eventType: "scheduler.dispatch_completed",
      message: "Scheduler dispatch completed",
      data: { queuedBefore }
    });
    return { queuedBefore };
  }

  /** 语义上等同于 `runTaskSyncNow`（全量集成同步），供 `TitingServices.syncTaskIntegrations` 委托。 */
  async syncTaskIntegrations(): Promise<void> {
    await this.runTaskSyncNow();
  }

  /** Webhook 等外部入口复用与 pull 相同的入库+入队逻辑。 */
  async ingestTaskFromIntegration(task: TitingTask, operator: string): Promise<TitingTask | null> {
    return this.ingestPulledTask(task, operator);
  }

  /**
   * 按优先级遍历 `queued`：申请 idle Agent → CAS `claimQueued` → 记录迁移到 `running` 并交给 `ServiceExecution`。
   */
  private async dispatchQueuedTasks(): Promise<void> {
    const queuedTasks = (await this.deps.tasks.list({ status: "queued" })).sort(sortTaskPriority);
    for (const task of queuedTasks) {
      const now = this.support.now();
      const agent = await this.deps.agents.claimIdle(task.executor, task.id, now);
      if (!agent) {
        break;
      }

      const claimedTask = await this.deps.tasks.claimQueued(task.id, now);
      if (!claimedTask) {
        await this.support.releaseAgent(agent);
        continue;
      }

      await this.support.recordTaskMutation(claimedTask, "queued", "running", "Task claimed by scheduler", "scheduler");
      await this.execution.runTask(claimedTask, agent);
    }
  }

  /**
   * 心跳早于 `now - agentOfflineTimeoutMs` 的 Agent：`running` 任务踢回 `queued`，Agent 标为 `offline`。
   */
  private async recoverOfflineAgentsAndTasks(): Promise<void> {
    const staleBefore = new Date(this.support.now().getTime() - this.config.agentOfflineTimeoutMs);
    const agents = await this.deps.agents.list();
    for (const agent of agents) {
      if (agent.lastHeartbeatAt > staleBefore) {
        continue;
      }
      if (agent.status === "busy" && agent.taskId) {
        const task = await this.deps.tasks.getById(agent.taskId);
        if (task?.status === "running") {
          await this.support.transitionTask(task, "queued", "Agent heartbeat timed out; task re-queued", "scheduler");
          await this.support.appendExecutionLog(task, null, "scheduler.task_requeued", "Task re-queued after agent timeout", {
            agentId: agent.id,
            lastHeartbeatAt: agent.lastHeartbeatAt.toISOString()
          }, this.support.buildCorrelation({ task, agentId: agent.id }));
          await this.support.publish("scheduler.task_requeued", "Task re-queued after agent timeout", task, {
            agentId: agent.id,
            lastHeartbeatAt: agent.lastHeartbeatAt.toISOString()
          }, { agentId: agent.id });
        }
      }
      if (agent.status === "busy" || agent.status === "idle") {
        agent.status = "offline";
        agent.updatedAt = this.support.now();
        await this.deps.agents.upsert(agent);
        await this.support.publishAgentEvent("agent.offline", "Agent marked offline after heartbeat timeout", agent);
      }
    }
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
    reply: Awaited<ReturnType<NonNullable<TaskIntegrationPlugin["pullHumanReplies"]>>>[number]
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
    task.updatedAt = this.support.now();
    await this.deps.tasks.save(task);

    const goal = await this.deps.repairGoals.getByTaskId(task.id);
    if (goal) {
      await this.deps.repairGoals.upsert({
        ...goal,
        status: "repairing",
        constraints: appendHumanGuidanceConstraint(goal.constraints, reply.body),
        updatedAt: this.support.now()
      });
    }

    await this.support.appendExecutionLog(task, null, "goal.human_reply_received", "Human reply received from integration comment", {
      replyId: reply.replyId,
      externalId: reply.externalId,
      author: reply.author,
      createdAt: reply.createdAt
    }, this.support.buildCorrelation({ task, pluginId: integration.id }));

    task.startedAt = null;
    task.completedAt = null;
    task.updatedAt = this.support.now();
    await this.deps.tasks.save(task);
    await this.support.transitionTask(task, "queued", "Recovered from integration comment reply", integration.id);
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
        return this.support.transitionTask(task, "blocked", "Pulled task is missing required fields", operator);
      }
      return task;
    }

    if (["created", "validated", "pending"].includes(task.status)) {
      return this.taskHost.queueTask(task.id, operator);
    }
    return task;
  }

  private async createPulledTask(pulledTask: TitingTask): Promise<TitingTask> {
    const now = this.support.now();
    const id = this.support.createId();
    const normalizedBranch = normalizeOptionalBranch(pulledTask.branch);
    const task: TitingTask = {
      ...pulledTask,
      id,
      traceId: this.support.createId(),
      branch: normalizedBranch ?? buildDefaultTaskBranch(id, now),
      status: "created",
      retryCount: 0,
      repairCount: 0,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      metadata: attachBranchMetadata(pulledTask.metadata, normalizedBranch === null)
    };
    await this.deps.tasks.create(task);
    await this.support.emitStatus(task, "created", "Task pulled from integration", task.source);
    return task;
  }

  private async updatePulledTask(existing: TitingTask, pulledTask: TitingTask): Promise<TitingTask> {
    const normalizedBranch = normalizeOptionalBranch(pulledTask.branch);
    existing.title = pulledTask.title;
    existing.instruction = pulledTask.instruction;
    existing.repo = pulledTask.repo;
    existing.branch = normalizedBranch ?? existing.branch;
    existing.priority = pulledTask.priority;
    existing.executor = pulledTask.executor;
    existing.constraints = [...pulledTask.constraints];
    existing.acceptanceCriteria = [...pulledTask.acceptanceCriteria];
    existing.metadata = attachBranchMetadata({ ...existing.metadata, ...pulledTask.metadata }, normalizedBranch === null);
    existing.updatedAt = this.support.now();
    await this.deps.tasks.save(existing);
    return existing;
  }
}
