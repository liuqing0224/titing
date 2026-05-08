import { AgentRecord } from "./models/agent";
import { TaskRecord } from "./models/task";

export type ExecutionRunStage = "clone" | "checkout" | "workflow-prompts" | "execute";

export type ExecutionContext = {
  repo: string;
  branch: string;
  repoRoot: string;
  worktreePath: string;
  cloneUrl: string | null;
  isAbsolutePath?: boolean;
  agentsMdPath: string;
  workflowPromptsPath: string;
};

export type ExecutionRunResult = {
  stage: ExecutionRunStage;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  branchCheckedOut: boolean;
  codexStarted: boolean;
  repo: string;
  branch: string;
  repoRoot: string;
  worktreePath: string;
  agentsMdPath: string;
  workflowPromptsPath: string;
};

export type ExecutionEnginePlugin = {
  readonly engine: string;
  getExecutionContext(task: TaskRecord): ExecutionContext;
  runTask(task: TaskRecord, agent: AgentRecord): Promise<ExecutionRunResult>;
};
