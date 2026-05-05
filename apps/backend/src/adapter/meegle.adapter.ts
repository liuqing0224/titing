import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RawMeegleTask } from "./task-mapper";

const execFileAsync = promisify(execFile);

export type CliRunResult = {
  stdout: string;
  stderr: string;
};

export type CliRunner = {
  run(command: string, args: string[]): Promise<CliRunResult>;
};

export class MeegleCliError extends Error {
  readonly name = "MeegleCliError";

  constructor(
    message: string,
    readonly command: string,
    readonly args: string[],
    readonly stderr?: string
  ) {
    super(message);
  }
}

class ExecFileCliRunner implements CliRunner {
  async run(command: string, args: string[]): Promise<CliRunResult> {
    try {
      return await execFileAsync(command, args);
    } catch (error) {
      const failure = error as { message?: string; stderr?: string };
      throw new MeegleCliError(
        failure.message ?? "Meegle CLI command failed",
        command,
        args,
        failure.stderr
      );
    }
  }
}

@Injectable()
export class MeegleAdapter {
  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly cliRunner: CliRunner = new ExecFileCliRunner()
  ) {}

  async listOpenTasks(): Promise<RawMeegleTask[]> {
    const cliBin = this.configService.get<string>("MEEGLE_CLI_BIN", "meegle");
    const { stdout } = await this.cliRunner.run(cliBin, ["task", "list", "--status", "open"]);
    const listItems = this.extractTaskList(this.parseJson(stdout));
    const tasks: RawMeegleTask[] = [];

    for (const item of listItems) {
      const { stdout: detailStdout } = await this.cliRunner.run(cliBin, ["task", "get", item.id]);
      const detail = this.extractTaskDetail(this.parseJson(detailStdout));
      tasks.push(this.mergeTaskDetail(item, detail));
    }

    return tasks;
  }

  async addComment(taskId: string, text: string): Promise<void> {
    await this.cliRunner.run(this.configService.get<string>("MEEGLE_CLI_BIN", "meegle"), [
      "comment",
      "add",
      taskId,
      text
    ]);
  }

  private parseJson(stdout: string): unknown {
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error("Meegle CLI returned non-JSON output");
    }
  }

  private extractTaskList(value: unknown): RawMeegleTask[] {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeRawTask(item));
    }
    if (this.isRecord(value)) {
      const nested = value.tasks ?? value.items ?? value.data;
      if (Array.isArray(nested)) {
        return nested.map((item) => this.normalizeRawTask(item));
      }
    }
    throw new Error("Meegle task list output does not contain tasks");
  }

  private extractTaskDetail(value: unknown): Partial<RawMeegleTask> {
    const detail = this.isRecord(value) && this.isRecord(value.data) ? value.data : value;
    if (!this.isRecord(detail)) {
      return {};
    }
    return this.normalizeRawTask(detail);
  }

  private normalizeRawTask(value: unknown): RawMeegleTask {
    if (!this.isRecord(value) || typeof value.id !== "string") {
      throw new Error("Meegle task output is missing id");
    }

    return {
      id: value.id,
      title: typeof value.title === "string" ? value.title : "",
      description: typeof value.description === "string" ? value.description : null,
      repo: typeof value.repo === "string" ? value.repo : null,
      branch: typeof value.branch === "string" ? value.branch : null,
      instruction: typeof value.instruction === "string" ? value.instruction : null,
      priority: typeof value.priority === "string" ? value.priority : null
    };
  }

  private mergeTaskDetail(listItem: RawMeegleTask, detail: Partial<RawMeegleTask>): RawMeegleTask {
    return {
      id: detail.id ?? listItem.id,
      title: detail.title || listItem.title,
      description: detail.description ?? listItem.description ?? null,
      repo: detail.repo ?? listItem.repo ?? null,
      branch: detail.branch ?? listItem.branch ?? null,
      instruction: detail.instruction ?? listItem.instruction ?? null,
      priority: detail.priority ?? listItem.priority ?? null
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}
