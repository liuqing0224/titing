const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api";

export type MeegleLoginRequiredEvent = {
  verificationUri: string;
  userCode: string;
  timestamp: string;
};

export type ExecutionLogEvent = {
  logId: string;
  taskId: string;
  status: string;
  agentId?: string | null;
  timestamp: string;
};

type EventHandlers = {
  refreshAll: () => void;
  onMeegleLoginRequired?: (event: MeegleLoginRequiredEvent) => void;
  onExecutionLog?: (event: ExecutionLogEvent) => void;
};

export function connectEvents({
  refreshAll,
  onMeegleLoginRequired,
  onExecutionLog
}: EventHandlers): () => void {
  const eventSource = new EventSource(`${API_BASE_URL}/events`);
  eventSource.addEventListener("task.lifecycle", refreshAll);
  eventSource.addEventListener("agent.status", refreshAll);
  eventSource.addEventListener("execution.log", (event) => {
    if (!onExecutionLog) {
      return;
    }
    onExecutionLog(JSON.parse((event as MessageEvent<string>).data) as ExecutionLogEvent);
  });
  eventSource.addEventListener("meegle.login_required", (event) => {
    if (!onMeegleLoginRequired) {
      return;
    }
    onMeegleLoginRequired(JSON.parse((event as MessageEvent<string>).data) as MeegleLoginRequiredEvent);
  });

  return () => eventSource.close();
}
