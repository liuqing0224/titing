import {
  EvalResult,
  PluginConfig,
  PluginKind,
  RepairGoal,
  RiskLevel,
  TitingTask
} from "./models";

export type PluginHealth = {
  healthy: boolean;
  message: string;
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

export interface RuntimePlugin {
  id: string;
  kind: PluginKind;
  priority: number;
  capabilities: string[];
  init?(config: PluginConfig | null): Promise<void>;
  health(): Promise<PluginHealth>;
}

export interface TaskIntegrationPlugin extends RuntimePlugin {
  kind: "task-integration";
  pullTasks(): Promise<TitingTask[]>;
  reportResult(task: TitingTask, summary: string): Promise<void>;
}

export type PreparedWorkspace = {
  workspacePath: string;
  repoPath: string;
  branch: string;
  cachePath: string;
  artifactsPath: string;
  env: Record<string, string>;
};

export interface EnvironmentPlugin extends RuntimePlugin {
  kind: "environment";
  prepareWorkspace(task: TitingTask): Promise<PreparedWorkspace>;
  cleanupWorkspace(task: TitingTask, workspace: PreparedWorkspace): Promise<void>;
}

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

export interface ExecutionPlugin extends RuntimePlugin {
  kind: "execution";
  execute(task: TitingTask, workspace: PreparedWorkspace, goal: RepairGoal | null): Promise<ExecutionResult>;
  continueSession?(
    sessionId: string,
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal
  ): Promise<ExecutionResult>;
}

export type QualityCheck = {
  name: string;
  passed: boolean;
  detail: string;
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
