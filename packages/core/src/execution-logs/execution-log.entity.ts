import { ExecutionLogRecord } from "@autodev-agent/plugin-api";

export class ExecutionLog implements ExecutionLogRecord {
  id: string;

  taskId: string;

  agentId: string | null;

  status: string;

  message: string;

  metadata: Record<string, unknown> | null;

  createdAt: Date;
}
