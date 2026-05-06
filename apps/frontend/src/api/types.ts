export type TaskStatus = "pending" | "queued" | "running" | "done" | "failed";
export type TaskPriority = "low" | "medium" | "high";

export type Task = {
  id: string;
  externalId: string | null;
  title: string;
  description: string | null;
  repo: string;
  branch: string;
  taskType: string;
  priority: TaskPriority;
  status: TaskStatus;
  instruction: string | null;
  retryCount: number;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Agent = {
  id: string;
  taskId: string | null;
  containerId: string | null;
  containerName: string;
  status: "idle" | "running" | "offline";
  startedAt: string | null;
  heartbeatAt: string;
  updatedAt: string;
};

export type ExecutionLog = {
  id: string;
  taskId: string;
  agentId: string | null;
  status: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type DashboardStats = {
  total: number;
  pending: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
};
