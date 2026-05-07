import { ExecutionLog } from "../execution-logs/execution-log.entity";

export type AppendExecutionLogInput = {
  taskId: string;
  agentId?: string | null;
  status: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type ExecutionLogStorePlugin = {
  append(input: AppendExecutionLogInput): Promise<ExecutionLog>;
  listByTask(taskId: string): Promise<ExecutionLog[]>;
};
