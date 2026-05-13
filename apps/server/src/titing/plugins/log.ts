import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  ExecutionLogRecord,
  LogEntry,
  LogPlugin,
  ObservabilityEvent,
  PluginHealth
} from "@titing/plugin-api";

type StoredLogEntry = Omit<LogEntry, "createdAt"> & { createdAt: string };

export class RootLogsPlugin implements LogPlugin {
  readonly id = "root-logs";
  readonly kind = "log" as const;
  readonly priority = 100;
  readonly capabilities = ["default"];

  private readonly listeners = new Set<(event: ObservabilityEvent) => void>();
  private readonly recent: ObservabilityEvent[] = [];
  private readonly root = resolve(process.cwd(), "logs");

  async health(): Promise<PluginHealth> {
    return { healthy: true, message: `Root file log plugin active: ${this.root}` };
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(join(this.root, "system"), { recursive: true });
    await mkdir(join(this.root, "tasks"), { recursive: true });
    await mkdir(join(this.root, "traces"), { recursive: true });
  }

  async append(entry: LogEntry): Promise<void> {
    await this.ensurePaths(entry);
    const stored = serializeEntry(entry);
    const line = `${JSON.stringify(stored)}\n`;
    const writes = [appendFile(systemLogPath(this.root), line, "utf8")];
    if (entry.taskId) {
      writes.push(appendFile(taskLogPath(this.root, entry.taskId), line, "utf8"));
    }
    if (entry.traceId) {
      writes.push(appendFile(traceLogPath(this.root, entry.traceId), line, "utf8"));
    }
    if (entry.taskId && entry.executionId) {
      writes.push(appendFile(executionLogPath(this.root, entry.taskId, entry.executionId), line, "utf8"));
    }
    if (entry.taskId && entry.executionId && isExecutorChannel(entry.channel)) {
      writes.push(appendFile(executorOutputPath(this.root, entry.taskId, entry.executionId, entry.channel), formatRawLog(entry), "utf8"));
    }
    await Promise.all(writes);

    if (entry.channel === "event") {
      const event = toObservabilityEvent(entry);
      this.recent.push(event);
      if (this.recent.length > 200) {
        this.recent.shift();
      }
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  async listByTask(taskId: string, limit = 500): Promise<ExecutionLogRecord[]> {
    return readExecutionLogFile(taskLogPath(this.root, taskId), limit);
  }

  async listByTrace(traceId: string, limit = 500): Promise<ExecutionLogRecord[]> {
    return readExecutionLogFile(traceLogPath(this.root, traceId), limit);
  }

  async recentEvents(limit = 200): Promise<ObservabilityEvent[]> {
    return this.snapshotEvents(limit);
  }

  snapshotEvents(limit = 200): ObservabilityEvent[] {
    return this.recent.slice(-limit);
  }

  subscribe(listener: (event: ObservabilityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async ensurePaths(entry: LogEntry): Promise<void> {
    await mkdir(join(this.root, "system"), { recursive: true });
    if (entry.taskId) {
      await mkdir(join(this.root, "tasks", entry.taskId, "executor"), { recursive: true });
    }
    if (entry.traceId) {
      await mkdir(join(this.root, "traces", entry.traceId), { recursive: true });
    }
  }

}

function serializeEntry(entry: LogEntry): StoredLogEntry {
  return {
    ...entry,
    createdAt: entry.createdAt.toISOString()
  };
}

function toObservabilityEvent(entry: LogEntry): ObservabilityEvent {
  return {
    id: entry.id,
    schemaVersion: "2026-05-11",
    traceId: entry.traceId ?? "system",
    taskId: entry.taskId,
    executionId: entry.executionId ?? undefined,
    pluginId: entry.pluginId,
    agentId: entry.agentId,
    eventType: entry.eventType,
    message: entry.message,
    data: entry.data,
    createdAt: entry.createdAt
  };
}

async function readExecutionLogFile(path: string, limit: number): Promise<ExecutionLogRecord[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredLogEntry)
      .filter((entry) => entry.channel === "execution_log")
      .slice(-limit)
      .map((entry) => ({
        id: entry.id,
        taskId: entry.taskId ?? "",
        executionId: entry.executionId ?? null,
        eventType: entry.eventType,
        message: entry.message,
        data: entry.data,
        createdAt: new Date(entry.createdAt)
      }));
  } catch {
    return [];
  }
}

function isExecutorChannel(channel: LogEntry["channel"]): boolean {
  return channel === "executor_stdout" || channel === "executor_stderr" || channel === "executor_summary";
}

function systemLogPath(root: string): string {
  return join(root, "system", "system.log");
}

function taskLogPath(root: string, taskId: string): string {
  return join(root, "tasks", taskId, "task.log");
}

function traceLogPath(root: string, traceId: string): string {
  return join(root, "traces", traceId, "trace.log");
}

function executionLogPath(root: string, taskId: string, executionId: string): string {
  return join(root, "tasks", taskId, `execution-${executionId}.log`);
}

function executorOutputPath(root: string, taskId: string, executionId: string, channel: LogEntry["channel"]): string {
  const suffix = channel === "executor_stdout"
    ? "stdout"
    : channel === "executor_stderr"
      ? "stderr"
      : "summary";
  return join(root, "tasks", taskId, "executor", `${executionId}-${suffix}.log`);
}

function formatRawLog(entry: LogEntry): string {
  const raw = typeof entry.data.raw === "string" ? entry.data.raw : entry.message;
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}
