import {
  AgentRecord,
  AgentRepository,
  EvalResult,
  EvalResultRepository,
  EventSink,
  ExecutionLogRecord,
  ExecutionLogRepository,
  ExecutionPlugin,
  ExecutionRecord,
  ExecutionRepository,
  ExecutionResult,
  HumanReply,
  NeedsHumanPayload,
  ObservabilityGovernancePlugin,
  PluginConfigRepository,
  PreparedWorkspace,
  QualityPlugin,
  RepairGoal,
  RepairGoalRepository,
  RuntimePlugin,
  TaskRepository,
  TaskStatus,
  TaskTransition,
  TaskTransitionRepository,
  TitingTask
} from "@titing/plugin-api";
import { PluginRuntime } from "./plugin-runtime";
import { TitingServices } from "./services";

describe("TitingServices", () => {
  it("runs execute before evaluating and records task transitions into execution logs", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-1", status: "queued" })],
      executions: [createExecutionResult({ sessionId: "codex:s1" })]
    });

    await harness.services.runSchedulerTick();

    expect(harness.executionPlugin.calls).toEqual(["execute"]);
    expect(harness.qualityPlugin.calls).toEqual(["evaluate"]);
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual(["queued->running", "running->evaluating", "evaluating->done"]);
    expect(harness.logs.filter((item) => item.eventType === "task.transition").map((item) => item.data.to)).toEqual([
      "running",
      "evaluating",
      "done"
    ]);
  });

  it("fails from the latest task state when execution throws during repair", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-2", status: "queued" })],
      executions: [
        createExecutionResult({ exitCode: 1, stderr: "boom", summary: "failed", sessionId: "codex:s1", errorCategory: "command_failed" }),
        new Error("second attempt crashed")
      ],
      qualityResults: [
        {
          passed: false,
          score: 10,
          riskLevel: "medium",
          checks: [{ name: "exit-code", passed: false, detail: "bad" }],
          report: {}
        }
      ]
    });

    await harness.services.runSchedulerTick();

    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->evaluating",
      "evaluating->repairing",
      "repairing->failed"
    ]);
    expect(harness.tasks.get("task-2")?.status).toBe("failed");
  });

  it("claims queued tasks atomically across concurrent scheduler ticks", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-3", status: "queued" })],
      executions: [createExecutionResult({ sessionId: "codex:s1" })]
    });

    await Promise.all([harness.services.runSchedulerTick(), harness.services.runSchedulerTick()]);

    expect(harness.executionPlugin.calls).toEqual(["execute"]);
    expect(harness.transitions.filter((item) => item.to === "running")).toHaveLength(1);
  });

  it("uses continueSession on repair iterations when the executor supports it", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-4", status: "queued" })],
      executions: [
        createExecutionResult({ exitCode: 1, sessionId: "codex:s1", errorCategory: "command_failed", summary: "first failed" }),
        createExecutionResult({ exitCode: 0, sessionId: "codex:s1", summary: "recovered" })
      ],
      qualityResults: [
        {
          passed: false,
          score: 50,
          riskLevel: "medium",
          checks: [{ name: "build", passed: false, detail: "bad" }],
          report: { diff: { filesChanged: 1, insertions: 3, deletions: 1 } }
        },
        {
          passed: true,
          score: 100,
          riskLevel: "low",
          checks: [{ name: "build", passed: true, detail: "ok" }],
          report: { diff: { filesChanged: 1, insertions: 5, deletions: 0 } }
        }
      ]
    });

    await harness.services.runSchedulerTick();

    expect(harness.executionPlugin.calls).toEqual(["execute", "continue:codex:s1"]);
    expect(harness.tasks.get("task-4")?.status).toBe("done");
  });

  it("fails immediately when workflow prompts are missing or invalid", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-4w", status: "queued" })],
      executions: [
        createExecutionResult({
          exitCode: 1,
          errorCategory: "command_failed",
          summary: "Project WORKFLOW_PROMPTS.md is missing or invalid",
          stderr: "Unable to locate WORKFLOW_PROMPTS.md in /tmp/task/repo",
          metadata: {
            workflowStage: "workflow-prompts",
            workflowError: "Unable to locate WORKFLOW_PROMPTS.md in /tmp/task/repo"
          }
        })
      ]
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-4w")?.status).toBe("failed");
    expect(harness.qualityPlugin.calls).toEqual([]);
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->failed"
    ]);
  });

  it("reuses the prepared workspace across repair iterations and cleans up only after completion", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-4r", status: "queued" })],
      executions: [
        createExecutionResult({ exitCode: 1, sessionId: "codex:s1", errorCategory: "command_failed", summary: "first failed" }),
        createExecutionResult({ exitCode: 0, sessionId: "codex:s1", summary: "recovered" })
      ],
      qualityResults: [
        {
          passed: false,
          score: 50,
          riskLevel: "medium",
          checks: [{ name: "build", passed: false, detail: "bad" }],
          report: { diff: { filesChanged: 1, insertions: 3, deletions: 1 } }
        },
        {
          passed: true,
          score: 100,
          riskLevel: "low",
          checks: [{ name: "build", passed: true, detail: "ok" }],
          report: { diff: { filesChanged: 1, insertions: 5, deletions: 0 } }
        }
      ]
    });

    await harness.services.runSchedulerTick();

    expect(harness.environmentPlugin.calls).toEqual({
      prepareWorkspace: 1,
      cleanupWorkspace: 1
    });
    expect(harness.executionPlugin.calls).toEqual(["execute", "continue:codex:s1"]);
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->evaluating",
      "evaluating->repairing",
      "repairing->evaluating",
      "evaluating->done"
    ]);
  });

  it("completes goal loop on the first successful evaluation without creating a repair goal", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-4a", status: "queued" })],
      executions: [createExecutionResult({ sessionId: "codex:s1", summary: "done" })]
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-4a")?.status).toBe("done");
    expect(harness.executionPlugin.calls).toEqual(["execute"]);
    expect(harness.qualityPlugin.calls).toEqual(["evaluate"]);
    expect(harness.repairGoals.get("task-4a")).toBeUndefined();
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->evaluating",
      "evaluating->done"
    ]);
  });

  it("marks repair goals achieved when a repair iteration succeeds", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-4b", status: "queued" })],
      executions: [
        createExecutionResult({ exitCode: 1, sessionId: "codex:s1", errorCategory: "command_failed", summary: "first failed" }),
        createExecutionResult({ exitCode: 0, sessionId: "codex:s1", summary: "fixed" })
      ],
      qualityResults: [
        {
          passed: false,
          score: 55,
          riskLevel: "medium",
          checks: [{ name: "build", passed: false, detail: "bad" }],
          report: { diff: { filesChanged: 1, insertions: 2, deletions: 1 } }
        },
        {
          passed: true,
          score: 100,
          riskLevel: "low",
          checks: [{ name: "build", passed: true, detail: "ok" }],
          report: { diff: { filesChanged: 1, insertions: 3, deletions: 0 } }
        }
      ]
    });

    await harness.services.runSchedulerTick();

    expect(harness.executionPlugin.calls).toEqual(["execute", "continue:codex:s1"]);
    expect(harness.tasks.get("task-4b")?.status).toBe("done");
    expect(harness.repairGoals.get("task-4b")).toEqual(expect.objectContaining({
      status: "achieved",
      currentIteration: 1,
      maxIterations: 3
    }));
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->evaluating",
      "evaluating->repairing",
      "repairing->evaluating",
      "evaluating->done"
    ]);
  });

  it("marks repair goals budget_limited when max repair iterations are exhausted", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-4c", status: "queued" })],
      executions: [
        createExecutionResult({ exitCode: 1, sessionId: "codex:s1", errorCategory: "command_failed", summary: "fail 1" }),
        createExecutionResult({ exitCode: 1, sessionId: "codex:s1", errorCategory: "command_failed", summary: "fail 2" }),
        createExecutionResult({ exitCode: 1, sessionId: "codex:s1", errorCategory: "command_failed", summary: "fail 3" })
      ],
      qualityResults: [
        {
          passed: false,
          score: 40,
          riskLevel: "medium",
          checks: [{ name: "build", passed: false, detail: "bad 1" }],
          report: { diff: { filesChanged: 1, insertions: 1, deletions: 0 } }
        },
        {
          passed: false,
          score: 35,
          riskLevel: "medium",
          checks: [{ name: "build", passed: false, detail: "bad 2" }],
          report: { diff: { filesChanged: 1, insertions: 1, deletions: 1 } }
        },
        {
          passed: false,
          score: 30,
          riskLevel: "medium",
          checks: [{ name: "build", passed: false, detail: "bad 3" }],
          report: { diff: { filesChanged: 1, insertions: 2, deletions: 1 } }
        }
      ]
    });

    await harness.services.runSchedulerTick();

    expect(harness.executionPlugin.calls).toEqual([
      "execute",
      "continue:codex:s1",
      "continue:codex:s1"
    ]);
    expect(harness.tasks.get("task-4c")?.status).toBe("failed");
    expect(harness.repairGoals.get("task-4c")).toEqual(expect.objectContaining({
      status: "budget_limited",
      currentIteration: 3,
      maxIterations: 3
    }));
    expect(harness.transitions.at(-1)).toEqual(expect.objectContaining({
      from: "evaluating",
      to: "failed"
    }));
    expect(harness.logs.some((item) => item.eventType === "goal.budget_exhausted")).toBe(true);
  });

  it("stops after two consecutive no-diff repair rounds", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-5", status: "queued" })],
      executions: [
        createExecutionResult({ exitCode: 1, sessionId: "codex:s1", errorCategory: "command_failed", summary: "fail 1" }),
        createExecutionResult({ exitCode: 1, sessionId: "codex:s1", errorCategory: "command_failed", summary: "fail 2" }),
        createExecutionResult({ exitCode: 1, sessionId: "codex:s1", errorCategory: "command_failed", summary: "fail 3" })
      ],
      qualityResults: [
        {
          passed: false,
          score: 40,
          riskLevel: "medium",
          checks: [{ name: "build", passed: false, detail: "bad" }],
          report: { diff: { filesChanged: 0, insertions: 0, deletions: 0 } }
        },
        {
          passed: false,
          score: 35,
          riskLevel: "medium",
          checks: [{ name: "build", passed: false, detail: "bad again" }],
          report: { diff: { filesChanged: 0, insertions: 0, deletions: 0 } }
        },
        {
          passed: false,
          score: 30,
          riskLevel: "medium",
          checks: [{ name: "build", passed: false, detail: "bad again" }],
          report: { diff: { filesChanged: 0, insertions: 0, deletions: 0 } }
        }
      ]
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-5")?.status).toBe("failed");
    expect(harness.transitions.at(-1)?.to).toBe("failed");
    expect(harness.repairGoals.get("task-5")?.status).toBe("budget_limited");
    expect(harness.logs.some((item) => item.eventType === "goal.stop_reason_continued")).toBe(true);
  });

  it("stops immediately on high-risk quality result", async () => {
    const risky = {
      passed: false,
      score: 20,
      riskLevel: "high" as const,
      checks: [{ name: "diff-risk", passed: false, detail: "too risky" }],
      report: { diff: { filesChanged: 30, insertions: 500, deletions: 20 } }
    };
    const harness = createHarness({
      tasks: [createTask({ id: "task-6", status: "queued" })],
      executions: [
        createExecutionResult({ exitCode: 0, sessionId: "codex:s1", summary: "done but risky" }),
        createExecutionResult({ exitCode: 0, sessionId: "codex:s1", summary: "still risky" }),
        createExecutionResult({ exitCode: 0, sessionId: "codex:s1", summary: "still risky" })
      ],
      qualityResults: [risky, risky, risky]
    });

    await harness.services.runSchedulerTick();

    expect(harness.executionPlugin.calls).toEqual(["execute", "continue:codex:s1", "continue:codex:s1"]);
    expect(harness.tasks.get("task-6")?.status).toBe("failed");
    expect(harness.logs.filter((item) => item.eventType === "goal.stop_reason_continued").length).toBeGreaterThanOrEqual(2);
    expect(harness.logs.some((item) => item.eventType === "goal.budget_exhausted")).toBe(true);
  });

  it("keeps continuing repair on stop signals when needs_human loop is disabled", async () => {
    const risky = {
      passed: false,
      score: 20,
      riskLevel: "high" as const,
      checks: [{ name: "diff-risk", passed: false, detail: "too risky" }],
      report: { diff: { filesChanged: 30, insertions: 500, deletions: 20 } }
    };
    const harness = createHarness({
      tasks: [createTask({ id: "task-6b", status: "queued" })],
      executions: [
        createExecutionResult({ exitCode: 0, sessionId: "codex:s1", summary: "done but risky" }),
        createExecutionResult({ exitCode: 0, sessionId: "codex:s1", summary: "still risky" }),
        createExecutionResult({ exitCode: 0, sessionId: "codex:s1", summary: "still risky" })
      ],
      qualityResults: [risky, risky, risky],
      enableNeedsHumanLoop: false
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-6b")?.status).toBe("failed");
    expect(harness.reportedNeedsHuman).toEqual([]);
    expect(harness.logs.some((item) => item.eventType === "goal.stop_reason_continued")).toBe(true);
  });

  it("escalates stop signals to needs_human and reports through integration when enabled", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-human-1", status: "queued" })],
      executions: [createExecutionResult({ exitCode: 0, sessionId: "codex:s1", summary: "too risky" })],
      qualityResults: [{
        passed: false,
        score: 20,
        riskLevel: "high",
        checks: [{ name: "diff-risk", passed: false, detail: "too risky" }],
        report: { diff: { filesChanged: 30, insertions: 500, deletions: 20 } }
      }],
      enableNeedsHumanLoop: true
    });
    const task = harness.tasks.get("task-human-1");
    if (!task) {
      throw new Error("task-human-1 missing");
    }
    task.source = "meegle";
    task.externalId = "MEEGLE-HUMAN-1";
    harness.tasks.set(task.id, cloneExistingTask(task));

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-human-1")?.status).toBe("needs_human");
    expect(harness.reportedNeedsHuman).toEqual([
      expect.objectContaining({
        taskId: "task-human-1",
        externalId: "MEEGLE-HUMAN-1",
        payload: expect.objectContaining({
          stopReason: "high_risk"
        })
      })
    ]);
    expect(harness.repairGoals.get("task-human-1")?.status).toBe("needs_human");
    expect(harness.logs.some((item) => item.eventType === "goal.needs_human_requested")).toBe(true);
  });

  it("marks stale busy agents offline and re-queues their running tasks", async () => {
    const task = createTask({ id: "task-7", status: "running" });
    const harness = createHarness({
      tasks: [task],
      executions: [],
      agent: createAgent({
        status: "busy",
        taskId: task.id,
        lastHeartbeatAt: new Date("2026-05-10T23:00:00.000Z")
      }),
      agentOfflineTimeoutMs: 60_000
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-7")?.status).toBe("queued");
    expect(harness.agent.status).toBe("offline");
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual(["running->queued"]);
  });

  it("refreshes busy agent heartbeat during long-running execution", async () => {
    let resolveExecution: ((result: ExecutionResult) => void) | undefined;
    const harness = createHarness({
      tasks: [createTask({ id: "task-heartbeat", status: "queued" })],
      executions: [
        new Promise<ExecutionResult>((resolve) => {
          resolveExecution = resolve;
        })
      ],
      executionHeartbeatIntervalMs: 1_000
    });

    const firstRun = harness.services.runSchedulerTick();
    await new Promise((resolve) => setImmediate(resolve));
    harness.tickHeartbeat();
    harness.tickHeartbeat();
    const busyAgent = harness.agents.get("agent-1");

    expect(busyAgent?.status).toBe("busy");
    expect(busyAgent?.lastHeartbeatAt.toISOString()).toBe("2026-05-11T00:00:00.000Z");

    const advanced = new Date("2026-05-11T00:04:00.000Z");
    harness.setNow(advanced);
    harness.tickHeartbeat();
    await new Promise((resolve) => setImmediate(resolve));

    expect(busyAgent?.lastHeartbeatAt.toISOString()).toBe("2026-05-11T00:04:00.000Z");

    const recoveryTick = harness.services.runSchedulerTick();
    resolveExecution?.(createExecutionResult({ sessionId: "codex:long-run" }));
    await Promise.all([firstRun, recoveryTick]);

    expect(harness.tasks.get("task-heartbeat")?.status).toBe("done");
    expect(harness.transitions.some((item) => item.from === "running" && item.to === "queued")).toBe(false);
  });

  it("applies governance eval hooks before deciding task completion", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-7a", status: "queued" })],
      executions: [
        createExecutionResult({ sessionId: "codex:s1" }),
        createExecutionResult({ sessionId: "codex:s1" }),
        createExecutionResult({ sessionId: "codex:s1" })
      ],
      governancePlugin: {
        id: "gov",
        kind: "observability-governance",
        priority: 100,
        capabilities: ["default"],
        health: async () => ({ healthy: true, message: "ok" }),
        afterEval: async (result) => {
          result.passed = false;
          result.riskLevel = "high";
          result.report = {
            ...result.report,
            governance: [{
              pluginId: "gov",
              phase: "after_eval",
              outcome: "blocked",
              message: "Governance escalated diff risk",
              findings: ["diff exceeded policy"],
              metadata: {
                filesChanged: 99
              }
            }]
          };
        }
      }
    });

    await harness.services.runSchedulerTick();

    expect(harness.executionPlugin.calls).toEqual(["execute", "continue:codex:s1", "continue:codex:s1"]);
    expect(harness.tasks.get("task-7a")?.status).toBe("failed");
    expect(harness.evalResults[0]).toEqual(expect.objectContaining({
      passed: false,
      riskLevel: "high"
    }));
    expect(harness.logs.some((log) => log.eventType === "governance.eval")).toBe(true);
    expect(harness.logs.some((log) => log.eventType === "goal.budget_exhausted")).toBe(true);
  });

  it("refreshes agent heartbeat and revives offline agents to idle", async () => {
    const harness = createHarness({
      tasks: [],
      executions: [],
      agent: createAgent({ status: "offline", lastHeartbeatAt: new Date("2026-05-10T23:00:00.000Z") })
    });

    const agent = await harness.services.heartbeatAgent("agent-1");

    expect(agent.status).toBe("idle");
    expect(harness.agent.status).toBe("idle");
  });

  it("supports disable, enable, and recover agent controls", async () => {
    const disabledHarness = createHarness({
      tasks: [],
      executions: [],
      agent: createAgent()
    });
    await disabledHarness.services.disableAgent("agent-1");
    expect(disabledHarness.agent.status).toBe("disabled");
    await disabledHarness.services.enableAgent("agent-1");
    expect(disabledHarness.agent.status).toBe("idle");

    const recoveryHarness = createHarness({
      tasks: [],
      executions: [],
      agent: createAgent({ status: "error" })
    });
    await recoveryHarness.services.recoverAgent("agent-1");
    expect(recoveryHarness.agent.status).toBe("idle");
  });

  it("retries failed tasks back to queued and clears execution timestamps", async () => {
    const failedTask = createTask({ id: "task-7b", status: "failed" });
    failedTask.startedAt = new Date("2026-05-11T00:10:00.000Z");
    failedTask.completedAt = new Date("2026-05-11T00:20:00.000Z");
    const harness = createHarness({
      tasks: [failedTask],
      executions: []
    });

    const retried = await harness.services.retryTask("task-7b", "api");

    expect(retried.status).toBe("queued");
    expect(retried.retryCount).toBe(1);
    expect(retried.startedAt).toBeNull();
    expect(retried.completedAt).toBeNull();
    expect(harness.tasks.get("task-7b")).toEqual(expect.objectContaining({
      status: "queued",
      retryCount: 1,
      startedAt: null,
      completedAt: null
    }));
  });

  it("skips overlapping scheduler ticks while one is already in flight", async () => {
    let releaseExecution: (() => void) | undefined;
    const harness = createHarness({
      tasks: [createTask({ id: "task-8", status: "queued" })],
      executions: [
        new Promise<ExecutionResult>((resolve) => {
          releaseExecution = () => resolve(createExecutionResult({ sessionId: "codex:s1" }));
        })
      ]
    });

    const first = harness.services.runSchedulerTick();
    const second = harness.services.runSchedulerTick();
    if (releaseExecution) {
      releaseExecution();
    }
    await Promise.all([first, second]);

    expect(harness.executionPlugin.calls).toEqual(["execute"]);
  });

  it("re-queues retryable environment failures until retry budget is exhausted", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-9", status: "queued" })],
      executions: [],
      environmentError: createEnvironmentError({ stage: "fetch", retryable: true }),
      environmentRetryLimit: 2
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-9")?.status).toBe("queued");
    expect(harness.tasks.get("task-9")?.retryCount).toBe(1);
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->queued"
    ]);
  });

  it("blocks non-retryable environment failures", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-10", status: "queued" })],
      executions: [],
      environmentError: createEnvironmentError({ stage: "checkout", retryable: false, detail: "branch missing" })
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-10")?.status).toBe("blocked");
    expect(harness.tasks.get("task-10")?.retryCount).toBe(1);
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->blocked"
    ]);
  });

  it("re-queues retryable execution timeouts until execution retry budget is exhausted", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-10a", status: "queued" })],
      executions: [
        createExecutionResult({
          exitCode: 124,
          timedOut: true,
          errorCategory: "timeout",
          timeoutCategory: "execution_timeout",
          summary: "execution timed out"
        })
      ],
      executionRetryLimit: 2
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-10a")?.status).toBe("queued");
    expect(harness.tasks.get("task-10a")?.retryCount).toBe(1);
    expect(harness.qualityPlugin.calls).toEqual([]);
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->queued"
    ]);
    expect(harness.events.map((item) => item.eventType)).toContain("execution.retry_scheduled");
  });

  it("blocks retryable execution failures after execution retry budget is exhausted", async () => {
    const timedOutTask = createTask({ id: "task-10b", status: "queued" });
    timedOutTask.retryCount = 2;
    const harness = createHarness({
      tasks: [timedOutTask],
      executions: [
        createExecutionResult({
          exitCode: 124,
          timedOut: true,
          errorCategory: "timeout",
          timeoutCategory: "execution_timeout",
          summary: "execution timed out again"
        })
      ],
      executionRetryLimit: 2
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-10b")?.status).toBe("blocked");
    expect(harness.tasks.get("task-10b")?.retryCount).toBe(3);
    expect(harness.qualityPlugin.calls).toEqual([]);
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->blocked"
    ]);
    expect(harness.events.map((item) => item.eventType)).toContain("execution.blocked");
  });

  it("completes tasks without evaluating when no quality plugin is enabled and execution succeeds", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-10c", status: "queued" })],
      executions: [createExecutionResult({ summary: "done without quality" })],
      qualityEnabled: false
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-10c")?.status).toBe("done");
    expect(harness.qualityPlugin.calls).toEqual([]);
    expect(harness.evalResults).toEqual([]);
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->done"
    ]);
    expect(harness.logs.some((item) => item.eventType === "execution.quality_skipped")).toBe(true);
  });

  it("repairs without evaluating when no quality plugin is enabled", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-10d", status: "queued" })],
      executions: [
        createExecutionResult({
          exitCode: 1,
          errorCategory: "command_failed",
          summary: "build failed",
          sessionId: "codex:s1"
        }),
        createExecutionResult({
          exitCode: 0,
          errorCategory: "none",
          summary: "recovered",
          sessionId: "codex:s1"
        })
      ],
      qualityEnabled: false
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-10d")?.status).toBe("done");
    expect(harness.evalResults).toEqual([]);
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->repairing",
      "repairing->done"
    ]);
    expect(harness.repairGoals.get("task-10d")).toEqual(expect.objectContaining({
      status: "achieved",
      doneWhen: ["Successful execution"]
    }));
  });

  it("continues after repeated failures and can still complete without quality evaluation", async () => {
    const harness = createHarness({
      tasks: [createTask({ id: "task-10e", status: "queued" })],
      executions: [
        createExecutionResult({
          exitCode: 1,
          errorCategory: "command_failed",
          summary: "same failure",
          sessionId: "codex:s1"
        }),
        createExecutionResult({
          exitCode: 1,
          errorCategory: "command_failed",
          summary: "same failure",
          sessionId: "codex:s1"
        }),
        createExecutionResult({
          exitCode: 0,
          errorCategory: "none",
          summary: "recovered without quality",
          sessionId: "codex:s1"
        })
      ],
      qualityEnabled: false
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-10e")?.status).toBe("done");
    expect(harness.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->repairing",
      "repairing->done"
    ]);
    expect(harness.logs.some((item) => item.eventType === "goal.stop_reason_continued")).toBe(true);
  });

  it("pulls tasks from integrations and queues valid new tasks", async () => {
    const pulledTask = createTask({ id: "remote-1", status: "created" });
    pulledTask.source = "meegle";
    pulledTask.externalId = "MEEGLE-1";
    const harness = createHarness({
      tasks: [],
      executions: [],
      pulledTasks: [pulledTask]
    });

    await harness.services.syncTaskIntegrations();

    const created = [...harness.tasks.values()][0];
    expect(created?.source).toBe("meegle");
    expect(created?.externalId).toBe("MEEGLE-1");
    expect(created?.status).toBe("queued");
  });

  it("upserts existing pulled tasks by source and externalId", async () => {
    const existing = createTask({ id: "task-11", status: "created" });
    existing.source = "meegle";
    existing.externalId = "MEEGLE-2";
    existing.title = "old";
    const pulledTask = createTask({ id: "remote-2", status: "created" });
    pulledTask.source = "meegle";
    pulledTask.externalId = "MEEGLE-2";
    pulledTask.title = "new";
    const harness = createHarness({
      tasks: [existing],
      executions: [],
      pulledTasks: [pulledTask]
    });

    await harness.services.syncTaskIntegrations();

    expect(harness.tasks.size).toBe(1);
    expect(harness.tasks.get("task-11")?.title).toBe("new");
  });

  it("reports completion back through the originating integration", async () => {
    const pulledTask = createTask({ id: "remote-3", status: "queued" });
    pulledTask.source = "meegle";
    pulledTask.externalId = "MEEGLE-3";
    const harness = createHarness({
      tasks: [pulledTask],
      executions: [createExecutionResult({ sessionId: "codex:s1" })]
    });

    await harness.services.runSchedulerTick();

    expect(harness.reportedResults).toEqual([
      expect.objectContaining({
        taskId: pulledTask.id,
        externalId: "MEEGLE-3",
        summary: "done"
      })
    ]);
  });

  it("supports manual block, needs_human, and recover flows with transition audit", async () => {
    const blockedTask = createTask({ id: "task-12", status: "queued" });
    const blockedHarness = createHarness({
      tasks: [blockedTask],
      executions: []
    });
    const blocked = await blockedHarness.services.blockTask("task-12", "Waiting on product decision", "api");
    expect(blocked.status).toBe("blocked");
    expect(blockedHarness.transitions.at(-1)).toEqual(expect.objectContaining({
      from: "queued",
      to: "blocked",
      reason: "Waiting on product decision",
      operator: "api"
    }));
    const recovered = await blockedHarness.services.recoverTask("task-12", "api", "Decision resolved");
    expect(recovered.status).toBe("queued");
    expect(blockedHarness.transitions.at(-1)).toEqual(expect.objectContaining({
      from: "blocked",
      to: "queued",
      reason: "Decision resolved",
      operator: "api"
    }));

    const humanTask = createTask({ id: "task-13", status: "repairing" });
    const humanHarness = createHarness({
      tasks: [humanTask],
      executions: []
    });
    const needsHuman = await humanHarness.services.markNeedsHuman("task-13", "Manual approval required", "api");
    expect(needsHuman.status).toBe("needs_human");
    expect(needsHuman.completedAt).toBeInstanceOf(Date);
    expect(humanHarness.transitions.at(-1)).toEqual(expect.objectContaining({
      from: "repairing",
      to: "needs_human",
      reason: "Manual approval required",
      operator: "api"
    }));
  });

  it("returns task transition history and observability envelope", async () => {
    const task = createTask({ id: "task-14", status: "queued" });
    const harness = createHarness({
      tasks: [task],
      executions: [createExecutionResult({ sessionId: "codex:s1" })]
    });

    await harness.services.runSchedulerTick();

    const transitions = await harness.services.listTaskTransitions("task-14");
    const observability = await harness.services.getTaskObservability("task-14");

    expect(transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "queued->running",
      "running->evaluating",
      "evaluating->done"
    ]);
    expect(observability).toEqual(expect.objectContaining({
      schemaVersion: "2026-05-11",
      taskId: "task-14"
    }));
    expect(observability.transitions).toHaveLength(3);
    expect(observability.executionLogs.length).toBeGreaterThan(0);
  });

  it("returns trace view aggregated across tasks on the same trace", async () => {
    const traceId = "trace-shared";
    const queuedTask = createTask({ id: "task-15", status: "queued", traceId });
    const humanTask = createTask({ id: "task-16", status: "needs_human", traceId });
    const harness = createHarness({
      tasks: [queuedTask, humanTask],
      executions: [createExecutionResult({ sessionId: "codex:s2" })]
    });

    await harness.services.runSchedulerTick();
    await harness.services.recoverTask("task-16", "api", "Resume investigation");
    const traceView = await harness.services.getTraceView(traceId);

    expect(traceView).toEqual(expect.objectContaining({
      schemaVersion: "2026-05-11",
      traceId
    }));
    expect(traceView.tasks.map((item) => item.id)).toEqual(["task-15", "task-16"]);
    expect(traceView.transitions.map((item) => `${item.taskId}:${item.from}->${item.to}`)).toEqual([
      "task-15:queued->running",
      "task-15:running->evaluating",
      "task-15:evaluating->done",
      "task-16:needs_human->queued"
    ]);
    expect(traceView.executions).toHaveLength(1);
    expect(traceView.executionLogs.length).toBeGreaterThan(0);
    expect(traceView.evalResults).toHaveLength(1);
    expect(traceView.repairGoals).toEqual([]);
  });

  it("supports manual sync and scheduler dispatch debug entrypoints", async () => {
    const pulledTask = createTask({ id: "remote-4", status: "created" });
    pulledTask.source = "meegle";
    pulledTask.externalId = "MEEGLE-4";
    const harness = createHarness({
      tasks: [],
      executions: [createExecutionResult({ sessionId: "codex:s1" })],
      pulledTasks: [pulledTask]
    });

    const sync = await harness.services.runTaskSyncNow();
    expect(sync).toEqual({ integrations: 1, pulledTasks: 1 });
    const taskId = [...harness.tasks.values()][0]?.id;
    expect(taskId).toBeTruthy();

    const dispatch = await harness.services.runSchedulerDispatchNow();
    expect(dispatch.queuedBefore).toBe(1);
    expect(harness.executionPlugin.calls).toEqual(["execute"]);
  });

  it("recovers needs_human tasks from integration comment replies when enabled", async () => {
    const traceId = "trace-human-reply";
    const requestedAt = "2026-05-11T00:00:00.000Z";
    const task = createTask({ id: "task-human-2", status: "needs_human", traceId });
    task.source = "meegle";
    task.externalId = "MEEGLE-HUMAN-2";
    task.metadata = {
      humanLoop: {
        requestId: "request-1",
        requestedAt,
        seenReplyIds: []
      }
    };
    const harness = createHarness({
      tasks: [task],
      executions: [],
      humanReplies: [{
        taskId: "task-human-2",
        externalId: "MEEGLE-HUMAN-2",
        replyId: "reply-1",
        body: "Please retry with the updated API key",
        author: "alice",
        createdAt: "2026-05-11T00:05:00.000Z"
      }],
      enableNeedsHumanLoop: true
    });
    harness.repairGoals.set("task-human-2", {
      id: "goal-human-2",
      taskId: "task-human-2",
      objective: "repair",
      constraints: [],
      doneWhen: ["pass build"],
      status: "needs_human",
      currentIteration: 1,
      maxIterations: 3,
      lastFailureHash: "hash-1",
      createdAt: new Date(requestedAt),
      updatedAt: new Date(requestedAt)
    });

    await harness.services.runTaskSyncNow();

    expect(harness.tasks.get("task-human-2")?.status).toBe("queued");
    expect(harness.tasks.get("task-human-2")?.instruction).toContain("Please retry with the updated API key");
    expect(harness.repairGoals.get("task-human-2")?.status).toBe("repairing");
    expect(harness.repairGoals.get("task-human-2")?.constraints.at(-1)).toContain("Human guidance:");
    expect(harness.transitions.at(-1)).toEqual(expect.objectContaining({
      taskId: "task-human-2",
      from: "needs_human",
      to: "queued"
    }));
  });

  it("lists and upserts plugin configs", async () => {
    const harness = createHarness({
      tasks: [],
      executions: []
    });

    const created = await harness.services.upsertPluginConfig({
      pluginId: "meegle",
      kind: "task-integration",
      enabled: true,
      priority: 10,
      config: { mode: "poll" }
    });
    const list = await harness.services.listPluginConfigs();

    expect(created).toEqual(expect.objectContaining({
      pluginId: "meegle",
      kind: "task-integration",
      enabled: true,
      priority: 10
    }));
    expect(list).toEqual([
      expect.objectContaining({
        pluginId: "meegle",
        config: { mode: "poll" }
      })
    ]);
  });

  it("publishes stable scheduler, plugin, and agent event payloads", async () => {
    const pulledTask = createTask({ id: "remote-5", status: "created" });
    pulledTask.source = "meegle";
    pulledTask.externalId = "MEEGLE-5";
    const harness = createHarness({
      tasks: [],
      executions: [createExecutionResult({ sessionId: "codex:s1" })],
      pulledTasks: [pulledTask]
    });

    await harness.services.runSchedulerTick();
    await harness.services.heartbeatAgent("agent-1");
    await harness.services.upsertPluginConfig({
      pluginId: "meegle",
      kind: "task-integration",
      enabled: true,
      priority: 5,
      config: {}
    });

    const eventTypes = harness.events.map((event) => event.eventType);
    expect(eventTypes).toEqual(expect.arrayContaining([
      "scheduler.tick_started",
      "scheduler.sync_started",
      "plugin.integration_pulled",
      "scheduler.sync_completed",
      "scheduler.tick_completed",
      "agent.heartbeat",
      "plugin.config_updated"
    ]));
    expect(harness.events[0]).toEqual(expect.objectContaining({
      schemaVersion: "2026-05-11"
    }));
    expect(harness.events.every((event) => typeof event.id === "string" && event.id.length > 0)).toBe(true);
  });

  it("attaches shared correlation metadata to execution logs and SSE events", async () => {
    const task = createTask({ id: "task-17", status: "queued" });
    const harness = createHarness({
      tasks: [task],
      executions: [createExecutionResult({ sessionId: "codex:s3" })]
    });

    await harness.services.runSchedulerTick();

    const transitionLog = harness.logs.find(
      (item) => item.eventType === "task.transition" && item.data.to === "evaluating"
    );
    const transitionEvent = harness.events.find((item) => item.eventType === "task.evaluating");
    const executionLog = harness.logs.find((item) => item.eventType === "execution.evaluating");
    const executionEvent = harness.events.find((item) => item.eventType === "execution.evaluating");

    expect(transitionLog?.data.correlation).toEqual(expect.objectContaining({
      traceId: "trace-task-17",
      taskId: "task-17",
      eventId: transitionEvent?.id
    }));
    expect(transitionEvent).toEqual(expect.objectContaining({
      traceId: "trace-task-17",
      taskId: "task-17"
    }));
    expect(transitionEvent?.data?.correlation).toEqual(expect.objectContaining({
      traceId: "trace-task-17",
      taskId: "task-17",
      eventId: transitionEvent?.id
    }));
    expect(executionLog?.data.correlation).toEqual(expect.objectContaining({
      traceId: "trace-task-17",
      taskId: "task-17",
      executionId: executionEvent?.executionId,
      eventId: executionEvent?.id
    }));
    expect(executionEvent?.data?.correlation).toEqual(expect.objectContaining({
      traceId: "trace-task-17",
      taskId: "task-17",
      executionId: executionEvent?.executionId,
      eventId: executionEvent?.id
    }));
  });

  it("claims at most one task per idle agent across overlapping scheduler ticks", async () => {
    const firstExecution = new Promise<ExecutionResult>((resolve) => {
      setTimeout(() => resolve(createExecutionResult({ sessionId: "codex:s4", summary: "first" })), 0);
    });
    const secondExecution = new Promise<ExecutionResult>((resolve) => {
      setTimeout(() => resolve(createExecutionResult({ sessionId: "codex:s5", summary: "second" })), 0);
    });
    const harness = createHarness({
      tasks: [
        createTask({ id: "task-18", status: "queued" }),
        createTask({ id: "task-19", status: "queued" })
      ],
      executions: [firstExecution, secondExecution],
      agents: [
        createAgent({ id: "agent-1" }),
        createAgent({ id: "agent-2" })
      ]
    });

    await Promise.all([harness.services.runSchedulerTick(), harness.services.runSchedulerTick()]);

    expect(harness.executionPlugin.calls).toEqual(["execute", "execute"]);
    expect(harness.transitions.filter((item) => item.to === "running").map((item) => item.taskId).sort()).toEqual([
      "task-18",
      "task-19"
    ]);
    expect(harness.transitions.filter((item) => item.to === "running")).toHaveLength(2);
  });

  it("marks all stale agents offline and only re-queues their running tasks", async () => {
    const runningTask = createTask({ id: "task-20", status: "running" });
    const queuedTask = createTask({ id: "task-21", status: "queued" });
    const harness = createHarness({
      tasks: [runningTask, queuedTask],
      executions: [],
      agents: [
        createAgent({
          id: "agent-1",
          status: "busy",
          taskId: runningTask.id,
          lastHeartbeatAt: new Date("2026-05-10T23:00:00.000Z")
        }),
        createAgent({
          id: "agent-2",
          status: "idle",
          lastHeartbeatAt: new Date("2026-05-10T23:00:00.000Z")
        }),
        createAgent({
          id: "agent-3",
          status: "busy",
          taskId: queuedTask.id,
          lastHeartbeatAt: new Date("2026-05-10T23:00:00.000Z")
        }),
        createAgent({
          id: "agent-4",
          status: "idle",
          executor: "cursor",
          lastHeartbeatAt: new Date("2026-05-11T00:00:00.000Z")
        })
      ],
      agentOfflineTimeoutMs: 60_000
    });

    await harness.services.runSchedulerTick();

    expect(harness.tasks.get("task-20")?.status).toBe("queued");
    expect(harness.tasks.get("task-21")?.status).toBe("queued");
    expect(harness.agents.get("agent-1")?.status).toBe("offline");
    expect(harness.agents.get("agent-2")?.status).toBe("offline");
    expect(harness.agents.get("agent-3")?.status).toBe("offline");
    expect(harness.agents.get("agent-4")?.status).toBe("idle");
    expect(harness.transitions.map((item) => `${item.taskId}:${item.from}->${item.to}`)).toEqual([
      "task-20:running->queued"
    ]);
  });
});

function createHarness(input: {
  tasks: TitingTask[];
  executions: Array<ExecutionResult | Error | Promise<ExecutionResult>>;
  qualityResults?: Array<Awaited<ReturnType<QualityPlugin["evaluate"]>>>;
  qualityEnabled?: boolean;
  agent?: AgentRecord;
  agents?: AgentRecord[];
  agentOfflineTimeoutMs?: number;
  environmentRetryLimit?: number;
  executionRetryLimit?: number;
  executionHeartbeatIntervalMs?: number;
  environmentError?: Error;
  pulledTasks?: TitingTask[];
  humanReplies?: HumanReply[];
  enableNeedsHumanLoop?: boolean;
  governancePlugin?: ObservabilityGovernancePlugin;
}) {
  let now = new Date("2026-05-11T00:00:00.000Z");
  const tasks = new Map(input.tasks.map((task) => [task.id, cloneExistingTask(task)]));
  const transitions: TaskTransition[] = [];
  const logs: ExecutionLogRecord[] = [];
  const executions = new Map<string, ExecutionRecord>();
  const evalResults: EvalResult[] = [];
  const repairGoals = new Map<string, RepairGoal>();
  const pluginConfigs = new Map<string, import("@titing/plugin-api").PluginConfig>();
  const events: Array<{
    id: string;
    schemaVersion: string;
    traceId: string;
    taskId?: string;
    executionId?: string;
    pluginId?: string;
    agentId?: string;
    eventType: string;
    data?: Record<string, unknown>;
  }> = [];
  const initialAgents = input.agents ?? [input.agent ?? createAgent()];
  const agentRecords = new Map(initialAgents.map((agent) => [agent.id, { ...agent }]));
  const agent = agentRecords.values().next().value as AgentRecord;
  const reportedResults: Array<{ taskId: string; externalId: string | null; summary: string }> = [];
  const reportedNeedsHuman: Array<{ taskId: string; externalId: string | null; payload: NeedsHumanPayload }> = [];
  const intervalCallbacks: Array<() => void> = [];

  const executionPlugin = createExecutionPlugin(input.executions);
  const qualityPlugin = createQualityPlugin(input.qualityResults ?? []);
  const environmentPlugin = createEnvironmentPlugin(input.environmentError);

  const services = new TitingServices({
    tasks: new InMemoryTaskRepository(tasks),
    taskTransitions: {
      append: async (transition) => {
        transitions.push(transition);
      },
      listByTask: async (taskId) => transitions.filter((item) => item.taskId === taskId),
      listByTraceId: async (traceId) => transitions.filter((item) => item.traceId === traceId)
    },
    executions: new InMemoryExecutionRepository(executions),
    executionLogs: {
      append: async (log) => {
        logs.push(log);
      },
      listByTask: async (taskId) => logs.filter((item) => item.taskId === taskId)
    },
    agents: new InMemoryAgentRepository(agentRecords),
    repairGoals: {
      upsert: async (goal) => {
        repairGoals.set(goal.taskId, goal);
      },
      getByTaskId: async (taskId) => repairGoals.get(taskId) ?? null
    },
    evalResults: {
      create: async (result) => {
        evalResults.push(result);
      },
      listByTask: async (taskId) => evalResults.filter((item) => item.taskId === taskId)
    },
    pluginConfigs: {
      list: async () => [...pluginConfigs.values()],
      getByPluginId: async (pluginId) => pluginConfigs.get(pluginId) ?? null,
      upsert: async (config) => {
        pluginConfigs.set(config.pluginId, config);
      }
    },
    events: {
      publish: async (event) => {
        events.push({
          id: event.id,
          schemaVersion: event.schemaVersion,
          traceId: event.traceId,
          taskId: event.taskId,
          executionId: event.executionId,
          pluginId: event.pluginId,
          agentId: event.agentId,
          eventType: event.eventType,
          data: event.data
        });
      }
    },
    runtime: new PluginRuntime([
      createTaskIntegrationPlugin(input.pulledTasks ?? [], input.humanReplies ?? [], reportedResults, reportedNeedsHuman),
      environmentPlugin,
      executionPlugin,
      ...(input.qualityEnabled === false ? [] : [qualityPlugin]),
      ...(input.governancePlugin ? [input.governancePlugin] : [])
    ] as RuntimePlugin[]),
    now: () => now,
    createId: createIdFactory(),
    agentOfflineTimeoutMs: input.agentOfflineTimeoutMs,
    environmentRetryLimit: input.environmentRetryLimit,
    executionRetryLimit: input.executionRetryLimit,
    enableNeedsHumanLoop: input.enableNeedsHumanLoop,
    executionHeartbeatIntervalMs: input.executionHeartbeatIntervalMs,
    setIntervalFn: (callback) => {
      intervalCallbacks.push(callback);
      return callback;
    },
    clearIntervalFn: () => undefined
  });

  return {
    services,
    agent,
    agents: agentRecords,
    tasks,
    transitions,
    logs,
    evalResults,
    repairGoals,
    events,
    environmentPlugin,
    executionPlugin,
    qualityPlugin,
    reportedResults,
    reportedNeedsHuman,
    setNow: (value: Date) => {
      now = value;
    },
    tickHeartbeat: () => {
      for (const callback of intervalCallbacks) {
        callback();
      }
    }
  };
}

class InMemoryTaskRepository implements TaskRepository {
  constructor(private readonly tasks: Map<string, TitingTask>) {}

  async create(task: TitingTask): Promise<void> {
    this.tasks.set(task.id, cloneExistingTask(task));
  }

  async save(task: TitingTask): Promise<void> {
    this.tasks.set(task.id, cloneExistingTask(task));
  }

  async getById(id: string): Promise<TitingTask | null> {
    return cloneTask(this.tasks.get(id) ?? null);
  }

  async getByExternalId(source: string, externalId: string): Promise<TitingTask | null> {
    const found = [...this.tasks.values()].find((task) => task.source === source && task.externalId === externalId) ?? null;
    return cloneTask(found);
  }

  async listByTraceId(traceId: string): Promise<TitingTask[]> {
    return [...this.tasks.values()]
      .filter((task) => task.traceId === traceId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((task) => cloneTask(task) as TitingTask);
  }

  async list(query: { status?: TaskStatus; executor?: string } = {}): Promise<TitingTask[]> {
    return [...this.tasks.values()]
      .filter((task) => (query.status ? task.status === query.status : true))
      .filter((task) => (query.executor ? task.executor === query.executor : true))
      .map((task) => cloneTask(task) as TitingTask);
  }

  async claimQueued(id: string, startedAt: Date): Promise<TitingTask | null> {
    const task = this.tasks.get(id);
    if (!task || task.status !== "queued") {
      return null;
    }
    task.status = "running";
    task.startedAt = task.startedAt ?? startedAt;
    task.updatedAt = startedAt;
    this.tasks.set(task.id, cloneExistingTask(task));
    return cloneExistingTask(task);
  }
}

class InMemoryExecutionRepository implements ExecutionRepository {
  constructor(private readonly executions: Map<string, ExecutionRecord>) {}

  async create(execution: ExecutionRecord): Promise<void> {
    this.executions.set(execution.id, { ...execution });
  }

  async save(execution: ExecutionRecord): Promise<void> {
    this.executions.set(execution.id, { ...execution });
  }

  async listByTask(taskId: string): Promise<ExecutionRecord[]> {
    return [...this.executions.values()].filter((item) => item.taskId === taskId);
  }

  async getLatestByTask(taskId: string): Promise<ExecutionRecord | null> {
    return this.listByTask(taskId).then((items) => items.at(-1) ?? null);
  }
}

class InMemoryAgentRepository implements AgentRepository {
  constructor(private readonly agents: Map<string, AgentRecord>) {}

  async upsert(agent: AgentRecord): Promise<void> {
    const existing = this.agents.get(agent.id);
    if (existing) {
      Object.assign(existing, agent);
      return;
    }
    this.agents.set(agent.id, { ...agent });
  }

  async list(): Promise<AgentRecord[]> {
    return [...this.agents.values()].map((agent) => ({ ...agent }));
  }

  async getIdle(executor: string): Promise<AgentRecord | null> {
    const agent = [...this.agents.values()].find((candidate) => candidate.status === "idle" && candidate.executor === executor);
    return agent ? { ...agent } : null;
  }

  async getById(id: string): Promise<AgentRecord | null> {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : null;
  }

  async claimIdle(executor: string, taskId: string, now: Date): Promise<AgentRecord | null> {
    const agent = [...this.agents.values()].find((candidate) => candidate.status === "idle" && candidate.executor === executor);
    if (!agent) {
      return null;
    }
    agent.status = "busy";
    agent.taskId = taskId;
    agent.updatedAt = now;
    agent.lastHeartbeatAt = now;
    return { ...agent };
  }
}

function createEnvironmentPlugin(error?: Error) {
  const calls = {
    prepareWorkspace: 0,
    cleanupWorkspace: 0
  };
  return {
    id: "env",
    kind: "environment" as const,
    priority: 100,
    capabilities: ["local"],
    calls,
    health: async () => ({ healthy: true, message: "ok" }),
    prepareWorkspace: async () => {
      calls.prepareWorkspace += 1;
      if (error) {
        throw error;
      }
      return {
        workspacePath: "/tmp/task",
        repoPath: "/tmp/task/repo",
        branch: "main",
        cachePath: "/tmp/cache",
        artifactsPath: "/tmp/task/artifacts",
        env: {}
      } satisfies PreparedWorkspace;
    },
    cleanupWorkspace: async () => {
      calls.cleanupWorkspace += 1;
    }
  };
}

function createTaskIntegrationPlugin(
  pulledTasks: TitingTask[],
  humanReplies: HumanReply[],
  reportedResults: Array<{ taskId: string; externalId: string | null; summary: string }>,
  reportedNeedsHuman: Array<{ taskId: string; externalId: string | null; payload: NeedsHumanPayload }>
) {
  return {
    id: "meegle",
    kind: "task-integration" as const,
    priority: 100,
    capabilities: ["meegle"],
    health: async () => ({ healthy: true, message: "ok" }),
    pullTasks: async () => pulledTasks.map((task) => cloneExistingTask(task)),
    reportResult: async (task: TitingTask, summary: string) => {
      reportedResults.push({ taskId: task.id, externalId: task.externalId, summary });
    },
    reportNeedsHuman: async (task: TitingTask, payload: NeedsHumanPayload) => {
      reportedNeedsHuman.push({ taskId: task.id, externalId: task.externalId, payload });
    },
    pullHumanReplies: async (tasks: TitingTask[]) => {
      const allowedTaskIds = new Set(tasks.map((task) => task.id));
      return humanReplies.filter((reply) => allowedTaskIds.has(reply.taskId));
    }
  };
}

function createExecutionPlugin(
  results: Array<ExecutionResult | Error | Promise<ExecutionResult>>
): ExecutionPlugin & { calls: string[] } {
  let index = 0;
  const plugin: ExecutionPlugin & { calls: string[] } = {
    id: "codex",
    kind: "execution",
    priority: 100,
    capabilities: ["codex"],
    calls: [],
    health: async () => ({ healthy: true, message: "ok" }),
    execute: async () => {
      plugin.calls.push("execute");
      const next = results[index];
      index += 1;
      if (next instanceof Promise) {
        return next;
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    continueSession: async (sessionId) => {
      plugin.calls.push(`continue:${sessionId}`);
      const next = results[index];
      index += 1;
      if (next instanceof Promise) {
        return next;
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }
  };
  return plugin;
}

function createQualityPlugin(results: Array<Awaited<ReturnType<QualityPlugin["evaluate"]>>>): QualityPlugin & { calls: string[] } {
  let index = 0;
  const plugin: QualityPlugin & { calls: string[] } = {
    id: "quality",
    kind: "quality",
    priority: 100,
    capabilities: ["default"],
    calls: [],
    health: async () => ({ healthy: true, message: "ok" }),
    evaluate: async () => {
      plugin.calls.push("evaluate");
      const next =
        results[index] ??
        ({
          passed: true,
          score: 100,
          riskLevel: "low",
          checks: [{ name: "default", passed: true, detail: "ok" }],
          report: {}
        } satisfies Awaited<ReturnType<QualityPlugin["evaluate"]>>);
      index += 1;
      return next;
    }
  };
  return plugin;
}

function createTask(input: { id: string; status: TaskStatus; traceId?: string }): TitingTask {
  const now = new Date("2026-05-11T00:00:00.000Z");
  return {
    id: input.id,
    source: "manual",
    externalId: null,
    title: input.id,
    instruction: "do work",
    repo: "repo",
    branch: "main",
    priority: "medium",
    status: input.status,
    executor: "codex",
    traceId: input.traceId ?? `trace-${input.id}`,
    constraints: [],
    acceptanceCriteria: [],
    metadata: {},
    retryCount: 0,
    repairCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function createExecutionResult(input: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    exitCode: input.exitCode ?? 0,
    stdout: input.stdout ?? "ok",
    stderr: input.stderr ?? "",
    summary: input.summary ?? "done",
    sessionId: input.sessionId ?? "codex:session-1",
    timedOut: input.timedOut ?? false,
    errorCategory: input.errorCategory ?? "none",
    timeoutCategory: input.timeoutCategory ?? "none",
    metadata: input.metadata ?? {}
  };
}

function createEnvironmentError(input: { stage: string; retryable: boolean; detail?: string }): Error {
  const error = new Error(`${input.stage} failed`);
  Object.assign(error, {
    name: "EnvironmentPreparationError",
    stage: input.stage,
    detail: input.detail ?? `${input.stage} detail`,
    retryable: input.retryable
  });
  return error;
}

function createAgent(input: Partial<AgentRecord> = {}): AgentRecord {
  const now = new Date("2026-05-11T00:00:00.000Z");
  return {
    id: input.id ?? "agent-1",
    status: input.status ?? "idle",
    taskId: input.taskId ?? null,
    executor: input.executor ?? "codex",
    labels: input.labels ?? [],
    lastHeartbeatAt: input.lastHeartbeatAt ?? now,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  };
}

function createIdFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter}`;
  };
}

function cloneTask(task: TitingTask | null): TitingTask | null {
  if (!task) {
    return null;
  }
  return cloneExistingTask(task);
}

function cloneExistingTask(task: TitingTask): TitingTask {
  return {
    ...task,
    constraints: [...task.constraints],
    acceptanceCriteria: [...task.acceptanceCriteria],
    metadata: { ...task.metadata }
  };
}
