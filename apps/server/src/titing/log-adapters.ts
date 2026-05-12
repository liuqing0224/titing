import {
  ExecutionLogRecord,
  ExecutionLogRepository,
  LogPlugin,
  LogEntry,
  ObservabilityEvent
} from "@titing/plugin-api";
import { EventStreamView } from "./event-stream";

export class FileLogEventStream implements EventStreamView {
  constructor(private readonly plugin: LogPlugin) {}

  async publish(event: ObservabilityEvent): Promise<void> {
    await this.plugin.append({
      id: event.id,
      createdAt: event.createdAt,
      level: "info",
      channel: "event",
      eventType: event.eventType,
      message: event.message,
      traceId: event.traceId,
      taskId: event.taskId,
      executionId: event.executionId ?? null,
      pluginId: event.pluginId,
      agentId: event.agentId,
      data: event.data ?? {}
    });
  }

  subscribe(listener: (event: ObservabilityEvent) => void): () => void {
    return this.plugin.subscribe(listener);
  }

  snapshot(): ObservabilityEvent[] {
    return this.plugin.snapshotEvents();
  }
}

export class FileExecutionLogRepository implements ExecutionLogRepository {
  constructor(private readonly plugin: LogPlugin) {}

  async append(log: ExecutionLogRecord): Promise<void> {
    const entry = toExecutionLogEntry(log);
    await this.plugin.append(entry);
    const rawEntries = toExecutorOutputEntries(entry);
    for (const rawEntry of rawEntries) {
      await this.plugin.append(rawEntry);
    }
  }

  async listByTask(taskId: string): Promise<ExecutionLogRecord[]> {
    return this.plugin.listByTask(taskId);
  }
}

export async function appendRuntimeLog(plugin: LogPlugin, entry: LogEntry): Promise<void> {
  await plugin.append(entry);
}

function toExecutionLogEntry(log: ExecutionLogRecord): LogEntry {
  const correlation = log.data?.correlation;
  const correlationRecord = correlation && typeof correlation === "object" ? correlation as Record<string, unknown> : {};
  return {
    id: log.id,
    createdAt: log.createdAt,
    level: inferLevel(log.eventType),
    channel: "execution_log",
    eventType: log.eventType,
    message: log.message,
    traceId: typeof correlationRecord.traceId === "string" ? correlationRecord.traceId : undefined,
    taskId: log.taskId,
    executionId: log.executionId,
    pluginId: typeof correlationRecord.pluginId === "string" ? correlationRecord.pluginId : undefined,
    agentId: typeof correlationRecord.agentId === "string" ? correlationRecord.agentId : undefined,
    data: log.data
  };
}

function inferLevel(eventType: string): LogEntry["level"] {
  if (eventType.includes("failed") || eventType.includes("blocked")) {
    return "error";
  }
  if (eventType.includes("retry") || eventType.includes("needs_human")) {
    return "warn";
  }
  if (eventType.includes("completed") || eventType.includes("done")) {
    return "info";
  }
  return "debug";
}

function toExecutorOutputEntries(entry: LogEntry): LogEntry[] {
  if (!entry.taskId || !entry.executionId) {
    return [];
  }
  const runtimeEvent = entry.data.runtimeEvent && typeof entry.data.runtimeEvent === "object"
    ? entry.data.runtimeEvent as Record<string, unknown>
    : null;
  const runtimeType = typeof runtimeEvent?.type === "string" ? runtimeEvent.type : null;
  const runtimeChunk = typeof runtimeEvent?.chunk === "string" ? runtimeEvent.chunk : "";
  const runtimeSummary = typeof runtimeEvent?.summary === "string" ? runtimeEvent.summary : "";
  const stdout = typeof entry.data.stdout === "string" ? entry.data.stdout : "";
  const stderr = typeof entry.data.stderr === "string" ? entry.data.stderr : "";
  const summary = typeof entry.data.summary === "string"
    ? entry.data.summary
    : typeof entry.message === "string"
      ? entry.message
      : "";
  const common = {
    createdAt: entry.createdAt,
    level: entry.level,
    eventType: entry.eventType,
    traceId: entry.traceId,
    taskId: entry.taskId,
    executionId: entry.executionId,
    pluginId: entry.pluginId,
    agentId: entry.agentId
  };
  const entries: LogEntry[] = [];
  if (runtimeType === "stdout" && runtimeChunk) {
    entries.push({
      id: `${entry.id}:runtime-stdout`,
      ...common,
      channel: "executor_stdout" as const,
      message: "Executor stdout",
      data: { raw: runtimeChunk }
    });
  }
  if (runtimeType === "stderr" && runtimeChunk) {
    entries.push({
      id: `${entry.id}:runtime-stderr`,
      ...common,
      channel: "executor_stderr" as const,
      message: "Executor stderr",
      data: { raw: runtimeChunk }
    });
  }
  if (runtimeType === "result" && runtimeSummary) {
    entries.push({
      id: `${entry.id}:runtime-summary`,
      ...common,
      channel: "executor_summary" as const,
      message: "Executor summary",
      data: { raw: runtimeSummary }
    });
  }
  if (stdout) {
    entries.push({
      id: `${entry.id}:stdout`,
      ...common,
      channel: "executor_stdout" as const,
      message: "Executor stdout",
      data: { raw: stdout }
    });
  }
  if (stderr) {
    entries.push({
      id: `${entry.id}:stderr`,
      ...common,
      channel: "executor_stderr" as const,
      message: "Executor stderr",
      data: { raw: stderr }
    });
  }
  if (summary) {
    entries.push({
      id: `${entry.id}:summary`,
      ...common,
      channel: "executor_summary" as const,
      message: "Executor summary",
      data: { raw: summary }
    });
  }
  return entries;
}
