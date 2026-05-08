import { AgentRecord } from "./models/agent";

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
  ensureRuntime(agent: AgentRecord): Promise<AgentRuntimeState>;
  runCommand(agent: AgentRecord, command: RuntimeCommand): Promise<RuntimeCommandResult>;
};
