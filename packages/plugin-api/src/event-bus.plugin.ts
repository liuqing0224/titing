import { MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";

export type AgentStatusEvent = {
  agentId: string;
  status: string;
  timestamp: string;
};

export type TaskLifecycleEvent = {
  taskId: string;
  status: string;
  agentId?: string | null;
  timestamp: string;
};

export type ExecutionLogEvent = {
  logId: string;
  taskId: string;
  status: string;
  agentId?: string | null;
  timestamp: string;
};

export type MeegleLoginRequiredEvent = {
  verificationUri: string;
  userCode: string;
  timestamp: string;
};

export type EventBusPlugin = {
  stream(): Observable<MessageEvent>;
  publishAgentStatus(agentId: string, status: string): void;
  publishTaskLifecycle(taskId: string, status: string, agentId?: string | null): void;
  publishExecutionLog(logId: string, taskId: string, status: string, agentId?: string | null): void;
  publishMeegleLoginRequired(verificationUri: string, userCode: string): void;
  hasSubscribers(): boolean;
  getAgentStatusEvents(): AgentStatusEvent[];
  getTaskLifecycleEvents(): TaskLifecycleEvent[];
  getExecutionLogEvents(): ExecutionLogEvent[];
  getMeegleLoginRequiredEvents(): MeegleLoginRequiredEvent[];
};
