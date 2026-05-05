import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { AgentService } from "../agents/agent.service";
import { Task } from "../tasks/task.entity";
import { TaskService } from "../tasks/task.service";
import { hasValidExecutionFields } from "../tasks/task-status";
import { CodexRunner } from "./codex-runner";
import { ResultReporterService } from "./result-reporter.service";

const PRIORITY_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1
};

@Injectable()
export class OrchestratorService {
  constructor(
    private readonly taskService: TaskService,
    private readonly agentService: AgentService,
    private readonly codexRunner: CodexRunner,
    private readonly resultReporter: ResultReporterService
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async poll(): Promise<void> {
    await this.agentService.ensurePool(Number(process.env.AGENT_POOL_SIZE ?? 2));
    const offlineAgents = await this.agentService.detectOfflineAgents(
      Number(process.env.AGENT_HEARTBEAT_TIMEOUT_SECONDS ?? 60)
    );
    for (const agent of offlineAgents) {
      if (agent.taskId) {
        await this.taskService.retryRunningAfterAgentOffline(agent.taskId);
        await this.agentService.markIdle(agent.id);
      }
    }

    const tasks = await this.taskService.listTasks({});
    const runnableTasks = tasks
      .filter((task) => task.status === "pending" || task.status === "queued")
      .sort((left, right) => this.compareRunnableTasks(left, right));

    const running: Array<Promise<void>> = [];
    for (const task of runnableTasks) {
      const queuedTask = await this.prepareQueuedTask(task);
      if (!queuedTask) {
        continue;
      }

      const agent = await this.agentService.claimIdleAgent(queuedTask.id);
      if (!agent) {
        break;
      }
      const runningTask = await this.taskService.claim(queuedTask.id, agent.id);
      running.push(this.executeRunningTask(runningTask, agent));
    }
    await Promise.all(running);
  }

  private async prepareQueuedTask(task: Task): Promise<Task | null> {
    if (task.status === "pending") {
      if (!hasValidExecutionFields(task)) {
        await this.taskService.markFailedInternal(
          task.id,
          "Task execution fields are invalid",
          {
            missingFields: this.getMissingExecutionFields(task)
          }
        );
        return null;
      }
      return this.taskService.enqueue(task.id);
    }

    return task;
  }

  private async executeRunningTask(
    task: Task,
    agent: NonNullable<Awaited<ReturnType<AgentService["findIdleAgent"]>>>
  ): Promise<void> {
    const result = await this.codexRunner.run(task, agent);
    const metadata = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };

    if (result.exitCode === 0) {
      await this.taskService.markDoneInternal(task.id, metadata);
      await this.resultReporter.reportSuccess(task, result);
    } else {
      await this.taskService.markFailedInternal(task.id, "Codex command failed", metadata);
      await this.resultReporter.reportFailure(task, result);
    }

    await this.agentService.markIdle(agent.id);
  }

  private compareRunnableTasks(left: Task, right: Task): number {
    const priorityDiff = PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return left.createdAt.getTime() - right.createdAt.getTime();
  }

  private getMissingExecutionFields(task: Task): string[] {
    return [
      task.repo?.trim() ? null : "repo",
      task.branch?.trim() ? null : "branch",
      task.instruction?.trim() ? null : "instruction"
    ].filter((field): field is string => Boolean(field));
  }
}
