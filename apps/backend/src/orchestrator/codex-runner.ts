import fs from "node:fs";
import path from "node:path";
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
    const dockerBin = this.configService.get<string>("DOCKER_BIN", "/usr/bin/docker");
    const workspaceRoot = this.configService.get<string>("CODEX_WORKDIR", process.cwd());
    const timeout = Number(this.configService.get<string>("CODEX_TIMEOUT_MS", "1800000"));
    const repoTarget = this.resolveRepoTarget(task.repo, workspaceRoot);
    const hostCwd = repoTarget.hostCwd;
    const containerCwd = repoTarget.containerCwd;
    const instruction = task.instruction ?? "";

    try {
      if (!repoTarget.isAbsolutePath) {
        await this.prepareRemoteWorkspace(dockerBin, _agent, repoTarget, workspaceRoot, timeout);
      }
      await this.processRunner.run(
        dockerBin,
        ["exec", "-w", containerCwd, _agent.containerName, "git", "checkout", task.branch],
        {
          cwd: hostCwd,
          maxBuffer: this.maxBuffer,
          timeout
        }
      );
      const { stdout, stderr } = await this.processRunner.run(
        dockerBin,
        [
          "exec",
          "-w",
          containerCwd,
          _agent.containerName,
          cliBin,
          "exec",
          "-C",
          containerCwd,
          "--dangerously-bypass-approvals-and-sandbox",
          instruction
        ],
        {
          cwd: hostCwd,
          maxBuffer: this.maxBuffer,
          timeout
        }
      );
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

  private resolveRepoTarget(
    rawRepo: string,
    workspaceRoot: string
  ): {
    isAbsolutePath: boolean;
    hostCwd: string;
    containerCwd: string;
    cloneUrl: string | null;
  } {
    const normalizedRepo = this.normalizeRepoValue(rawRepo);
    if (normalizedRepo.startsWith("/")) {
      return {
        isAbsolutePath: true,
        hostCwd: normalizedRepo,
        containerCwd: normalizedRepo,
        cloneUrl: null
      };
    }

    if (this.looksLikeRemoteRepo(normalizedRepo)) {
      const relativeDir = this.getRemoteWorkspaceDir(normalizedRepo);
      return {
        isAbsolutePath: false,
        hostCwd: path.join(workspaceRoot, relativeDir),
        containerCwd: path.posix.join("/workspace", relativeDir.split(path.sep).join("/")),
        cloneUrl: normalizedRepo
      };
    }

    return {
      isAbsolutePath: false,
      hostCwd: path.join(workspaceRoot, normalizedRepo),
      containerCwd: path.posix.join("/workspace", normalizedRepo.split(path.sep).join("/")),
      cloneUrl: null
    };
  }

  private async prepareRemoteWorkspace(
    dockerBin: string,
    agent: Agent,
    repoTarget: {
      hostCwd: string;
      containerCwd: string;
      cloneUrl: string | null;
    },
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
