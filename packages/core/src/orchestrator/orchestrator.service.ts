import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { AgentService } from "../agents/agent.service";
import { ExecutionLogService } from "../execution-logs/execution-log.service";
import { ExecutionEnginePlugin, ExecutionRunResult } from "../plugins/execution-engine.plugin";
import { EXECUTION_ENGINE_PLUGIN } from "../plugins/plugin.tokens";
import { Task } from "../tasks/task.entity";
import { TaskService } from "../tasks/task.service";
import { hasValidExecutionFields } from "../tasks/task-status";
import { ResultReporterService } from "./result-reporter.service";

const PRIORITY_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1
};

@Injectable()
export class OrchestratorService implements OnApplicationBootstrap {
  private polling = false;
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly agentService: AgentService,
    private readonly executionLogService: ExecutionLogService,
    @Inject(EXECUTION_ENGINE_PLUGIN)
    private readonly executionEngine: ExecutionEnginePlugin,
    private readonly resultReporter: ResultReporterService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.poll();
  }

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
    this.logger.log(`Task ${task.id} claimed by ${agent.id}, starting orchestration`);
    const executionContext = this.executionEngine.getExecutionContext(task);
    await this.executionLogService.append({
      taskId: task.id,
      agentId: agent.id,
      status: "running",
      message: "Preparing project workspace, validating WORKFLOW_PROMPTS.md, and executing Codex",
      metadata: this.buildExecutionMetadata(executionContext)
    });
    await this.agentService.refreshHeartbeat(agent.id);
    const stopHeartbeatLoop = this.startHeartbeatLoop(agent.id);

    let result: ExecutionRunResult;
    try {
      result = await this.executionEngine.runTask(task, agent);
    } finally {
      stopHeartbeatLoop();
    }

    await this.agentService.refreshHeartbeat(agent.id);
    const metadata = this.buildExecutionMetadata(result);
    this.logger.log(
      `Task ${task.id} runner returned exitCode=${result.exitCode}, stage=${result.stage}, timedOut=${result.timedOut}`
    );

    try {
      if (result.exitCode === 0) {
        this.logger.log(`Task ${task.id} marking done`);
        await this.executionLogService.append({
          taskId: task.id,
          agentId: agent.id,
          status: "running",
          message: "WORKFLOW_PROMPTS.md workflow executed and Codex exited normally",
          metadata
        });
        await this.taskService.markDoneInternal(task.id, metadata);
        await this.ignoreReporterFailure(this.resultReporter.reportSuccess(task, result));
      } else {
        this.logger.warn(`Task ${task.id} marking failed: ${this.getFailureMessage(result)}`);
        await this.taskService.markFailedInternal(task.id, this.getFailureMessage(result), metadata);
        await this.ignoreReporterFailure(this.resultReporter.reportFailure(task, result));
      }
    } finally {
      this.logger.log(`Task ${task.id} releasing agent ${agent.id}`);
      await this.agentService.markIdle(agent.id);
    }
  }

  private startHeartbeatLoop(agentId: string): () => void {
    const intervalMs = Number(process.env.AGENT_HEARTBEAT_REFRESH_INTERVAL_MS ?? 15000);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return () => undefined;
    }

    const timer = setInterval(() => {
      void this.agentService.refreshHeartbeat(agentId).catch((error: unknown) => {
        this.logger.warn(
          `Failed to refresh heartbeat for ${agentId}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, intervalMs);
    timer.unref?.();

    return () => clearInterval(timer);
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
    execution: ReturnType<ExecutionEnginePlugin["getExecutionContext"]> | ExecutionRunResult
  ): Record<string, unknown> {
    return {
      repo: execution.repo,
      branch: execution.branch,
      repoRoot: execution.repoRoot,
      worktreePath: execution.worktreePath,
      agentsMdPath: execution.agentsMdPath,
      workflowPromptsPath: execution.workflowPromptsPath,
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
            agentsMdPath: execution.agentsMdPath,
            workflowPromptsPath: execution.workflowPromptsPath,
            normalExit: execution.exitCode === 0 && execution.stage === "execute"
          }
        : {})
    };
  }

  private getFailureMessage(result: ExecutionRunResult): string {
    if (result.stage === "clone") {
      return "Repository clone failed";
    }
    if (result.stage === "checkout") {
      return "Branch checkout failed in project directory";
    }
    if (result.stage === "workflow-prompts") {
      return "Project WORKFLOW_PROMPTS.md is missing or invalid";
    }
    if (result.timedOut) {
      return "Codex timed out";
    }
    return "Codex exited abnormally while following WORKFLOW_PROMPTS.md workflow";
  }
}
