export type ObservabilityEvent = {
  id: string;
  schemaVersion: string;
  traceId: string;
  taskId?: string;
  executionId?: string;
  pluginId?: string;
  agentId?: string;
  eventType: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: Date;
};

export interface EventSink {
  publish(event: ObservabilityEvent): Promise<void>;
}
