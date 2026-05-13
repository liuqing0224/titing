import {
  EvaluationReport,
  GovernancePlugin,
  HumanReview,
  IntelligencePlugin,
  NotificationMessage,
  NotificationPlugin,
  ObservabilityPlugin,
  PlatformPlugin,
  PreparedWorkspace,
  RuntimePlugin,
  TaskSourcePlugin,
  TitingTask,
  WorkspacePlugin,
  ExecutorPlugin
} from "@titing/plugin-api";

function health() {
  return Promise.resolve({ healthy: true, message: "ok" });
}

export function createSkeletonPlugins(): RuntimePlugin[] {
  const emptyWorkspace: PreparedWorkspace = {
    workspacePath: "/tmp/workspace",
    repoPath: "/tmp/workspace/repo",
    branch: "main",
    cachePath: "/tmp/cache",
    artifactsPath: "/tmp/artifacts",
    env: {}
  };
  const emptyReport: EvaluationReport = {
    checks: [],
    riskLevel: "low",
    score: 100,
    acceptanceStatus: "passed",
    failureClass: "none",
    evidence: {}
  };
  const taskSource: TaskSourcePlugin = {
    id: "skeleton-task-source",
    kind: "task-source",
    priority: 1,
    capabilities: ["default"],
    health,
    pullTasks: async () => [],
    ackTask: async () => undefined,
    reportResult: async () => undefined,
    pullHumanReplies: async () => []
  };
  const workspace: WorkspacePlugin = {
    id: "skeleton-workspace",
    kind: "workspace",
    priority: 1,
    capabilities: ["default"],
    health,
    prepareWorkspace: async () => emptyWorkspace,
    restoreWorkspace: async () => emptyWorkspace,
    snapshotWorkspace: async () => ({}),
    cleanupWorkspace: async () => undefined
  };
  const executor: ExecutorPlugin = {
    id: "skeleton-executor",
    kind: "executor",
    priority: 1,
    capabilities: ["default"],
    health,
    execute: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      summary: "ok",
      sessionId: "session-1",
      timedOut: false,
      errorCategory: "none",
      timeoutCategory: "none",
      metadata: {}
    }),
    resume: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      summary: "resumed",
      sessionId: "session-1",
      timedOut: false,
      errorCategory: "none",
      timeoutCategory: "none",
      metadata: {}
    }),
    interrupt: async (sessionId, reason) => ({ sessionId, interrupted: true, reason }),
    inspectSession: async () => ({})
  };
  const observability: ObservabilityPlugin = {
    id: "skeleton-observability",
    kind: "observability",
    priority: 1,
    capabilities: ["default"],
    health,
    publishEvent: async () => undefined,
    queryTimeline: async () => [],
    buildTraceView: async () => ({}),
    computeHealthSnapshot: async () => ({})
  };
  const notification: NotificationPlugin = {
    id: "skeleton-notification",
    kind: "notification",
    priority: 1,
    capabilities: ["default"],
    health,
    notify: async (_message: NotificationMessage) => undefined,
    notifyHumanReview: async (_review: HumanReview) => undefined,
    notifyStatusChange: async (_task: TitingTask) => undefined,
    routeNotification: async () => "default"
  };
  const intelligence: IntelligencePlugin = {
    id: "skeleton-intelligence",
    kind: "intelligence",
    priority: 1,
    capabilities: ["default"],
    health,
    suggestRepair: async () => ({}),
    classifyRisk: async () => "low",
    summarizeFailure: async () => "ok",
    rankTasks: async (tasks) => tasks.map((task) => task.id)
  };
  const governance: GovernancePlugin = {
    id: "skeleton-governance",
    kind: "governance",
    priority: 1,
    capabilities: ["default"],
    health,
    validateCommand: async () => undefined,
    scanSecrets: async () => [],
    enforceDiffLimit: async () => undefined,
    approveRisk: async () => "approved"
  };
  const platform: PlatformPlugin = {
    id: "skeleton-platform",
    kind: "platform",
    priority: 1,
    capabilities: ["default"],
    health,
    issueLease: async () => undefined,
    recordAudit: async () => undefined,
    openHumanReview: async () => undefined
  };
  const qualityCheck = {
    id: "skeleton-quality-check",
    kind: "quality-check" as const,
    priority: 1,
    capabilities: ["default"],
    health,
    evaluate: async () => emptyReport
  };
  const logStore = {
    id: "skeleton-log-store",
    kind: "log-store" as const,
    priority: 1,
    capabilities: ["default"],
    health
  };
  return [taskSource, workspace, executor, qualityCheck, governance, logStore, observability, notification, intelligence, platform];
}
