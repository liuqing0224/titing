import { ExecutionLogRecord } from "./models/execution-log";

export type AppendExecutionLogInput = {
  taskId: string;
  agentId?: string | null;
  status: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type ExecutionLogStorePlugin = {
  append(input: AppendExecutionLogInput): Promise<ExecutionLogRecord>;
  listByTask(taskId: string): Promise<ExecutionLogRecord[]>;
};
