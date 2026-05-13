/**
 * 横切能力：**任务状态迁移**（与 state-machine 一致）、**执行日志**、**可观测事件发布**、
 * **Agent 释放与集成回传**。被 `TitingServices`、`ServiceExecution`、`ServiceScheduler` 共享，
 * 避免在多处复制「写 transition + append log + publish」样板。
 */
import {
  AgentRecord,
  EnvironmentRuntimeEvent,
  ExecutionRecord,
  ExecutionRuntimeEvent,
  ObservabilityCorrelation,
  TaskStatus,
  TaskTransition,
  TitingTask
} from "@titing/plugin-api";
import { NotFoundError } from "./errors";
import { assertValidTransition } from "./state-machine";
import { readGovernanceEntries, ServiceConfig, ServiceDependencies } from "./service-shared";

/**
 * 所有 API 与后台定时逻辑共享的「写路径」助手：持有一份 `schemaVersion` 用于 `events.publish`。
 */
export class ServiceSupport {
  constructor(
    private readonly deps: ServiceDependencies,
    private readonly config: ServiceConfig,
    private readonly schemaVersion: string
  ) {}

  /** 测试注入或时钟冻结：与 `ServiceConfig.now` 一致。 */
  now(): Date {
    return this.config.now();
  }

  createId(): string {
    return this.config.createId();
  }

  /**
   * 合法迁移：先 `assertValidTransition`，再落库任务、追加 transition、写执行日志并广播可观测事件。
   * `execution` 用于把当前执行实例挂到 correlation / 日志上。
   */
  async transitionTask(
    task: TitingTask,
    to: TaskStatus,
    reason: string,
    operator: string,
    execution: ExecutionRecord | null = null
  ): Promise<TitingTask> {
    assertValidTransition(task.status, to);
    return this.recordTaskMutation(task, task.status, to, reason, operator, execution);
  }

  async recordTaskMutation(
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

  /**
   * 「创建瞬间」等非完整 transition 场景的轻量事件：from/to 相同，仅写一条过渡记录用于观测（如 `created`）。
   */
  async emitStatus(task: TitingTask, to: TaskStatus, reason: string, operator: string): Promise<void> {
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

  async appendExecutionLog(
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

  async recordEnvironmentRuntimeEvent(
    task: TitingTask,
    agentId: string,
    event: EnvironmentRuntimeEvent
  ): Promise<void> {
    await this.appendExecutionLog(
      task,
      null,
      `environment.runtime.${event.type}`,
      this.describeEnvironmentRuntimeEvent(event),
      { runtimeEvent: event },
      this.buildCorrelation({ task, agentId })
    );
  }

  async recordExecutionRuntimeEvent(
    task: TitingTask,
    execution: ExecutionRecord,
    agentId: string,
    event: ExecutionRuntimeEvent
  ): Promise<void> {
    await this.appendExecutionLog(
      task,
      execution,
      `execution.runtime.${event.type}`,
      this.describeExecutionRuntimeEvent(event),
      { runtimeEvent: event },
      this.buildCorrelation({ task, execution, agentId })
    );
  }

  async updateExecutionStatus(
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

  async recordGovernanceEntries(
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

  async requireAgent(id: string): Promise<AgentRecord> {
    const agent = await this.deps.agents.getById(id);
    if (!agent) {
      throw new NotFoundError(`Agent ${id} not found`);
    }
    return agent;
  }

  async releaseAgent(agent: AgentRecord): Promise<void> {
    agent.status = "idle";
    agent.taskId = null;
    agent.updatedAt = this.now();
    agent.lastHeartbeatAt = this.now();
    await this.deps.agents.upsert(agent);
  }

  async reportTaskResultIfNeeded(task: TitingTask, summary: string): Promise<void> {
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

  async publishAgentEvent(eventType: string, message: string, agent: AgentRecord): Promise<void> {
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

  async publish(
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

  buildCorrelation(input: {
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

  async publishEvent(input: {
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
      schemaVersion: this.schemaVersion,
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

  private describeEnvironmentRuntimeEvent(event: EnvironmentRuntimeEvent): string {
    switch (event.type) {
      case "command_start":
        return `Environment stage started: ${event.stage}`;
      case "spawn":
        return `Environment process spawned: ${event.stage}`;
      case "stdout":
        return `Environment stdout chunk received: ${event.stage}`;
      case "stderr":
        return `Environment stderr chunk received: ${event.stage}`;
      case "timeout":
        return `Environment command timed out: ${event.stage}`;
      case "error":
        return `Environment process error: ${event.stage}`;
      case "close":
        return `Environment process closed: ${event.stage}`;
      case "result":
        return `Environment stage finished: ${event.stage}`;
    }
  }

  private describeExecutionRuntimeEvent(event: ExecutionRuntimeEvent): string {
    switch (event.type) {
      case "command_start":
        return "Executor command started";
      case "spawn":
        return "Executor process spawned";
      case "stdout":
        return "Executor stdout chunk received";
      case "stderr":
        return "Executor stderr chunk received";
      case "timeout":
        return "Executor command timed out";
      case "error":
        return "Executor process error";
      case "close":
        return "Executor process closed";
      case "result":
        return "Executor command finished";
      case "session_create_start":
        return "Executor session creation started";
      case "session_create_result":
        return "Executor session created";
    }
  }
}
