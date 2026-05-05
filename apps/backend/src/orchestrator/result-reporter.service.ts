import { Injectable } from "@nestjs/common";
import { MeegleAdapter } from "../adapter/meegle.adapter";
import { Task } from "../tasks/task.entity";
import { CodexRunResult } from "./codex-runner";

@Injectable()
export class ResultReporterService {
  constructor(private readonly meegleAdapter: MeegleAdapter) {}

  async reportSuccess(task: Task, result: CodexRunResult): Promise<void> {
    if (!task.externalId) {
      return;
    }
    await this.meegleAdapter.addComment(task.externalId, this.buildComment("completed", task, result));
  }

  async reportFailure(task: Task, result: CodexRunResult): Promise<void> {
    if (!task.externalId) {
      return;
    }
    await this.meegleAdapter.addComment(task.externalId, this.buildComment("failed", task, result));
  }

  private buildComment(status: "completed" | "failed", task: Task, result: CodexRunResult): string {
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
