import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { EventsService } from "../events/events.service";
import { ExecutionLogService } from "../execution-logs/execution-log.service";
import { TASK_STORE_PLUGIN } from "../plugins/plugin.tokens";
import { ListTasksQuery, TaskStorePlugin } from "../plugins/task-store.plugin";
import { normalizeStoredBranch, resolveExecutionBranch } from "./task-branch";
import { Task, TaskPriority, TaskStatus } from "./task.entity";
import { hasValidExecutionFields, TERMINAL_TASK_STATUSES } from "./task-status";

export type UpdateExecutionFieldsInput = {
  repo?: string;
  branch?: string;
  instruction?: string;
};

@Injectable()
export class TaskService {
  constructor(
    @Inject(TASK_STORE_PLUGIN)
    private readonly taskStore: TaskStorePlugin,
    private readonly executionLogService: ExecutionLogService,
    @Optional()
    private readonly eventsService?: EventsService
  ) {}

  async listTasks(query: ListTasksQuery = {}): Promise<Task[]> {
    return this.taskStore.listTasks(query);
  }

  async getTask(id: string): Promise<Task> {
    const task = await this.taskStore.getTask(id);
    if (!task) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    return task;
  }

  async enqueue(id: string): Promise<Task> {
    const task = await this.getTask(id);
    if (task.status !== "pending") {
      throw new BadRequestException(`Only pending tasks can be enqueued`);
    }

    task.branch = resolveExecutionBranch(task.branch);
    task.status = "queued";
    const saved = await this.taskStore.saveTask(task);
    await this.executionLogService.append({
      taskId: saved.id,
      agentId: saved.agentId,
      status: saved.status,
      message: "Task enqueued"
    });
    this.eventsService?.publishTaskLifecycle(saved.id, saved.status, saved.agentId);
    return saved;
  }

  async claim(id: string, agentId: string): Promise<Task> {
    if (!agentId?.trim()) {
      throw new BadRequestException("X-Agent-Id is required");
    }

    const task = await this.getTask(id);
    if (task.status !== "queued") {
      throw new BadRequestException(`Only queued tasks can be claimed`);
    }

    const now = new Date();
    task.status = "running";
    task.agentId = agentId;
    task.claimedAt = now;
    task.startedAt = now;

    const saved = await this.taskStore.saveTask(task);
    await this.executionLogService.append({
      taskId: saved.id,
      agentId,
      status: saved.status,
      message: "Task claimed and started"
    });
    this.eventsService?.publishTaskLifecycle(saved.id, saved.status, saved.agentId);
    return saved;
  }

  async updateExecutionFields(id: string, input: UpdateExecutionFieldsInput): Promise<Task> {
    const task = await this.getTask(id);
    if (!["pending", "queued", "failed"].includes(task.status)) {
      throw new BadRequestException("Only pending, queued, and failed tasks can be edited");
    }

    if (input.repo !== undefined) {
      task.repo = input.repo;
    }
    if (input.branch !== undefined) {
      task.branch = normalizeStoredBranch(input.branch);
    }
    if (input.instruction !== undefined) {
      task.instruction = input.instruction;
    }

    if (hasValidExecutionFields(task)) {
      task.status = "pending";
    } else {
      task.status = "failed";
      await this.executionLogService.append({
        taskId: task.id,
        agentId: task.agentId,
        status: "failed",
        message: "Task execution fields are invalid",
        metadata: {
          missingFields: this.getMissingExecutionFields(task)
        }
      });
    }

    const saved = await this.taskStore.saveTask(task);
    this.eventsService?.publishTaskLifecycle(saved.id, saved.status, saved.agentId);
    return saved;
  }

  async markFailedInternal(
    id: string,
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<Task> {
    const task = await this.getTask(id);
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new BadRequestException("Terminal tasks cannot transition");
    }

    task.status = "failed";
    task.completedAt = new Date();
    const saved = await this.taskStore.saveTask(task);
    await this.executionLogService.append({
      taskId: saved.id,
      agentId: saved.agentId,
      status: saved.status,
      message,
      metadata
    });
    this.eventsService?.publishTaskLifecycle(saved.id, saved.status, saved.agentId);
    return saved;
  }

  async markDoneInternal(id: string, metadata?: Record<string, unknown>): Promise<Task> {
    const task = await this.getTask(id);
    if (task.status !== "running") {
      throw new BadRequestException("Only running tasks can complete");
    }

    task.status = "done";
    task.completedAt = new Date();
    const saved = await this.taskStore.saveTask(task);
    await this.executionLogService.append({
      taskId: saved.id,
      agentId: saved.agentId,
      status: saved.status,
      message: "Task completed",
      metadata
    });
    this.eventsService?.publishTaskLifecycle(saved.id, saved.status, saved.agentId);
    return saved;
  }

  async retryFailed(id: string): Promise<Task> {
    const task = await this.getTask(id);
    if (task.status !== "failed") {
      throw new BadRequestException("Only failed tasks can be retried");
    }
    if (!hasValidExecutionFields(task)) {
      throw new BadRequestException("Cannot retry task with invalid execution fields");
    }

    task.status = "queued";
    const saved = await this.taskStore.saveTask(task);
    await this.executionLogService.append({
      taskId: saved.id,
      agentId: saved.agentId,
      status: saved.status,
      message: "Task retried from failed state"
    });
    this.eventsService?.publishTaskLifecycle(saved.id, saved.status, saved.agentId);
    return saved;
  }

  async retryRunningAfterAgentOffline(id: string): Promise<Task> {
    const task = await this.getTask(id);
    if (task.status !== "running") {
      throw new BadRequestException("Only running tasks can be retried after agent offline");
    }
    if (task.retryCount >= 1) {
      return this.markFailedInternal(id, "Agent offline retry limit reached", {
        retryCount: task.retryCount
      });
    }

    task.status = "queued";
    task.retryCount += 1;
    const saved = await this.taskStore.saveTask(task);
    await this.executionLogService.append({
      taskId: saved.id,
      agentId: saved.agentId,
      status: saved.status,
      message: "Task requeued after agent offline",
      metadata: { retryCount: saved.retryCount }
    });
    this.eventsService?.publishTaskLifecycle(saved.id, saved.status, saved.agentId);
    return saved;
  }

  async resetForRerun(
    id: string,
    targetStatus: "pending" | "queued",
    resetRetryCount: boolean
  ): Promise<Task> {
    const task = await this.getTask(id);
    task.status = targetStatus;
    task.agentId = null;
    task.claimedAt = null;
    task.startedAt = null;
    task.completedAt = null;
    if (resetRetryCount) {
      task.retryCount = 0;
    }

    const saved = await this.taskStore.saveTask(task);
    await this.executionLogService.append({
      taskId: saved.id,
      status: saved.status,
      message: `Task reset to ${targetStatus}`
    });
    this.eventsService?.publishTaskLifecycle(saved.id, saved.status, saved.agentId);
    return saved;
  }

  private getMissingExecutionFields(task: Task): string[] {
    return [
      task.repo?.trim() ? null : "repo",
      task.instruction?.trim() ? null : "instruction"
    ].filter((field): field is string => Boolean(field));
  }
}
