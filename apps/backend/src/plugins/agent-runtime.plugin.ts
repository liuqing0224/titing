import { Agent } from "../agents/agent.entity";
import type { ProcessRunOptions } from "../orchestrator/codex-runner";

export type RuntimeCommandResult = {
  stdout: string;
  stderr: string;
};

export type RuntimeCommand = {
  cwd: string;
  command: string;
  args: string[];
  options: ProcessRunOptions;
};

export type AgentRuntimeState = {
  containerId: string;
  running: boolean;
};

export type AgentRuntimePlugin = {
  readonly runtime: string;
  ensureRuntime(agent: Agent): Promise<AgentRuntimeState>;
  runCommand(agent: Agent, command: RuntimeCommand): Promise<RuntimeCommandResult>;
};
