import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { AgentService } from "../agents/agent.service";
import { ExecutionLogService } from "../execution-logs/execution-log.service";
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
  private polling = false;

  constructor(
    private readonly taskService: TaskService,
    private readonly agentService: AgentService,
    private readonly executionLogService: ExecutionLogService,
    private readonly codexRunner: CodexRunner,
    private readonly resultReporter: ResultReporterService
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }

    this.polling = true;
    try {
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
        try {
          const runningTask = await this.taskService.claim(queuedTask.id, agent.id);
          running.push(this.executeRunningTask(runningTask, agent));
        } catch {
          await this.agentService.markIdle(agent.id);
        }
      }
      await Promise.all(running);
    } finally {
      this.polling = false;
    }
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
    const executionContext = this.codexRunner.getExecutionContext(task);
    await this.executionLogService.append({
      taskId: task.id,
      agentId: agent.id,
      status: "running",
      message: "Preparing project workspace for branch checkout and Codex execution",
      metadata: this.buildExecutionMetadata(executionContext)
    });
    await this.agentService.refreshHeartbeat(agent.id);
    const result = await this.codexRunner.run(task, agent);
    await this.agentService.refreshHeartbeat(agent.id);
    const metadata = this.buildExecutionMetadata(result);

    try {
      if (result.exitCode === 0) {
        await this.executionLogService.append({
          taskId: task.id,
          agentId: agent.id,
          status: "running",
          message: "Codex exited normally",
          metadata
        });
        await this.taskService.markDoneInternal(task.id, metadata);
        await this.ignoreReporterFailure(this.resultReporter.reportSuccess(task, result));
      } else {
        await this.taskService.markFailedInternal(task.id, this.getFailureMessage(result), metadata);
        await this.ignoreReporterFailure(this.resultReporter.reportFailure(task, result));
      }
    } finally {
      await this.agentService.markIdle(agent.id);
    }
  }

  private async ignoreReporterFailure(operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } catch {
      // Comment-back failures should not change task terminal state or occupy an Agent.
    }
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
      task.instruction?.trim() ? null : "instruction"
    ].filter((field): field is string => Boolean(field));
  }

  private buildExecutionMetadata(
    execution: ReturnType<CodexRunner["getExecutionContext"]> | Awaited<ReturnType<CodexRunner["run"]>>
  ): Record<string, unknown> {
    return {
      repo: execution.repo,
      branch: execution.branch,
      hostCwd: execution.hostCwd,
      containerCwd: execution.containerCwd,
      ...("cloneUrl" in execution ? { cloneUrl: execution.cloneUrl } : {}),
      ...("stage" in execution
        ? {
            stage: execution.stage,
            exitCode: execution.exitCode,
            stdout: execution.stdout,
            stderr: execution.stderr,
            timedOut: execution.timedOut,
            branchCheckedOut: execution.branchCheckedOut,
            codexStarted: execution.codexStarted,
            normalExit: execution.exitCode === 0 && execution.stage === "codex"
          }
        : {})
    };
  }

  private getFailureMessage(result: Awaited<ReturnType<CodexRunner["run"]>>): string {
    if (result.stage === "clone") {
      return "Repository clone failed";
    }
    if (result.stage === "checkout") {
      return "Branch checkout failed in project directory";
    }
    if (result.timedOut) {
      return "Codex timed out";
    }
    return "Codex exited abnormally";
  }
}
