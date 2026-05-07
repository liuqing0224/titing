import { Agent } from "../agents/agent.entity";
import { Task } from "../tasks/task.entity";

export type ExecutionRunStage = "clone" | "checkout" | "workflow-prompts" | "execute";

export type ExecutionContext = {
  repo: string;
  branch: string;
  hostCwd: string;
  containerCwd: string;
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
  hostCwd: string;
  containerCwd: string;
  agentsMdPath: string;
  workflowPromptsPath: string;
};

export type ExecutionEnginePlugin = {
  readonly engine: string;
  getExecutionContext(task: Task): ExecutionContext;
  runTask(task: Task, agent: Agent): Promise<ExecutionRunResult>;
};
