import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Agent } from "../agents/agent.entity";
import { Task } from "../tasks/task.entity";

const execFileAsync = promisify(execFile);

export type CodexRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ProcessRunOptions = {
  cwd: string;
  maxBuffer: number;
  timeout: number;
};

export type ProcessRunner = {
  run(command: string, args: string[], options: ProcessRunOptions): Promise<{
    stdout: string;
    stderr: string;
  }>;
};

class ExecFileProcessRunner implements ProcessRunner {
  async run(command: string, args: string[], options: ProcessRunOptions): Promise<{
    stdout: string;
    stderr: string;
  }> {
    return execFileAsync(command, args, options);
  }
}

@Injectable()
export class CodexRunner {
  private readonly maxBuffer = 20 * 1024 * 1024;

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly processRunner: ProcessRunner = new ExecFileProcessRunner()
  ) {}

  async run(task: Task, _agent: Agent): Promise<CodexRunResult> {
    const cliBin = this.configService.get<string>("CODEX_CLI_BIN", "codex");
    const workspaceRoot = this.configService.get<string>("CODEX_WORKDIR", process.cwd());
    const timeout = Number(this.configService.get<string>("CODEX_TIMEOUT_MS", "1800000"));
    const cwd = `${workspaceRoot}/${task.repo}`;
    const instruction = task.instruction ?? "";
    const args = ["exec", "--cwd", cwd, "--branch", task.branch, instruction];

    try {
      const { stdout, stderr } = await this.processRunner.run(cliBin, args, {
        cwd,
        maxBuffer: this.maxBuffer,
        timeout
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const failure = error as {
        code?: number;
        killed?: boolean;
        message?: string;
        signal?: string;
        stdout?: string;
        stderr?: string;
      };
      const timedOut = failure.killed || failure.signal === "SIGTERM";
      return {
        exitCode: timedOut ? 124 : typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr || failure.message || (timedOut ? "Codex command timed out" : "")
      };
    }
  }
}
