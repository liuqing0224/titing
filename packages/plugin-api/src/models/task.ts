export type TaskSource = "meegle" | "manual";
export type TaskType = "feature" | "bug" | "chore" | "docs";
export type TaskPriority = "low" | "medium" | "high";
export type TaskStatus = "pending" | "queued" | "running" | "done" | "failed";

export type TaskRecord = {
  id: string;
  source: TaskSource;
  externalId: string | null;
  title: string;
  description: string | null;
  repo: string;
  branch: string;
  taskType: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  instruction: string | null;
  constraints: unknown[];
  retryCount: number;
  claimedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
