import {
  AgentLease,
  ExecutionRecord,
  HumanReview,
  RepairPlan,
  TitingTask
} from "@titing/plugin-api";
import {
  mapAgentLeaseRoundTrip,
  mapExecutionRoundTrip,
  mapHumanReviewRoundTrip,
  mapRepairPlanRoundTrip,
  mapTaskRoundTrip
} from "./domain-mappers";

describe("domain mappers", () => {
  it("round-trips task models", () => {
    const now = new Date("2026-05-13T00:00:00.000Z");
    const task: TitingTask = {
      id: "task-1",
      source: "manual",
      externalId: "EXT-1",
      sourceIdentity: "manual",
      integrationKey: "manual/default",
      title: "Fix build",
      instruction: "Do it",
      repo: "repo",
      branch: "main",
      priority: "high",
      status: "queued",
      executor: "codex",
      traceId: "trace-1",
      constraints: ["a"],
      acceptanceCriteria: ["b"],
      metadata: { ok: true },
      retryCount: 1,
      repairCount: 2,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now
    };

    expect(mapTaskRoundTrip(task)).toEqual(task);
  });

  it("round-trips execution, repair, human review and lease models", () => {
    const now = new Date("2026-05-13T00:00:00.000Z");
    const execution: ExecutionRecord = {
      id: "exec-1",
      taskId: "task-1",
      agentId: "agent-1",
      workspace: "/tmp/work",
      status: "executing",
      summary: "running",
      executor: "codex",
      startedAt: now,
      endedAt: null
    };
    const repairPlan: RepairPlan = {
      id: "goal-1",
      taskId: "task-1",
      objective: "Fix build",
      constraints: ["safe"],
      doneWhen: ["tests pass"],
      status: "repairing",
      currentIteration: 1,
      maxIterations: 3,
      lastFailureHash: "hash",
      createdAt: now,
      updatedAt: now
    };
    const humanReview: HumanReview = {
      id: "review-1",
      taskId: "task-1",
      executionId: "exec-1",
      requestType: "approval",
      reason: "needs input",
      externalThreadRef: "thread-1",
      responseSummary: null,
      status: "pending",
      createdAt: now,
      updatedAt: now
    };
    const lease: AgentLease = {
      id: "lease-1",
      agentId: "agent-1",
      taskId: "task-1",
      executionId: "exec-1",
      leasedAt: now,
      leaseExpiresAt: now,
      releasedAt: null,
      releaseReason: null,
      candidateAgents: ["agent-1"],
      selectionReason: "best priority",
      prioritySnapshot: { codex: 100 }
    };

    expect(mapExecutionRoundTrip(execution)).toEqual(execution);
    expect(mapRepairPlanRoundTrip(repairPlan)).toEqual(repairPlan);
    expect(mapHumanReviewRoundTrip(humanReview)).toEqual(humanReview);
    expect(mapAgentLeaseRoundTrip(lease)).toEqual(lease);
  });
});
