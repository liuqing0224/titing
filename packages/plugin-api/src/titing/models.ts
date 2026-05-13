export type TaskStatus =
  | "created"
  | "validated"
  | "pending"
  | "queued"
  | "running"
  | "evaluating"
  | "repairing"
  | "done"
  | "failed"
  | "needs_human"
  | "blocked"
  | "cancelled";

export type TaskPriority = "low" | "medium" | "high";

export type AgentStatus = "idle" | "busy" | "offline" | "disabled" | "error";

export type RiskLevel = "low" | "medium" | "high";

export type TitingTask = {
  id: string;
  source: string;
  externalId: string | null;
  sourceIdentity?: string;
  integrationKey?: string;
  title: string;
  instruction: string;
  repo: string;
  branch: string;
  priority: TaskPriority;
  status: TaskStatus;
  executor: string;
  traceId: string;
  constraints: string[];
  acceptanceCriteria: string[];
  metadata: Record<string, unknown>;
  retryCount: number;
  repairCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskTransition = {
  taskId: string;
  traceId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
  operator: string;
  timestamp: Date;
};

export type ExecutionStatus =
  | "preparing"
  | "executing"
  | "evaluating"
  | "repairing"
  | "completed"
  | "failed";

export type ExecutionRecord = {
  id: string;
  taskId: string;
  agentId: string | null;
  workspace: string;
  status: ExecutionStatus;
  summary: string | null;
  executor: string;
  startedAt: Date;
  endedAt: Date | null;
};

export type ObservabilityCorrelation = {
  correlationId: string;
  traceId: string;
  taskId?: string;
  executionId?: string;
  pluginId?: string;
  agentId?: string;
  eventId?: string;
};

export type ExecutionLogRecord = {
  id: string;
  taskId: string;
  executionId: string | null;
  eventType: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: Date;
};

export type AgentRecord = {
  id: string;
  status: AgentStatus;
  taskId: string | null;
  executor: string;
  labels: string[];
  lastHeartbeatAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type RepairGoal = {
  id: string;
  taskId: string;
  objective: string;
  constraints: string[];
  doneWhen: string[];
  status: "repairing" | "achieved" | "budget_limited" | "needs_human";
  currentIteration: number;
  maxIterations: number;
  lastFailureHash: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RepairPlan = RepairGoal;

export type EvalResult = {
  id: string;
  taskId: string;
  executionId: string;
  passed: boolean;
  score: number;
  riskLevel: RiskLevel;
  report: Record<string, unknown>;
  createdAt: Date;
};

export type PluginConfig = {
  id: string;
  pluginId: string;
  kind: PluginKind;
  enabled: boolean;
  priority: number;
  config: Record<string, unknown>;
  updatedAt: Date;
};

export type AgentLease = {
  id: string;
  agentId: string;
  taskId: string;
  executionId: string | null;
  leasedAt: Date;
  leaseExpiresAt: Date;
  releasedAt: Date | null;
  releaseReason: string | null;
  candidateAgents: string[];
  selectionReason: string;
  prioritySnapshot: Record<string, unknown>;
};

export type HumanReviewStatus = "pending" | "answered" | "dismissed" | "expired";

export type HumanReview = {
  id: string;
  taskId: string;
  executionId: string | null;
  requestType: string;
  reason: string;
  externalThreadRef: string | null;
  responseSummary: string | null;
  status: HumanReviewStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PluginKind =
  | "task-integration"
  | "execution"
  | "environment"
  | "quality"
  | "observability-governance"
  | "log"
  | "task-source"
  | "workspace"
  | "executor"
  | "quality-check"
  | "governance"
  | "log-store"
  | "observability"
  | "notification"
  | "intelligence"
  | "platform";

export type PluginCapability = {
  kind: PluginKind;
  capability: string;
  priority?: number;
};

export type PluginDependency = {
  kind: PluginKind;
  capability?: string;
  required?: boolean;
};

export type PluginConfigSchema = {
  schemaVersion: string;
  defaults?: Record<string, unknown>;
  required?: string[];
};

export type PluginManifest = {
  id: string;
  displayName: string;
  version: string;
  kind: PluginKind;
  capabilities: PluginCapability[];
  dependencies?: PluginDependency[];
  configSchema?: PluginConfigSchema | null;
};

export type CreateTaskInput = {
  source?: string;
  externalId?: string | null;
  title: string;
  instruction: string;
  repo: string;
  branch?: string;
  priority?: TaskPriority;
  executor?: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  metadata?: Record<string, unknown>;
};

export type TaskListQuery = {
  status?: TaskStatus;
  executor?: string;
};
