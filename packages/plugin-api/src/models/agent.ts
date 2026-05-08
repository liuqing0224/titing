export type AgentStatus = "idle" | "running" | "offline";

export type AgentRecord = {
  id: string;
  taskId: string | null;
  containerId: string | null;
  containerName: string;
  status: AgentStatus;
  startedAt: Date | null;
  heartbeatAt: Date;
  createdAt: Date;
  updatedAt: Date;
};
