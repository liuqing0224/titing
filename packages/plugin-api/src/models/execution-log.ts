export type ExecutionLogRecord = {
  id: string;
  taskId: string;
  agentId: string | null;
  status: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};
