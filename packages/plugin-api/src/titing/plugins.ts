import {
  AgentLease,
  ExecutionLogRecord,
  EvalResult,
  HumanReview,
  PluginCapability,
  PluginConfig,
  PluginDependency,
  PluginKind,
  PluginManifest,
  RepairGoal,
  RiskLevel,
  TitingTask
} from "./models";
import { AuditEvent } from "./models/identity";
import { ObservabilityEvent } from "./events";

export type PluginHealth = {
  healthy: boolean;
  message: string;
};

export type NeedsHumanPayload = {
  reason: string;
  stopReason: "high_risk" | "repeated_failure" | "no_effective_diff";
  summary: string;
  requestId: string;
  requestedAt: string;
  evalResultId?: string;
  executionId?: string;
};

export type HumanReply = {
  taskId: string;
  externalId: string;
  replyId: string;
  body: string;
  author?: string;
  createdAt: string;
};

export type GovernanceRecord = {
  pluginId?: string;
  phase: "before_command" | "after_command" | "after_eval";
  outcome: "allowed" | "blocked" | "flagged";
  message: string;
  findings: string[];
  metadata: Record<string, unknown>;
  recordedAt: string;
};

export type LogEntry = {
  id: string;
  createdAt: Date;
  level: "debug" | "info" | "warn" | "error";
  channel: "event" | "execution_log" | "executor_stdout" | "executor_stderr" | "executor_summary" | "audit";
  eventType: string;
  message: string;
  traceId?: string;
  taskId?: string;
  executionId?: string | null;
  pluginId?: string;
  agentId?: string;
  data: Record<string, unknown>;
};

export interface RuntimePlugin {
  id: string;
  kind: PluginKind;
  priority: number;
  capabilities: string[];
  manifest?: PluginManifest;
  init?(config: PluginConfig | null): Promise<void>;
  health(): Promise<PluginHealth>;
  close?(): Promise<void>;
}

export type ExternalPluginFactoryContext<TConfig = unknown> = {
  serverConfig: TConfig;
  pluginKind?: PluginKind;
};

export type ExternalPluginPackage<TConfig = unknown> = {
  manifest: PluginManifest;
  dependencies?: PluginDependency[];
  createPlugins(context: ExternalPluginFactoryContext<TConfig>): Promise<RuntimePlugin[]> | RuntimePlugin[];
};

export type ExternalPluginFactory<TConfig = unknown> = (
  context: ExternalPluginFactoryContext<TConfig>
) => Promise<ExternalPluginPackage<TConfig>> | ExternalPluginPackage<TConfig>;

export type PreparedWorkspace = {
  workspacePath: string;
  repoPath: string;
  branch: string;
  cachePath: string;
  artifactsPath: string;
  env: Record<string, string>;
};

export type EnvironmentRuntimeEvent =
  | {
      type: "command_start";
      stage: string;
      command: string[];
      cwd: string;
      occurredAt: string;
    }
  | {
      type: "spawn";
      stage: string;
      command: string[];
      cwd: string;
      pid?: number;
      occurredAt: string;
    }
  | {
      type: "stdout" | "stderr";
      stage: string;
      command: string[];
      cwd: string;
      bytes: number;
      chunk: string;
      occurredAt: string;
    }
  | {
      type: "timeout";
      stage: string;
      command: string[];
      cwd: string;
      signal: string;
      timeoutMs: number;
      occurredAt: string;
    }
  | {
      type: "error";
      stage: string;
      command: string[];
      cwd: string;
      error: string;
      occurredAt: string;
    }
  | {
      type: "close";
      stage: string;
      command: string[];
      cwd: string;
      exitCode: number | null;
      stdoutBytes: number;
      stderrBytes: number;
      timedOut: boolean;
      occurredAt: string;
    }
  | {
      type: "result";
      stage: string;
      command: string[];
      cwd: string;
      exitCode: number;
      timedOut: boolean;
      summary: string;
      stdoutLength: number;
      stderrLength: number;
      occurredAt: string;
    };

export type EnvironmentRuntimeLogger = (event: EnvironmentRuntimeEvent) => Promise<void>;

export type EnvironmentContext = {
  runtimeLogger?: EnvironmentRuntimeLogger;
};

export type ExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  summary: string;
  sessionId: string | null;
  timedOut: boolean;
  errorCategory: "none" | "launch_error" | "command_failed" | "governance_blocked" | "timeout";
  timeoutCategory: "none" | "execution_timeout";
  metadata: Record<string, unknown>;
};

export type ExecutionRuntimeEvent =
  | {
      type: "command_start";
      command: string[];
      cwd: string;
      outputPath?: string;
      nativeSessionId?: string | null;
      occurredAt: string;
    }
  | {
      type: "spawn";
      command: string[];
      cwd: string;
      pid?: number;
      nativeSessionId?: string | null;
      occurredAt: string;
    }
  | {
      type: "stdout" | "stderr";
      command: string[];
      cwd: string;
      bytes: number;
      chunk: string;
      nativeSessionId?: string | null;
      occurredAt: string;
    }
  | {
      type: "timeout";
      command: string[];
      cwd: string;
      signal: string;
      timeoutMs: number;
      nativeSessionId?: string | null;
      occurredAt: string;
    }
  | {
      type: "error";
      command: string[];
      cwd: string;
      error: string;
      nativeSessionId?: string | null;
      occurredAt: string;
    }
  | {
      type: "close";
      command: string[];
      cwd: string;
      exitCode: number | null;
      stdoutBytes: number;
      stderrBytes: number;
      timedOut: boolean;
      nativeSessionId?: string | null;
      occurredAt: string;
    }
  | {
      type: "result";
      command: string[];
      cwd: string;
      exitCode: number;
      timedOut: boolean;
      errorCategory: string;
      timeoutCategory: string;
      stdoutLength: number;
      stderrLength: number;
      summary: string;
      sessionId?: string | null;
      nativeSessionId?: string | null;
      occurredAt: string;
    }
  | {
      type: "session_create_start" | "session_create_result";
      command: string[];
      cwd: string;
      exitCode?: number;
      stdoutLength?: number;
      stderrLength?: number;
      sessionId?: string | null;
      occurredAt: string;
    };

export type ExecutionRuntimeLogger = (event: ExecutionRuntimeEvent) => Promise<void>;

export type ExecutionContext = {
  runtimeLogger?: ExecutionRuntimeLogger;
};

export type QualityCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type EvaluationReport = {
  checks: QualityCheck[];
  riskLevel: RiskLevel;
  score: number;
  acceptanceStatus: "passed" | "failed" | "needs_human";
  failureClass: string;
  evidence: Record<string, unknown>;
  rootCause?: string;
  scope?: string;
  suggestedStrategy?: string;
};

export type QualityInput = {
  task: TitingTask;
  workspace: PreparedWorkspace;
  execution: ExecutionResult;
};

export type QualityResult = {
  passed: boolean;
  score: number;
  riskLevel: RiskLevel;
  checks: QualityCheck[];
  report: Record<string, unknown>;
};

export type NotificationMessage = {
  id: string;
  type: string;
  subject: string;
  body: string;
  taskId?: string;
  executionId?: string;
  metadata: Record<string, unknown>;
};

export interface TaskSourcePlugin extends RuntimePlugin {
  kind: "task-source";
  pullTasks(): Promise<TitingTask[]>;
  ackTask(task: TitingTask): Promise<void>;
  reportResult(task: TitingTask, summary: string): Promise<void>;
  pullHumanReplies(): Promise<HumanReply[]>;
}

export interface WorkspacePlugin extends RuntimePlugin {
  kind: "workspace";
  prepareWorkspace(task: TitingTask, context?: EnvironmentContext): Promise<PreparedWorkspace>;
  restoreWorkspace(task: TitingTask, workspace: PreparedWorkspace): Promise<PreparedWorkspace>;
  snapshotWorkspace(task: TitingTask, workspace: PreparedWorkspace): Promise<Record<string, unknown>>;
  cleanupWorkspace(task: TitingTask, workspace: PreparedWorkspace): Promise<void>;
}

export interface ExecutorPlugin extends RuntimePlugin {
  kind: "executor";
  execute(
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal | null,
    context?: ExecutionContext
  ): Promise<ExecutionResult>;
  resume(
    sessionId: string,
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal,
    context?: ExecutionContext
  ): Promise<ExecutionResult>;
  interrupt(sessionId: string, reason: string): Promise<{ sessionId: string; interrupted: boolean; reason: string }>;
  inspectSession(sessionId: string): Promise<Record<string, unknown>>;
}

export interface QualityCheckPlugin extends RuntimePlugin {
  kind: "quality-check";
  evaluate(input: QualityInput): Promise<EvaluationReport>;
}

export interface GovernancePlugin extends RuntimePlugin {
  kind: "governance";
  validateCommand(command: string[]): Promise<void>;
  scanSecrets(value: string): Promise<string[]>;
  enforceDiffLimit(diffStats: Record<string, unknown>): Promise<void>;
  approveRisk(report: EvaluationReport): Promise<"approved" | "blocked">;
}

export interface ObservabilityPlugin extends RuntimePlugin {
  kind: "observability";
  publishEvent(event: ObservabilityEvent): Promise<void>;
  queryTimeline(taskId: string): Promise<ObservabilityEvent[]>;
  buildTraceView(traceId: string): Promise<Record<string, unknown>>;
  computeHealthSnapshot(): Promise<Record<string, unknown>>;
}

export interface NotificationPlugin extends RuntimePlugin {
  kind: "notification";
  notify(message: NotificationMessage): Promise<void>;
  notifyHumanReview(review: HumanReview): Promise<void>;
  notifyStatusChange(task: TitingTask): Promise<void>;
  routeNotification(message: NotificationMessage): Promise<string>;
}

export interface IntelligencePlugin extends RuntimePlugin {
  kind: "intelligence";
  suggestRepair(input: EvaluationReport): Promise<Record<string, unknown>>;
  classifyRisk(input: EvaluationReport): Promise<RiskLevel>;
  summarizeFailure(input: EvaluationReport): Promise<string>;
  rankTasks(tasks: TitingTask[]): Promise<string[]>;
}

export interface PlatformPlugin extends RuntimePlugin {
  kind: "platform";
  issueLease(lease: AgentLease): Promise<void>;
  recordAudit(event: AuditEvent): Promise<void>;
  openHumanReview(review: HumanReview): Promise<void>;
}

export interface TaskIntegrationPlugin extends RuntimePlugin {
  kind: "task-integration";
  pullTasks(): Promise<TitingTask[]>;
  ackTask?(task: TitingTask): Promise<void>;
  reportResult(task: TitingTask, summary: string): Promise<void>;
  reportNeedsHuman?(task: TitingTask, payload: NeedsHumanPayload): Promise<void>;
  pullHumanReplies?(tasks: TitingTask[]): Promise<HumanReply[]>;
}

export interface EnvironmentPlugin extends RuntimePlugin {
  kind: "environment";
  prepareWorkspace(task: TitingTask, context?: EnvironmentContext): Promise<PreparedWorkspace>;
  restoreWorkspace?(task: TitingTask, workspace: PreparedWorkspace): Promise<PreparedWorkspace>;
  snapshotWorkspace?(task: TitingTask, workspace: PreparedWorkspace): Promise<Record<string, unknown>>;
  cleanupWorkspace(task: TitingTask, workspace: PreparedWorkspace): Promise<void>;
}

export interface ExecutionPlugin extends RuntimePlugin {
  kind: "execution";
  execute(
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal | null,
    context?: ExecutionContext
  ): Promise<ExecutionResult>;
  continueSession?(
    sessionId: string,
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal,
    context?: ExecutionContext
  ): Promise<ExecutionResult>;
  interrupt?(sessionId: string, reason: string): Promise<{ sessionId: string; interrupted: boolean; reason: string }>;
  inspectSession?(sessionId: string): Promise<Record<string, unknown>>;
}

export interface QualityPlugin extends RuntimePlugin {
  kind: "quality";
  evaluate(input: QualityInput): Promise<QualityResult>;
}

export interface ObservabilityGovernancePlugin extends RuntimePlugin {
  kind: "observability-governance";
  beforeCommand?(command: string[]): Promise<void>;
  afterCommand?(command: string[], result: ExecutionResult): Promise<void>;
  afterEval?(result: EvalResult): Promise<void>;
  redact?(value: string): string;
  getRecords?(): GovernanceRecord[];
}

export interface LogPlugin extends RuntimePlugin {
  kind: "log";
  append(entry: LogEntry): Promise<void>;
  listByTask(taskId: string, limit?: number): Promise<ExecutionLogRecord[]>;
  listByTrace(traceId: string, limit?: number): Promise<ExecutionLogRecord[]>;
  recentEvents(limit?: number): Promise<ObservabilityEvent[]>;
  snapshotEvents(limit?: number): ObservabilityEvent[];
  subscribe(listener: (event: ObservabilityEvent) => void): () => void;
}

export type PluginContractPlugin =
  | TaskSourcePlugin
  | WorkspacePlugin
  | ExecutorPlugin
  | QualityCheckPlugin
  | GovernancePlugin
  | ObservabilityPlugin
  | NotificationPlugin
  | IntelligencePlugin
  | PlatformPlugin;

export type PluginContractMap = {
  "task-source": TaskSourcePlugin;
  workspace: WorkspacePlugin;
  executor: ExecutorPlugin;
  "quality-check": QualityCheckPlugin;
  governance: GovernancePlugin;
  observability: ObservabilityPlugin;
  notification: NotificationPlugin;
  intelligence: IntelligencePlugin;
  platform: PlatformPlugin;
};

export const PLUGIN_CONTRACT_KINDS = [
  "task-source",
  "workspace",
  "executor",
  "quality-check",
  "governance",
  "observability",
  "notification",
  "intelligence",
  "platform"
] as const satisfies PluginKind[];

export const DEFAULT_PLUGIN_CAPABILITY: PluginCapability = {
  kind: "platform",
  capability: "default",
  priority: 0
};
