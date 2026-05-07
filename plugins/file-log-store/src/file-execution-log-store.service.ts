import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ExecutionLogStorePlugin, AppendExecutionLogInput } from "../../../packages/core/src/plugins/execution-log-store.plugin";
import { EVENT_BUS_PLUGIN } from "../../../packages/core/src/plugins/plugin.tokens";
import { EventBusPlugin } from "../../../packages/core/src/plugins/event-bus.plugin";
import { ExecutionLog } from "../../../packages/core/src/execution-logs/execution-log.entity";

@Injectable()
export class FileExecutionLogStoreService implements ExecutionLogStorePlugin {
  private readonly logDirectory = resolve(process.env.EXECUTION_LOG_DIR ?? join(process.cwd(), "../../logs"));

  constructor(
    @Optional()
    @Inject(EVENT_BUS_PLUGIN)
    private readonly eventBus?: EventBusPlugin
  ) {}

  async append(input: AppendExecutionLogInput): Promise<ExecutionLog> {
    const log: ExecutionLog = {
      id: `log-${randomUUID()}`,
      taskId: input.taskId,
      agentId: input.agentId ?? null,
      status: input.status,
      message: input.message,
      metadata: input.metadata ?? null,
      createdAt: new Date()
    };

    await mkdir(this.logDirectory, { recursive: true });
    await appendFile(this.getTaskLogPath(input.taskId), `${JSON.stringify(log)}\n`, "utf8");
    this.eventBus?.publishExecutionLog(log.id, log.taskId, log.status, log.agentId);
    return log;
  }

  async listByTask(taskId: string): Promise<ExecutionLog[]> {
    try {
      const content = await readFile(this.getTaskLogPath(taskId), "utf8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => this.parseExecutionLog(line))
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    } catch (error) {
      if (this.isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  private getTaskLogPath(taskId: string): string {
    return join(this.logDirectory, `${encodeURIComponent(taskId)}.jsonl`);
  }

  private parseExecutionLog(line: string): ExecutionLog {
    const parsed = JSON.parse(line) as Omit<ExecutionLog, "createdAt"> & { createdAt: string };
    return {
      ...parsed,
      createdAt: new Date(parsed.createdAt)
    };
  }

  private isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}
