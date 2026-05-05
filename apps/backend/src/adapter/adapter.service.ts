import { Injectable, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EventsService } from "../events/events.service";
import { ExecutionLogService } from "../execution-logs/execution-log.service";
import { Task } from "../tasks/task.entity";
import { hasValidExecutionFields } from "../tasks/task-status";
import { MeegleAdapter } from "./meegle.adapter";
import { mapRawTaskToTaskInput, RawMeegleTask } from "./task-mapper";

export type SyncItemAction = "created" | "updated" | "failed" | "recovered" | "resetToPending";

export type SyncResult = {
  summary: {
    created: number;
    updated: number;
    failed: number;
    recovered: number;
    resetToPending: number;
  };
  items: Array<{
    externalId: string;
    taskId?: string;
    action: SyncItemAction;
    reason: string;
  }>;
};

@Injectable()
export class AdapterService {
  constructor(
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>,
    private readonly executionLogService: ExecutionLogService,
    private readonly meegleAdapter: MeegleAdapter,
    @Optional()
    private readonly eventsService?: EventsService
  ) {}

  async sync(): Promise<SyncResult> {
    const rawTasks = await this.meegleAdapter.listOpenTasks();
    const result = this.createEmptyResult();

    for (const rawTask of rawTasks) {
      const item = await this.upsertRawTask(rawTask);
      result.items.push(item);
      result.summary[item.action] += 1;
    }

    return result;
  }

  async listRawTasks(): Promise<RawMeegleTask[]> {
    return this.meegleAdapter.listOpenTasks();
  }

  private async upsertRawTask(rawTask: RawMeegleTask): Promise<SyncResult["items"][number]> {
    const input = mapRawTaskToTaskInput(rawTask);
    const existing = await this.taskRepository.findOne({ where: { externalId: rawTask.id } });
    const task = existing ?? this.taskRepository.create(input);
    const previousExecutionKey = this.getExecutionKey(task);

    Object.assign(task, {
      title: input.title,
      description: input.description,
      repo: input.repo,
      branch: input.branch,
      instruction: input.instruction,
      priority: input.priority,
      taskType: input.taskType
    });

    if (!existing) {
      task.status = hasValidExecutionFields(task) ? "pending" : "failed";
      const saved = await this.taskRepository.save(task);
      if (saved.status === "failed") {
        await this.appendInvalidLog(saved);
        this.publishTask(saved);
        return {
          externalId: rawTask.id,
          taskId: saved.id,
          action: "failed",
          reason: "missing execution fields"
        };
      }
      this.publishTask(saved);
      return {
        externalId: rawTask.id,
        taskId: saved.id,
        action: "created",
        reason: "new task imported"
      };
    }

    const nextExecutionKey = this.getExecutionKey(task);
    if (!hasValidExecutionFields(task)) {
      task.status = "failed";
      const saved = await this.taskRepository.save(task);
      await this.appendInvalidLog(saved);
      this.publishTask(saved);
      return {
        externalId: rawTask.id,
        taskId: saved.id,
        action: "failed",
        reason: "missing execution fields"
      };
    }

    if (existing.status === "failed") {
      this.clearRuntimeFields(task);
      task.status = "pending";
      const saved = await this.taskRepository.save(task);
      this.publishTask(saved);
      return {
        externalId: rawTask.id,
        taskId: saved.id,
        action: "recovered",
        reason: "failed task became valid"
      };
    }

    if (existing.status === "done" && previousExecutionKey !== nextExecutionKey) {
      this.clearRuntimeFields(task);
      task.status = "pending";
      const saved = await this.taskRepository.save(task);
      this.publishTask(saved);
      return {
        externalId: rawTask.id,
        taskId: saved.id,
        action: "resetToPending",
        reason: "execution fields changed after done"
      };
    }

    const saved = await this.taskRepository.save(task);
    this.publishTask(saved);
    return {
      externalId: rawTask.id,
      taskId: saved.id,
      action: "updated",
      reason: "existing task updated"
    };
  }

  private createEmptyResult(): SyncResult {
    return {
      summary: {
        created: 0,
        updated: 0,
        failed: 0,
        recovered: 0,
        resetToPending: 0
      },
      items: []
    };
  }

  private getExecutionKey(task: Pick<Task, "repo" | "branch" | "instruction">): string {
    return JSON.stringify({
      repo: task.repo,
      branch: task.branch,
      instruction: task.instruction
    });
  }

  private clearRuntimeFields(task: Task): void {
    task.agentId = null;
    task.claimedAt = null;
    task.startedAt = null;
    task.completedAt = null;
  }

  private async appendInvalidLog(task: Task): Promise<void> {
    await this.executionLogService.append({
      taskId: task.id,
      agentId: task.agentId,
      status: "failed",
      message: "Task execution fields are invalid",
      metadata: {
        missingFields: [
          task.repo?.trim() ? null : "repo",
          task.branch?.trim() ? null : "branch",
          task.instruction?.trim() ? null : "instruction"
        ].filter(Boolean)
      }
    });
  }

  private publishTask(task: Task): void {
    this.eventsService?.publishTaskLifecycle(task.id, task.status, task.agentId);
  }
}
