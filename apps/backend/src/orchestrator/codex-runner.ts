import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Agent } from "../agents/agent.entity";
import { resolveExecutionBranch } from "../tasks/task-branch";
import { Task } from "../tasks/task.entity";

const execFileAsync = promisify(execFile);

export type CodexRunStage = "clone" | "checkout" | "codex";

export type CodexExecutionContext = {
  repo: string;
  branch: string;
  hostCwd: string;
  containerCwd: string;
  cloneUrl: string | null;
  isAbsolutePath: boolean;
};

export type CodexRunResult = {
  stage: CodexRunStage;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  branchCheckedOut: boolean;
  codexStarted: boolean;
  repo: string;
  branch: string;
  hostCwd: string;
  containerCwd: string;
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

  getExecutionContext(task: Task): CodexExecutionContext {
    const workspaceRoot = this.configService.get<string>("CODEX_WORKDIR", process.cwd());
    const repoTarget = this.resolveRepoTarget(task.repo, workspaceRoot);

    return {
      repo: repoTarget.repo,
      branch: resolveExecutionBranch(task.branch),
      hostCwd: repoTarget.hostCwd,
      containerCwd: repoTarget.containerCwd,
      cloneUrl: repoTarget.cloneUrl,
      isAbsolutePath: repoTarget.isAbsolutePath
    };
  }

  async run(task: Task, _agent: Agent): Promise<CodexRunResult> {
    const cliBin = this.configService.get<string>("CODEX_CLI_BIN", "codex");
    const dockerBin = this.configService.get<string>("DOCKER_BIN", "/usr/bin/docker");
    const timeout = Number(this.configService.get<string>("CODEX_TIMEOUT_MS", "1800000"));
    const workspaceRoot = this.configService.get<string>("CODEX_WORKDIR", process.cwd());
    const executionContext = this.getExecutionContext(task);
    const instruction = this.buildCodexInstruction(task.instruction ?? "");

    try {
      if (!executionContext.isAbsolutePath) {
        await this.prepareRemoteWorkspace(dockerBin, _agent, executionContext, workspaceRoot, timeout);
      }
    } catch (error) {
      return this.buildFailureResult("clone", error, executionContext, {
        branchCheckedOut: false,
        codexStarted: false
      });
    }

    try {
      await this.processRunner.run(
        dockerBin,
        ["exec", "-w", executionContext.containerCwd, _agent.containerName, "git", "checkout", executionContext.branch],
        {
          cwd: executionContext.hostCwd,
          maxBuffer: this.maxBuffer,
          timeout
        }
      );
    } catch (error) {
      try {
        await this.processRunner.run(
          dockerBin,
          ["exec", "-w", executionContext.containerCwd, _agent.containerName, "git", "checkout", "-b", executionContext.branch],
          {
            cwd: executionContext.hostCwd,
            maxBuffer: this.maxBuffer,
            timeout
          }
        );
      } catch (createBranchError) {
        return this.buildFailureResult("checkout", createBranchError, executionContext, {
          branchCheckedOut: false,
          codexStarted: false
        });
      }
    }

    try {
      const { stdout, stderr } = await this.processRunner.run(
        dockerBin,
        [
          "exec",
          "-w",
          executionContext.containerCwd,
          _agent.containerName,
          cliBin,
          "exec",
          "-C",
          executionContext.containerCwd,
          "--dangerously-bypass-approvals-and-sandbox",
          instruction
        ],
        {
          cwd: executionContext.hostCwd,
          maxBuffer: this.maxBuffer,
          timeout
        }
      );
      return {
        stage: "codex",
        exitCode: 0,
        stdout,
        stderr,
        timedOut: false,
        branchCheckedOut: true,
        codexStarted: true,
        repo: executionContext.repo,
        branch: executionContext.branch,
        hostCwd: executionContext.hostCwd,
        containerCwd: executionContext.containerCwd
      };
    } catch (error) {
      return this.buildFailureResult("codex", error, executionContext, {
        branchCheckedOut: true,
        codexStarted: true
      });
    }
  }

  private resolveRepoTarget(
    rawRepo: string,
    workspaceRoot: string
  ): {
    repo: string;
    isAbsolutePath: boolean;
    hostCwd: string;
    containerCwd: string;
    cloneUrl: string | null;
  } {
    const normalizedRepo = this.normalizeRepoValue(rawRepo);
    if (normalizedRepo.startsWith("/")) {
      return {
        repo: normalizedRepo,
        isAbsolutePath: true,
        hostCwd: normalizedRepo,
        containerCwd: normalizedRepo,
        cloneUrl: null
      };
    }

    if (this.looksLikeRemoteRepo(normalizedRepo)) {
      const relativeDir = this.getRemoteWorkspaceDir(normalizedRepo);
      return {
        repo: normalizedRepo,
        isAbsolutePath: false,
        hostCwd: path.join(workspaceRoot, relativeDir),
        containerCwd: path.posix.join("/workspace", relativeDir.split(path.sep).join("/")),
        cloneUrl: normalizedRepo
      };
    }

    return {
      repo: normalizedRepo,
      isAbsolutePath: false,
      hostCwd: path.join(workspaceRoot, normalizedRepo),
      containerCwd: path.posix.join("/workspace", normalizedRepo.split(path.sep).join("/")),
      cloneUrl: null
    };
  }

  private async prepareRemoteWorkspace(
    dockerBin: string,
    agent: Agent,
    repoTarget: CodexExecutionContext,
    workspaceRoot: string,
    timeout: number
  ): Promise<void> {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    if (!repoTarget.cloneUrl) {
      return;
    }
    if (fs.existsSync(repoTarget.hostCwd)) {
      return;
    }

    const parentDir = path.dirname(repoTarget.hostCwd);
    fs.mkdirSync(parentDir, { recursive: true });
    const containerParentDir = path.posix.dirname(repoTarget.containerCwd);
    await this.processRunner.run(
      dockerBin,
      [
        "exec",
        "-w",
        containerParentDir,
        agent.containerName,
        "git",
        "clone",
        repoTarget.cloneUrl,
        path.posix.basename(repoTarget.containerCwd)
      ],
      {
        cwd: workspaceRoot,
        maxBuffer: this.maxBuffer,
        timeout
      }
    );
  }

  private buildFailureResult(
    stage: CodexRunStage,
    error: unknown,
    executionContext: CodexExecutionContext,
    state: {
      branchCheckedOut: boolean;
      codexStarted: boolean;
    }
  ): CodexRunResult {
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
      stage,
      exitCode: timedOut ? 124 : typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr || failure.message || (timedOut ? "Codex command timed out" : ""),
      timedOut,
      branchCheckedOut: state.branchCheckedOut,
      codexStarted: state.codexStarted,
      repo: executionContext.repo,
      branch: executionContext.branch,
      hostCwd: executionContext.hostCwd,
      containerCwd: executionContext.containerCwd
    };
  }

  private buildCodexInstruction(instruction: string): string {
    return [
      "YOLO execution mode.",
      "First produce a concise internal execution checklist based on the task, then immediately execute every checklist item end-to-end.",
      "Do not ask the user any clarifying questions.",
      "Do not pause for approval, design review, or confirmation.",
      "Do not use brainstorming or approval-gated workflows from the repository.",
      "If details are missing, make reasonable assumptions, keep public APIs stable where possible, and continue.",
      "You must modify code and tests directly when needed, verify your work, and then return a brief final summary.",
      "",
      "Task:",
      instruction
    ].join("\n");
  }

  private normalizeRepoValue(rawRepo: string): string {
    const trimmed = rawRepo.trim();
    const markdownMailtoWithSuffix = trimmed.match(/^\[(.+?)\]\(mailto:[^)]+\)(:.+)$/);
    if (markdownMailtoWithSuffix) {
      return `${markdownMailtoWithSuffix[1]}${markdownMailtoWithSuffix[2]}`;
    }

    const markdownLink = trimmed.match(/^\[(.+?)\]\((.+?)\)$/);
    if (!markdownLink) {
      return trimmed;
    }

    const [, label, target] = markdownLink;
    if (target.startsWith("mailto:")) {
      return label;
    }
    return target.trim();
  }

  private looksLikeRemoteRepo(repo: string): boolean {
    return /^(git@|ssh:\/\/|https?:\/\/|git:\/\/)/i.test(repo);
  }

  private getRemoteWorkspaceDir(repo: string): string {
    const sshMatch = repo.match(/^[^@]+@[^:]+:(.+)$/);
    const urlMatch = repo.match(/^[a-z]+:\/\/[^/]+\/(.+)$/i);
    const repoPath = (sshMatch?.[1] ?? urlMatch?.[1] ?? repo)
      .replace(/\/+/g, "/")
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "");

    return repoPath
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"))
      .join(path.sep);
  }
}
