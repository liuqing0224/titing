import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Agent } from "../agents/agent.entity";
import { ExecutionLogService } from "../execution-logs/execution-log.service";
import { AgentRuntimePlugin } from "../plugins/agent-runtime.plugin";
import {
  ExecutionContext,
  ExecutionEnginePlugin,
  ExecutionRunResult,
  ExecutionRunStage
} from "../plugins/execution-engine.plugin";
import { AGENT_RUNTIME_PLUGIN } from "../plugins/plugin.tokens";
import { resolveExecutionBranch } from "../tasks/task-branch";
import { Task } from "../tasks/task.entity";

const execFileAsync = promisify(execFile);

export type CodexRunStage = ExecutionRunStage;

export type CodexExecutionContext = ExecutionContext & { isAbsolutePath: boolean };

export type CodexRunResult = ExecutionRunResult;

type WorkflowNode = {
  name: string;
  prompt: string;
  loopEnabled: boolean;
  maxLoops: number;
};

type WorkflowCompletionStatus = {
  completed: boolean;
  reason: string;
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
export class CodexRunner implements ExecutionEnginePlugin {
  readonly engine = "codex";
  private readonly maxBuffer = 20 * 1024 * 1024;
  private readonly defaultWorkflowHeading = "## Agents 默认执行流程";
  private readonly logger = new Logger(CodexRunner.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly processRunner: ProcessRunner = new ExecFileProcessRunner(),
    @Optional()
    @Inject(AGENT_RUNTIME_PLUGIN)
    private readonly runtime?: AgentRuntimePlugin,
    @Optional()
    private readonly executionLogService?: ExecutionLogService
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
      isAbsolutePath: repoTarget.isAbsolutePath,
      agentsMdPath: path.posix.join(repoTarget.containerCwd, "AGENTS.md"),
      workflowPromptsPath: path.posix.join(repoTarget.containerCwd, "knowledge", "WORKFLOW_PROMPTS.md")
    };
  }

  async run(task: Task, agent: Agent): Promise<CodexRunResult> {
    const cliBin = this.configService.get<string>("CODEX_CLI_BIN", "codex");
    const timeout = Number(this.configService.get<string>("CODEX_TIMEOUT_MS", "1800000"));
    const workspaceRoot = this.configService.get<string>("CODEX_WORKDIR", process.cwd());
    const executionContext = this.getExecutionContext(task);
    this.logCodexExecConfig();
    this.logger.log(
      `Task ${task.id} starting on agent ${agent.id}: repo=${executionContext.repo}, branch=${executionContext.branch}, cwd=${executionContext.containerCwd}`
    );

    try {
      if (!executionContext.isAbsolutePath) {
        this.logger.log(`Task ${task.id}: preparing remote workspace at ${executionContext.hostCwd}`);
        await this.prepareRemoteWorkspace(agent, executionContext, workspaceRoot, timeout);
      }
    } catch (error) {
      return this.buildFailureResult("clone", error, executionContext, {
        branchCheckedOut: false,
        codexStarted: false,
        stdout: "",
        stderr: ""
      });
    }

    try {
      this.logger.log(`Task ${task.id}: checking out branch ${executionContext.branch}`);
      await this.runRuntimeCommand(agent, executionContext.containerCwd, "git", ["checkout", executionContext.branch], {
        cwd: executionContext.hostCwd,
        maxBuffer: this.maxBuffer,
        timeout
      });
    } catch (error) {
      if (!this.isMissingBranchCheckoutError(error)) {
        return this.buildFailureResult("checkout", error, executionContext, {
          branchCheckedOut: false,
          codexStarted: false,
          stdout: "",
          stderr: ""
        });
      }

      try {
        this.logger.warn(`Task ${task.id}: branch ${executionContext.branch} missing, creating it`);
        await this.runRuntimeCommand(
          agent,
          executionContext.containerCwd,
          "git",
          ["checkout", "-b", executionContext.branch],
          {
            cwd: executionContext.hostCwd,
            maxBuffer: this.maxBuffer,
            timeout
          }
        );
      } catch (createBranchError) {
        return this.buildFailureResult("checkout", createBranchError, executionContext, {
          branchCheckedOut: false,
          codexStarted: false,
          stdout: "",
          stderr: ""
        });
      }
    }

    try {
      this.logger.log(
        `Task ${task.id}: validating WORKFLOW_PROMPTS.md near ${executionContext.workflowPromptsPath}`
      );
      await this.ensureWorkflowPromptsExists(agent, executionContext, timeout);
    } catch (error) {
      return this.buildFailureResult("workflow-prompts", error, executionContext, {
        branchCheckedOut: true,
        codexStarted: false,
        stdout: "",
        stderr: ""
      });
    }

    let workflowNodes: WorkflowNode[];
    try {
      workflowNodes = this.buildWorkflowNodes(task, executionContext);
      this.logger.log(
        `Task ${task.id}: resolved workflow nodes ${workflowNodes
          .map((node) => `${node.name}(loop=${node.loopEnabled},maxLoops=${node.maxLoops})`)
          .join(" -> ")}`
      );
    } catch (error) {
      return this.buildFailureResult("workflow-prompts", error, executionContext, {
        branchCheckedOut: true,
        codexStarted: false,
        stdout: "",
        stderr: ""
      });
    }

    let aggregatedStdout = "";
    let aggregatedStderr = "";
    try {
      this.logger.log(
        `Task ${task.id}: starting workflow with node-local loops [${workflowNodes
          .map((node) => `${node.name} x${node.loopEnabled ? node.maxLoops : 1}`)
          .join(", ")}]`
      );

      for (const node of workflowNodes) {
        const loopCount = node.loopEnabled ? node.maxLoops : 1;
        for (let loopIndex = 1; loopIndex <= loopCount; loopIndex += 1) {
          await this.appendWorkflowLog(task.id, agent.id, "running", {
            message: `Executing workflow node ${node.name} iteration ${loopIndex}/${loopCount}`,
            metadata: {
              node: node.name,
              iteration: loopIndex,
              loopCount
            }
          });
          this.logger.log(
            `Task ${task.id}: executing node ${node.name} iteration ${loopIndex}/${loopCount}`
          );
          const [command, ...args] = this.buildCodexExecArgs(cliBin, executionContext.containerCwd, node.prompt);
          const executeResult = await this.runRuntimeCommand(
            agent,
            executionContext.containerCwd,
            command,
            args,
            {
              cwd: executionContext.hostCwd,
              maxBuffer: this.maxBuffer,
              timeout
            }
          );
          const labelPrefix = loopCount > 1 ? `${node.name} iteration ${loopIndex}/${loopCount}` : `${node.name}`;
          aggregatedStdout = this.mergeOutput(aggregatedStdout, `${labelPrefix} stdout`, executeResult.stdout);
          aggregatedStderr = this.mergeOutput(aggregatedStderr, `${labelPrefix} stderr`, executeResult.stderr);
          await this.appendWorkflowLog(task.id, agent.id, "running", {
            message: `Completed workflow node ${node.name} iteration ${loopIndex}/${loopCount}`,
            metadata: {
              node: node.name,
              iteration: loopIndex,
              loopCount,
              stdoutLength: executeResult.stdout.length,
              stderrLength: executeResult.stderr.length
            }
          });
          this.logger.log(
            `Task ${task.id}: node ${node.name} iteration ${loopIndex}/${loopCount} completed (stdout=${executeResult.stdout.length}, stderr=${executeResult.stderr.length})`
          );
        }
      }

      if (this.shouldLoopUntilTasksComplete(workflowNodes)) {
        const completionStatus = this.getWorkflowCompletionStatus(executionContext);
        this.logger.log(
          `Task ${task.id}: workflow completion check => completed=${completionStatus.completed}, reason=${completionStatus.reason}`
        );
        if (!completionStatus.completed) {
          aggregatedStderr = this.mergeOutput(
            aggregatedStderr,
            "Workflow completion check",
            completionStatus.reason
          );
          this.logger.warn(`Task ${task.id}: node-local loops exhausted without completion`);
          throw new Error(`Workflow incomplete after node-local loops: ${completionStatus.reason}`);
        }
      }

      return {
        stage: "execute",
        exitCode: 0,
        stdout: aggregatedStdout,
        stderr: aggregatedStderr,
        timedOut: false,
        branchCheckedOut: true,
        codexStarted: true,
        repo: executionContext.repo,
        branch: executionContext.branch,
        hostCwd: executionContext.hostCwd,
        containerCwd: executionContext.containerCwd,
        agentsMdPath: executionContext.agentsMdPath,
        workflowPromptsPath: executionContext.workflowPromptsPath
      };
    } catch (error) {
      await this.appendWorkflowLog(task.id, agent.id, "failed", {
        message: "Workflow execution failed",
        metadata: {
          stage: "execute",
          error: error instanceof Error ? error.message : String(error)
        }
      });
      this.logger.error(
        `Task ${task.id}: workflow execution failed at stage execute: ${error instanceof Error ? error.message : String(error)}`
      );
      return this.buildFailureResult("execute", error, executionContext, {
        branchCheckedOut: true,
        codexStarted: true,
        stdout: aggregatedStdout,
        stderr: aggregatedStderr
      });
    }
  }

  runTask(task: Task, agent: Agent): Promise<CodexRunResult> {
    return this.run(task, agent);
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
    await this.runRuntimeCommand(
      agent,
      containerParentDir,
      "git",
      ["clone", repoTarget.cloneUrl, path.posix.basename(repoTarget.containerCwd)],
      {
        cwd: workspaceRoot,
        maxBuffer: this.maxBuffer,
        timeout
      }
    );
  }

  private async runRuntimeCommand(
    agent: Agent,
    runtimeCwd: string,
    command: string,
    args: string[],
    options: ProcessRunOptions
  ): Promise<{ stdout: string; stderr: string }> {
    if (this.runtime) {
      return this.runtime.runCommand(agent, {
        cwd: runtimeCwd,
        command,
        args,
        options
      });
    }

    const dockerBin = this.configService.get<string>("DOCKER_BIN", "/usr/bin/docker");
    return this.processRunner.run(dockerBin, ["exec", "-w", runtimeCwd, agent.containerName, command, ...args], options);
  }

  private buildFailureResult(
    stage: CodexRunStage,
    error: unknown,
    executionContext: CodexExecutionContext,
    state: {
      branchCheckedOut: boolean;
      codexStarted: boolean;
      stdout: string;
      stderr: string;
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
      stdout: this.mergeOutput(state.stdout, `${stage} stdout`, failure.stdout ?? ""),
      stderr: this.mergeOutput(
        state.stderr,
        `${stage} stderr`,
        failure.stderr || failure.message || (timedOut ? "Codex command timed out" : "")
      ),
      timedOut,
      branchCheckedOut: state.branchCheckedOut,
      codexStarted: state.codexStarted,
      repo: executionContext.repo,
      branch: executionContext.branch,
      hostCwd: executionContext.hostCwd,
      containerCwd: executionContext.containerCwd,
      agentsMdPath: executionContext.agentsMdPath,
      workflowPromptsPath: executionContext.workflowPromptsPath
    };
  }

  private async appendWorkflowLog(
    taskId: string,
    agentId: string,
    status: string,
    input: {
      message: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.executionLogService) {
      return;
    }

    await this.executionLogService.append({
      taskId,
      agentId,
      status,
      message: input.message,
      metadata: input.metadata
    });
  }

  private buildWorkflowNodes(task: Task, executionContext: CodexExecutionContext): WorkflowNode[] {
    const { workflowPromptsContent, resolvedWorkflowPromptsPath } = this.loadWorkflowDefinitions(
      executionContext.hostCwd
    );
    executionContext.workflowPromptsPath = path.posix.join(
      executionContext.containerCwd,
      path.relative(executionContext.hostCwd, resolvedWorkflowPromptsPath).split(path.sep).join("/")
    );
    const orderedNodeNames = this.resolveOrderedWorkflowNodeNames(workflowPromptsContent);
    if (orderedNodeNames.length === 0) {
      throw new Error("No workflow nodes found in WORKFLOW_PROMPTS.md default workflow section");
    }

    const variables = this.buildWorkflowVariables(task, executionContext);
    return orderedNodeNames.map((nodeName) => ({
      name: nodeName,
      prompt: this.renderWorkflowPrompt(this.extractNodePromptTemplate(workflowPromptsContent, nodeName), variables),
      ...this.extractNodeLoopConfig(workflowPromptsContent, nodeName)
    }));
  }

  private loadWorkflowDefinitions(hostCwd: string): {
    workflowPromptsContent: string;
    resolvedWorkflowPromptsPath: string;
  } {
    const candidates = this.extractWorkflowPromptsCandidates(hostCwd);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return {
          workflowPromptsContent: fs.readFileSync(candidate, "utf8"),
          resolvedWorkflowPromptsPath: candidate
        };
      }
    }

    throw new Error(`Unable to locate WORKFLOW_PROMPTS.md in ${hostCwd}`);
  }

  private extractWorkflowPromptsCandidates(hostCwd: string): string[] {
    const candidates = [];
    candidates.push(path.join(hostCwd, "knowledge", "WORKFLOW_PROMPTS.md"));
    candidates.push(path.join(hostCwd, "WORKFLOW_PROMPTS.md"));
    return Array.from(new Set(candidates));
  }

  private resolveOrderedWorkflowNodeNames(workflowPromptsContent: string): string[] {
    const promptWorkflowNodes = this.tryExtractOrderedWorkflowNodeNamesFromSection(
      workflowPromptsContent,
      this.defaultWorkflowHeading
    );
    if (promptWorkflowNodes.length > 0) {
      return promptWorkflowNodes;
    }

    return this.tryExtractOrderedWorkflowNodeNamesFromSection(workflowPromptsContent, "## 推荐节点串联顺序");
  }

  private tryExtractOrderedWorkflowNodeNamesFromSection(content: string, heading: string): string[] {
    try {
      const section = this.extractMarkdownSection(content, heading, "WORKFLOW_PROMPTS.md");
      return this.extractOrderedWorkflowNodeNames(section);
    } catch {
      return [];
    }
  }

  private extractMarkdownSection(content: string, heading: string, fileName: string): string {
    const startIndex = content.indexOf(heading);
    if (startIndex === -1) {
      throw new Error(`Missing ${heading} section in ${fileName}`);
    }

    const afterStart = content.slice(startIndex);
    const nextHeadingMatch = afterStart.slice(heading.length).match(/\n##\s+/);
    const sectionEndIndex =
      nextHeadingMatch && typeof nextHeadingMatch.index === "number"
        ? heading.length + nextHeadingMatch.index + 1
        : afterStart.length;
    return afterStart.slice(0, sectionEndIndex).trim();
  }

  private extractOrderedWorkflowNodeNames(agentsDefaultWorkflow: string): string[] {
    return agentsDefaultWorkflow
      .split("\n")
      .map((line) => line.match(/^\s*(?:-\s+|(?:\d+)\.\s+)`([^`]+)`\s*$/)?.[1] ?? null)
      .filter((value): value is string => value !== null)
      .filter((value) => /^[A-Za-z][A-Za-z0-9]*$/.test(value))
  }

  private extractNodePromptTemplate(workflowPromptsContent: string, nodeName: string): string {
    const section = this.extractNodeSection(workflowPromptsContent, nodeName);
    const heading = `### ${nodeName}`;
    const afterHeading = section.slice(heading.length);
    const codeBlockMatch = afterHeading.match(/```text\n([\s\S]*?)\n```/);
    if (!codeBlockMatch?.[1]) {
      throw new Error(`Missing prompt template for ${nodeName} in WORKFLOW_PROMPTS.md`);
    }

    return codeBlockMatch[1].trim();
  }

  private extractNodeLoopConfig(
    workflowPromptsContent: string,
    nodeName: string
  ): Pick<WorkflowNode, "loopEnabled" | "maxLoops"> {
    const section = this.extractNodeSection(workflowPromptsContent, nodeName);
    const loopEnabled =
      section.match(/-\s+`loopEnabled:\s*(true|false)`/)?.[1].trim().toLowerCase() === "true";
    const maxLoops = Number(section.match(/-\s+`maxLoops:\s*(\d+)`/)?.[1] ?? "1");
    return {
      loopEnabled,
      maxLoops: Number.isFinite(maxLoops) && maxLoops > 0 ? maxLoops : 1
    };
  }

  private extractNodeSection(workflowPromptsContent: string, nodeName: string): string {
    const heading = `### ${nodeName}`;
    const startIndex = workflowPromptsContent.indexOf(heading);
    if (startIndex === -1) {
      throw new Error(`Missing ${heading} section in WORKFLOW_PROMPTS.md`);
    }

    const afterHeading = workflowPromptsContent.slice(startIndex + heading.length);
    const nextHeadingMatch = afterHeading.match(/\n###\s+/);
    const sectionEndIndex =
      nextHeadingMatch && typeof nextHeadingMatch.index === "number"
        ? startIndex + heading.length + nextHeadingMatch.index + 1
        : workflowPromptsContent.length;
    return workflowPromptsContent.slice(startIndex, sectionEndIndex).trim();
  }

  private buildWorkflowVariables(
    task: Task,
    executionContext: CodexExecutionContext
  ): Record<string, string> {
    const projectName = path.posix.basename(executionContext.containerCwd);
    return {
      taskId: task.id,
      taskTitle: task.title ?? task.id,
      taskPrompt: task.instruction ?? "",
      gitBranch: executionContext.branch,
      gitBaseBranch: "main",
      gitWorktree: executionContext.branch,
      gitWorktreePath: executionContext.containerCwd,
      projectId: projectName,
      projectName,
      projectGitUrl: executionContext.cloneUrl ?? task.repo,
      projectDefaultBranch: "main"
    };
  }

  private renderWorkflowPrompt(template: string, variables: Record<string, string>): string {
    return template.replace(/{{(\w+)}}/g, (_, key: string) => variables[key] ?? "");
  }

  private shouldLoopUntilTasksComplete(workflowNodes: WorkflowNode[]): boolean {
    return workflowNodes.some((node) => node.loopEnabled && node.maxLoops > 1);
  }

  private getWorkflowCompletionStatus(executionContext: CodexExecutionContext): WorkflowCompletionStatus {
    const taskResultPath = path.join(
      executionContext.hostCwd,
      "docs",
      executionContext.branch,
      "taskResult.md"
    );
    if (!fs.existsSync(taskResultPath)) {
      return {
        completed: false,
        reason: `Missing ${path.relative(executionContext.hostCwd, taskResultPath)}`
      };
    }

    const taskResultFirstLine = this.readFirstLine(taskResultPath);
    if (taskResultFirstLine !== "已完成") {
      return {
        completed: false,
        reason: `${path.relative(executionContext.hostCwd, taskResultPath)} first line is "${taskResultFirstLine || "(empty)"}"`
      };
    }

    const latestOpenSpecTasksPath = this.findLatestOpenSpecTasksPath(executionContext.hostCwd);
    if (!latestOpenSpecTasksPath) {
      return {
        completed: true,
        reason: "taskResult.md marked complete and no OpenSpec tasks.md found"
      };
    }

    const uncheckedTaskIds = this.extractUncheckedOpenSpecTaskIds(latestOpenSpecTasksPath);
    if (uncheckedTaskIds.length > 0) {
      return {
        completed: false,
        reason: `${path.relative(executionContext.hostCwd, latestOpenSpecTasksPath)} has unchecked tasks: ${uncheckedTaskIds.join(", ")}`
      };
    }

    return {
      completed: true,
      reason: `${path.relative(executionContext.hostCwd, latestOpenSpecTasksPath)} fully completed`
    };
  }

  private readFirstLine(filePath: string): string {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
  }

  private findLatestOpenSpecTasksPath(hostCwd: string): string | null {
    const changesDir = path.join(hostCwd, "openspec", "changes");
    if (!fs.existsSync(changesDir)) {
      return null;
    }

    const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
    for (const entry of fs.readdirSync(changesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const taskFilePath = path.join(changesDir, entry.name, "tasks.md");
      if (!fs.existsSync(taskFilePath)) {
        continue;
      }

      candidates.push({
        filePath: taskFilePath,
        mtimeMs: fs.statSync(taskFilePath).mtimeMs
      });
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0].filePath;
  }

  private extractUncheckedOpenSpecTaskIds(taskFilePath: string): string[] {
    return fs
      .readFileSync(taskFilePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^- \[ \] ([0-9]+(?:\.[0-9]+)*)\b/)?.[1] ?? null)
      .filter((value): value is string => Boolean(value));
  }

  private buildCodexExecArgs(
    cliBin: string,
    containerCwd: string,
    instruction: string
  ): string[] {
    const provider = this.configService.get<string | undefined>("CODEX_MODEL_PROVIDER", undefined);
    const model = this.configService.get<string | undefined>("CODEX_MODEL", undefined);
    const reasoningEffort = this.configService.get<string | undefined>(
      "CODEX_MODEL_REASONING_EFFORT",
      undefined
    );
    const args = [
      cliBin,
      "exec",
      ...this.getUserConfigArgs(),
      "--ignore-rules",
      "--sandbox",
      "danger-full-access",
      "-C",
      containerCwd,
      instruction
    ];

    if (model) {
      args.splice(args.length - 1, 0, "-m", model);
    }

    if (reasoningEffort) {
      args.splice(args.length - 1, 0, "-c", `model_reasoning_effort=${this.toTomlString(reasoningEffort)}`);
    }

    if (!provider) {
      return args;
    }

    const baseUrl = this.configService.get<string>("CODEX_MODEL_BASE_URL", "https://right.codes/codex/v1");
    const wireApi = this.configService.get<string>("CODEX_MODEL_WIRE_API", "responses");
    const requiresOpenAiAuth = this.configService.get<string>("CODEX_MODEL_REQUIRES_OPENAI_AUTH", "true");

    args.splice(
      args.length - 1,
      0,
      "-c",
      `model_provider=${this.toTomlString(provider)}`,
      "-c",
      `model_providers.${provider}.name=${this.toTomlString(provider)}`,
      "-c",
      `model_providers.${provider}.base_url=${this.toTomlString(baseUrl)}`,
      "-c",
      `model_providers.${provider}.wire_api=${this.toTomlString(wireApi)}`,
      "-c",
      `model_providers.${provider}.requires_openai_auth=${requiresOpenAiAuth}`
    );

    return args;
  }

  private getUserConfigArgs(): string[] {
    const rawValue = this.configService.get<string>("CODEX_IGNORE_USER_CONFIG", "false");
    return rawValue === "true" ? ["--ignore-user-config"] : [];
  }

  private logCodexExecConfig(): void {
    const ignoreUserConfig = this.getUserConfigArgs().includes("--ignore-user-config");
    const provider = this.configService.get<string | undefined>("CODEX_MODEL_PROVIDER", undefined);
    const model = this.configService.get<string | undefined>("CODEX_MODEL", undefined);
    this.logger.log(
      `Codex exec config: ignoreUserConfig=${String(ignoreUserConfig)}, model=${model ?? "default"}, provider=${provider ?? "default"}`
    );
  }

  private toTomlString(value: string): string {
    return JSON.stringify(value);
  }

  private isMissingBranchCheckoutError(error: unknown): boolean {
    const output = this.readCheckoutErrorText(error).toLowerCase();
    return (
      output.includes("pathspec") ||
      output.includes("did not match any file(s) known to git") ||
      output.includes("not a commit")
    );
  }

  private readCheckoutErrorText(error: unknown): string {
    if (!(error instanceof Error)) {
      return "";
    }

    const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    return [error.message, stderr, stdout].filter(Boolean).join("\n");
  }

  private async ensureWorkflowPromptsExists(
    agent: Agent,
    executionContext: CodexExecutionContext,
    timeout: number
  ): Promise<void> {
    await this.runRuntimeCommand(
      agent,
      executionContext.containerCwd,
      "sh",
      ["-lc", "test -s 'knowledge/WORKFLOW_PROMPTS.md' || test -s 'WORKFLOW_PROMPTS.md'"],
      {
        cwd: executionContext.hostCwd,
        maxBuffer: this.maxBuffer,
        timeout
      }
    );
  }

  private mergeOutput(current: string, label: string, next: string): string {
    if (!next) {
      return current;
    }
    const chunk = `${label}:\n${next}`;
    return current ? `${current}\n\n${chunk}` : chunk;
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
