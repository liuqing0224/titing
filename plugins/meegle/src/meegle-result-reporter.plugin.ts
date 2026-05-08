import { Injectable } from "@nestjs/common";
import { ExecutionRunResult, TaskRecord, TaskResultReporterPlugin } from "@autodev-agent/plugin-api";
import { MeegleAdapter } from "./meegle.adapter";

@Injectable()
export class MeegleResultReporterPlugin implements TaskResultReporterPlugin {
  readonly source = "meegle";

  constructor(private readonly meegleAdapter: MeegleAdapter) {}

  async reportSuccess(task: TaskRecord, result: ExecutionRunResult): Promise<void> {
    if (!task.externalId) {
      return;
    }
    await this.meegleAdapter.addComment(task.externalId, this.buildComment("completed", task, result));
  }

  async reportFailure(task: TaskRecord, result: ExecutionRunResult): Promise<void> {
    if (!task.externalId) {
      return;
    }
    await this.meegleAdapter.addComment(task.externalId, this.buildComment("failed", task, result));
  }

  private buildComment(status: "completed" | "failed", task: TaskRecord, result: ExecutionRunResult): string {
    const headline =
      status === "completed"
        ? `AutoDev Agent completed task ${task.id}`
        : `AutoDev Agent failed task ${task.id}`;
    const stderr = result.stderr ? `\nstderr:\n${this.truncate(result.stderr)}` : "";
    const stdout = result.stdout ? `\nstdout:\n${this.truncate(result.stdout)}` : "";

    return `${headline}\nexitCode: ${result.exitCode}${stderr}${stdout}`;
  }

  private truncate(value: string): string {
    return value.length > 2000 ? `${value.slice(0, 2000)}\n...[truncated]` : value;
  }
}
