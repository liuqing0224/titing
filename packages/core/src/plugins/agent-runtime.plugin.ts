import { Agent } from "../agents/agent.entity";

export type ProcessRunOptions = {
  cwd: string;
  maxBuffer: number;
  timeout: number;
};

export type RuntimeCommandResult = {
  stdout: string;
  stderr: string;
};

export type RuntimeChunkHandler = (chunk: string) => void | Promise<void>;

export type RuntimeCommand = {
  cwd: string;
  command: string;
  args: string[];
  options: ProcessRunOptions;
  onStdoutChunk?: RuntimeChunkHandler;
  onStderrChunk?: RuntimeChunkHandler;
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
