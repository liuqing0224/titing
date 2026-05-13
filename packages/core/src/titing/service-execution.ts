/**
 * 环境与执行插件编排，以及与质量/修复闭环、治理元数据的交互；**不**负责任务入队（由调度器完成）。
 */
import {
  AgentRecord,
  EnvironmentContext,
  EvalResult,
  ExecutionContext,
  ExecutionRecord,
  ExecutionResult,
  NeedsHumanPayload,
  PreparedWorkspace,
  RepairGoal,
  TitingTask
} from "@titing/plugin-api";
import { ServiceSupport } from "./service-support";
import {
  buildFailureHash,
  buildRepairConstraints,
  buildRepairDoneWhen,
  buildRepairDoneWhenWithoutQuality,
  buildRepairObjective,
  decideStopReason,
  decideStopReasonWithoutQuality,
  describeStopReason,
  EnvironmentFailureShape,
  getExecutionRetryDecision,
  isEnvironmentPreparationError,
  isTerminalTaskStatus,
  isWorkflowPromptsFailure,
  readDiffStats,
  readHumanLoopMetadata,
  readQualityChecks,
  ServiceConfig,
  ServiceDependencies
} from "./service-shared";

/**
 * 单任务执行管线（由 `ServiceScheduler` 在 Agent claim 后调用）：
 *
 * 1. **准备环境**：`EnvironmentPlugin.prepareWorkspace`
 * 2. **循环**：创建 `ExecutionRecord` → 调执行器 `execute` / `continueSession` → 持久化结果与治理扫描
 * 3. **质量**（若启用）：`QualityPlugin.evaluate`，结合 `RepairGoal` 做修复轮次与停止条件（`decideStopReason` 等）
 * 4. **无质量插件时**： success 直接 `done`；失败走简化 repair 预算
 * 5. **异常路径**：可重试执行失败、环境失败、needs_human、workflow-prompts 特判等
 *
 * Agent 维度的「保活心跳」由 `startAgentHeartbeatLoop` 在长时间执行期间维持。
 */
export class ServiceExecution {
  constructor(
    private readonly deps: ServiceDependencies,
    private readonly config: ServiceConfig,
    private readonly support: ServiceSupport
  ) {}

  /**
   * 执行单任务直至进入终态或交出调度（例如内部 `retryTask` 提前 break）。
   * 外层应已在 `running` 且 Agent 已占用。
   */
  async runTask(task: TitingTask, agent: AgentRecord): Promise<void> {
    const environment = this.deps.runtime.selectEnvironmentPlugin();
    const executionPlugin = this.deps.runtime.selectExecutionPlugin(task.executor);
    const qualityPlugin = this.deps.runtime.getPrimaryQualityPlugin();
    const governancePlugins = this.deps.runtime.getGovernancePlugins();
    let currentTask = task;
    let workspace: PreparedWorkspace | null = null;
    let execution: ExecutionRecord | null = null;
    const stopHeartbeat = this.startAgentHeartbeatLoop(agent.id);

    await this.support.publish("scheduler.agent_selected", "Agent selected", currentTask, { agentId: agent.id });

    try {
      const environmentContext: EnvironmentContext = {
        runtimeLogger: async (event) => this.support.recordEnvironmentRuntimeEvent(currentTask, agent.id, event)
      };
      workspace = await environment.prepareWorkspace(currentTask, environmentContext);
      let goal = await this.deps.repairGoals.getByTaskId(currentTask.id);
      let loopCount = goal?.currentIteration ?? 0;
      let previousResult: ExecutionResult | null = null;
      let previousFailureHash: string | null = goal?.lastFailureHash ?? null;
      let repeatedFailureCount = 0;
      let noDiffStreak = 0;

      while (true) {
        execution = await this.createExecution(currentTask, agent.id, workspace);
        const activeExecution = execution;
        await this.support.updateExecutionStatus(execution, currentTask, "executing", "Execution started", {
          agentId: agent.id,
          iteration: loopCount + 1
        });
        const executionContext: ExecutionContext = {
          runtimeLogger: async (event) => (
            this.support.recordExecutionRuntimeEvent(currentTask, activeExecution, agent.id, event)
          )
        };

        const result: ExecutionResult = goal && previousResult?.sessionId && executionPlugin.continueSession
          ? await executionPlugin.continueSession(previousResult.sessionId, currentTask, workspace, goal, executionContext)
          : await executionPlugin.execute(currentTask, workspace, goal, executionContext);
        execution.summary = result.summary;
        execution.endedAt = this.support.now();
        await this.deps.executions.save(execution);
        await this.support.appendExecutionLog(currentTask, execution, "executor.completed", result.summary, {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          sessionId: result.sessionId,
          errorCategory: result.errorCategory,
          timeoutCategory: result.timeoutCategory,
          stdout: result.stdout,
          stderr: result.stderr,
          metadata: result.metadata
        }, this.support.buildCorrelation({ task: currentTask, execution, agentId: agent.id }));
        await this.support.recordGovernanceEntries(currentTask, execution, result.metadata, agent.id);

        const retriedTask = await this.handleRetryableExecutionFailure(currentTask, execution, agent, result);
        if (retriedTask) {
          currentTask = retriedTask;
          break;
        }

        if (isWorkflowPromptsFailure(result)) {
          await this.support.updateExecutionStatus(execution, currentTask, "failed", result.summary, {
            sessionId: result.sessionId,
            errorCategory: result.errorCategory,
            timeoutCategory: result.timeoutCategory
          });
          currentTask = await this.support.transitionTask(currentTask, "failed", result.summary, executionPlugin.id, execution);
          currentTask.completedAt = this.support.now();
          await this.deps.tasks.save(currentTask);
          await this.support.reportTaskResultIfNeeded(currentTask, result.summary);
          break;
        }

        if (!qualityPlugin) {
          const correlation = this.support.buildCorrelation({ task: currentTask, execution, agentId: agent.id });
          await this.support.appendExecutionLog(
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
          await this.support.publish(
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
            await this.support.reportTaskResultIfNeeded(currentTask, result.summary);
            if (goal) {
              await this.deps.repairGoals.upsert({
                ...goal,
                status: "achieved",
                updatedAt: this.support.now()
              });
            }
            await this.support.updateExecutionStatus(
              execution,
              currentTask,
              "completed",
              "Execution completed without quality evaluation",
              {
                sessionId: result.sessionId,
                qualityEnabled: false
              }
            );
            currentTask = await this.support.transitionTask(
              currentTask,
              "done",
              "Execution completed without quality evaluation",
              executionPlugin.id,
              execution
            );
            currentTask.completedAt = this.support.now();
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
            maxIterations: goal?.maxIterations ?? this.config.maxRepairIterations
          });
          const nextGoalStatus: RepairGoal["status"] = stopReason === "budget_limited" ? "budget_limited" : "repairing";
          const nextGoal: RepairGoal = {
            id: goal?.id ?? this.support.createId(),
            taskId: currentTask.id,
            objective: buildRepairObjective(currentTask, result, []),
            constraints: [...currentTask.constraints],
            doneWhen: buildRepairDoneWhenWithoutQuality(currentTask),
            status: nextGoalStatus,
            currentIteration: loopCount,
            maxIterations: goal?.maxIterations ?? this.config.maxRepairIterations,
            lastFailureHash: failureHash,
            createdAt: goal?.createdAt ?? this.support.now(),
            updatedAt: this.support.now()
          };
          goal = nextGoal;
          await this.deps.repairGoals.upsert(goal);

          if (stopReason === "budget_limited") {
            const summary = describeStopReason(stopReason);
            await this.support.appendExecutionLog(
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
              this.support.buildCorrelation({ task: currentTask, execution, agentId: agent.id })
            );
            await this.support.updateExecutionStatus(execution, currentTask, "failed", summary, {
              iteration: loopCount,
              maxIterations: nextGoal.maxIterations,
              stopReason,
              qualityEnabled: false
            });
            currentTask = await this.support.transitionTask(currentTask, "failed", summary, executionPlugin.id, execution);
            currentTask.completedAt = this.support.now();
            await this.deps.tasks.save(currentTask);
            await this.support.reportTaskResultIfNeeded(currentTask, summary);
            break;
          }

          if (stopReason) {
            await this.support.appendExecutionLog(
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
              this.support.buildCorrelation({ task: currentTask, execution, agentId: agent.id })
            );
          }

          await this.support.updateExecutionStatus(
            execution,
            currentTask,
            "repairing",
            "Execution requires repair without quality evaluation",
            {
              sessionId: result.sessionId,
              errorCategory: result.errorCategory,
              qualityEnabled: false
            }
          );
          if (currentTask.status !== "repairing") {
            currentTask = await this.support.transitionTask(currentTask, "repairing", "Execution failed", executionPlugin.id, execution);
          }
          currentTask.repairCount = loopCount;
          await this.deps.tasks.save(currentTask);
          await this.support.publish("goal.iteration_started", "Repair iteration started", currentTask, {
            iteration: loopCount,
            objective: nextGoal.objective,
            sessionId: result.sessionId
          });
          previousResult = result;
          continue;
        }

        await this.support.updateExecutionStatus(execution, currentTask, "evaluating", "Execution output ready for evaluation", {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          sessionId: result.sessionId
        });
        currentTask = await this.support.transitionTask(
          currentTask,
          "evaluating",
          "Execution finished",
          executionPlugin.id,
          execution
        );

        const quality = await qualityPlugin.evaluate({ task: currentTask, workspace, execution: result });
        const evalResult: EvalResult = {
          id: this.support.createId(),
          taskId: currentTask.id,
          executionId: execution.id,
          passed: quality.passed,
          score: quality.score,
          riskLevel: quality.riskLevel,
          report: {
            checks: quality.checks,
            ...quality.report
          },
          createdAt: this.support.now()
        };
        for (const governance of governancePlugins) {
          await governance.afterEval?.(evalResult);
        }
        await this.deps.evalResults.create(evalResult);
        await this.support.recordGovernanceEntries(currentTask, execution, evalResult.report, agent.id);
        await this.support.publish("eval.completed", "Evaluation completed", currentTask, {
          passed: evalResult.passed,
          score: evalResult.score,
          riskLevel: evalResult.riskLevel
        });

        const evalChecks = readQualityChecks(evalResult.report);
        if (evalResult.passed) {
          await this.support.reportTaskResultIfNeeded(currentTask, result.summary);
          if (goal) {
            await this.deps.repairGoals.upsert({
              ...goal,
              status: "achieved",
              updatedAt: this.support.now()
            });
          }
          await this.support.updateExecutionStatus(execution, currentTask, "completed", "Execution passed quality checks", {
            score: evalResult.score,
            riskLevel: evalResult.riskLevel
          });
          currentTask = await this.support.transitionTask(currentTask, "done", "Evaluation passed", qualityPlugin.id, execution);
          currentTask.completedAt = this.support.now();
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
          maxIterations: goal?.maxIterations ?? this.config.maxRepairIterations
        });
        const nextGoalStatus: RepairGoal["status"] = stopReason === "budget_limited" ? "budget_limited" : "repairing";
        const nextGoal: RepairGoal = {
          id: goal?.id ?? this.support.createId(),
          taskId: currentTask.id,
          objective: buildRepairObjective(currentTask, result, evalChecks),
          constraints: buildRepairConstraints(currentTask, evalResult.riskLevel),
          doneWhen: buildRepairDoneWhen(currentTask, evalChecks),
          status: nextGoalStatus,
          currentIteration: loopCount,
          maxIterations: goal?.maxIterations ?? this.config.maxRepairIterations,
          lastFailureHash: failureHash,
          createdAt: goal?.createdAt ?? this.support.now(),
          updatedAt: this.support.now()
        };
        goal = nextGoal;
        await this.deps.repairGoals.upsert(goal);

        if (stopReason === "budget_limited") {
          const summary = describeStopReason(stopReason);
          await this.support.appendExecutionLog(
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
            this.support.buildCorrelation({ task: currentTask, execution, agentId: agent.id })
          );
          await this.support.updateExecutionStatus(execution, currentTask, "failed", summary, {
            iteration: loopCount,
            maxIterations: nextGoal.maxIterations,
            stopReason
          });
          currentTask = await this.support.transitionTask(currentTask, "failed", summary, qualityPlugin.id, execution);
          currentTask.completedAt = this.support.now();
          await this.deps.tasks.save(currentTask);
          await this.support.reportTaskResultIfNeeded(currentTask, summary);
          break;
        }

        if (stopReason && this.config.enableNeedsHumanLoop) {
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
          await this.support.appendExecutionLog(
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
            this.support.buildCorrelation({ task: currentTask, execution, agentId: agent.id })
          );
        }

        await this.support.updateExecutionStatus(execution, currentTask, "repairing", "Execution requires repair", {
          score: evalResult.score,
          riskLevel: evalResult.riskLevel,
          sessionId: result.sessionId
        });
        currentTask = await this.support.transitionTask(currentTask, "repairing", "Evaluation failed", qualityPlugin.id, execution);
        currentTask.repairCount = loopCount;
        await this.deps.tasks.save(currentTask);
        await this.support.publish("goal.iteration_started", "Repair iteration started", currentTask, {
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
        execution.endedAt = this.support.now();
        await this.support.updateExecutionStatus(execution, currentTask, "failed", message, {});
      }
      const failedTask = await this.support.transitionTask(currentTask, "failed", message, "scheduler", execution);
      failedTask.completedAt = this.support.now();
      await this.deps.tasks.save(failedTask);
      await this.support.appendExecutionLog(
        failedTask,
        execution,
        "executor.failed",
        message,
        {},
        this.support.buildCorrelation({ task: failedTask, execution, agentId: agent.id })
      );
      await this.support.reportTaskResultIfNeeded(failedTask, message);
    } finally {
      stopHeartbeat();
      if (workspace && isTerminalTaskStatus(currentTask.status)) {
        await environment.cleanupWorkspace(currentTask, workspace);
      }
      await this.support.releaseAgent(agent);
    }
  }

  private startAgentHeartbeatLoop(agentId: string): () => void {
    let active = true;
    let heartbeatInFlight = false;
    const timer = this.config.setIntervalFn(() => {
      if (!active || heartbeatInFlight) {
        return;
      }
      heartbeatInFlight = true;
      void this.heartbeatAgent(agentId, "busy")
        .catch(() => undefined)
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, this.config.executionHeartbeatIntervalMs);

    return () => {
      active = false;
      this.config.clearIntervalFn(timer);
    };
  }

  private async heartbeatAgent(id: string, status?: AgentRecord["status"]): Promise<AgentRecord> {
    const agent = await this.support.requireAgent(id);
    if (status && !["idle", "busy"].includes(status)) {
      throw new Error(`Heartbeat cannot set agent ${id} to ${status}`);
    }
    if (agent.status === "disabled" || agent.status === "error") {
      throw new Error(`Agent ${id} cannot heartbeat while ${agent.status}`);
    }
    agent.status = status ?? (agent.status === "offline" ? "idle" : agent.status);
    agent.lastHeartbeatAt = this.support.now();
    agent.updatedAt = this.support.now();
    await this.deps.agents.upsert(agent);
    await this.support.publishAgentEvent("agent.heartbeat", "Agent heartbeat refreshed", agent);
    return agent;
  }

  private async createExecution(task: TitingTask, agentId: string, workspace: PreparedWorkspace): Promise<ExecutionRecord> {
    const execution: ExecutionRecord = {
      id: this.support.createId(),
      taskId: task.id,
      agentId,
      workspace: workspace.workspacePath,
      status: "preparing",
      summary: null,
      executor: task.executor,
      startedAt: this.support.now(),
      endedAt: null
    };
    await this.deps.executions.create(execution);
    await this.support.appendExecutionLog(task, execution, "execution.preparing", "Workspace prepared for execution", {
      workspacePath: workspace.workspacePath,
      repoPath: workspace.repoPath,
      branch: workspace.branch,
      artifactsPath: workspace.artifactsPath
    }, this.support.buildCorrelation({ task, execution, agentId }));
    return execution;
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

    const requestedAt = this.support.now();
    const requestId = this.support.createId();
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
    await this.support.appendExecutionLog(
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
      this.support.buildCorrelation({ task, execution, pluginId: integration.id, agentId })
    );
    await integration.reportNeedsHuman(task, payload);
    await this.support.updateExecutionStatus(execution, task, "failed", `Human input required: ${summary}`, {
      stopReason,
      requestId,
      riskLevel: evalResult.riskLevel
    });
    const needsHumanTask = await this.support.transitionTask(task, "needs_human", summary, operator, execution);
    needsHumanTask.completedAt = requestedAt;
    await this.deps.tasks.save(needsHumanTask);
    return { task: needsHumanTask, goal: nextGoal };
  }

  private async handleEnvironmentFailure(
    task: TitingTask,
    agent: AgentRecord,
    error: EnvironmentFailureShape
  ): Promise<TitingTask> {
    const reason = `[environment:${error.stage}] ${error.message}`;
    const attempt = task.retryCount + 1;
    task.retryCount = attempt;
    task.updatedAt = this.support.now();
    await this.deps.tasks.save(task);
    await this.support.appendExecutionLog(task, null, "environment.failed", reason, {
      agentId: agent.id,
      stage: error.stage,
      retryable: error.retryable,
      detail: error.detail,
      attempt,
      retryLimit: this.config.environmentRetryLimit
    }, this.support.buildCorrelation({ task, agentId: agent.id }));

    if (error.retryable && attempt <= this.config.environmentRetryLimit) {
      const requeuedTask = await this.support.transitionTask(
        task,
        "queued",
        `${reason}; retry scheduled (${attempt}/${this.config.environmentRetryLimit})`,
        "scheduler"
      );
      await this.support.publish("environment.retry_scheduled", "Environment failure scheduled for retry", requeuedTask, {
        agentId: agent.id,
        stage: error.stage,
        detail: error.detail,
        attempt,
        retryLimit: this.config.environmentRetryLimit
      }, { agentId: agent.id });
      return requeuedTask;
    }

    const blockedTask = await this.support.transitionTask(
      task,
      "blocked",
      error.retryable
        ? `${reason}; retry budget exhausted`
        : `${reason}; manual intervention required`,
      "scheduler"
    );
    blockedTask.completedAt = this.support.now();
    await this.deps.tasks.save(blockedTask);
    await this.support.publish("environment.blocked", "Environment failure blocked task", blockedTask, {
      agentId: agent.id,
      stage: error.stage,
      detail: error.detail,
      retryable: error.retryable,
      attempt,
      retryLimit: this.config.environmentRetryLimit
    }, { agentId: agent.id });
    await this.support.reportTaskResultIfNeeded(blockedTask, blockedTask.status === "blocked" ? reason : blockedTask.status);
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
    task.updatedAt = this.support.now();
    await this.deps.tasks.save(task);

    const reason = `[execution:${retryDecision.reason}] ${result.summary}`;
    await this.support.updateExecutionStatus(execution, task, "failed", reason, {
      agentId: agent.id,
      attempt,
      retryLimit: this.config.executionRetryLimit,
      errorCategory: result.errorCategory,
      timeoutCategory: result.timeoutCategory
    });

    if (attempt <= this.config.executionRetryLimit) {
      const requeuedTask = await this.support.transitionTask(
        task,
        "queued",
        `${reason}; retry scheduled (${attempt}/${this.config.executionRetryLimit})`,
        "scheduler",
        execution
      );
      await this.support.publish("execution.retry_scheduled", "Execution failure scheduled for retry", requeuedTask, {
        agentId: agent.id,
        attempt,
        retryLimit: this.config.executionRetryLimit,
        errorCategory: result.errorCategory,
        timeoutCategory: result.timeoutCategory
      }, { execution, agentId: agent.id });
      return requeuedTask;
    }

    const blockedTask = await this.support.transitionTask(
      task,
      "blocked",
      `${reason}; retry budget exhausted`,
      "scheduler",
      execution
    );
    blockedTask.completedAt = this.support.now();
    await this.deps.tasks.save(blockedTask);
    await this.support.publish("execution.blocked", "Execution failure blocked task", blockedTask, {
      agentId: agent.id,
      attempt,
      retryLimit: this.config.executionRetryLimit,
      errorCategory: result.errorCategory,
      timeoutCategory: result.timeoutCategory
    }, { execution, agentId: agent.id });
    await this.support.reportTaskResultIfNeeded(blockedTask, result.summary);
    return blockedTask;
  }
}
