import fs from "node:fs";
import path from "node:path";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Agent } from "../../../packages/core/src/agents/agent.entity";
import { ExecutionLogService } from "../../../packages/core/src/execution-logs/execution-log.service";
import { AgentRuntimePlugin, ProcessRunOptions } from "../../../packages/core/src/plugins/agent-runtime.plugin";
import {
  ExecutionContext,
  ExecutionEnginePlugin,
  ExecutionRunResult,
  ExecutionRunStage
} from "../../../packages/core/src/plugins/execution-engine.plugin";
import { AGENT_RUNTIME_PLUGIN } from "../../../packages/core/src/plugins/plugin.tokens";
import { resolveExecutionBranch } from "../../../packages/core/src/tasks/task-branch";
import { Task } from "../../../packages/core/src/tasks/task.entity";

export type CursorRunStage = ExecutionRunStage;

export type CursorExecutionContext = ExecutionContext & { isAbsolutePath: boolean };

export type CursorRunResult = ExecutionRunResult;

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

@Injectable()
export class CursorRunner implements ExecutionEnginePlugin {
  readonly engine = "cursor";
  private readonly maxBuffer = 20 * 1024 * 1024;
  private readonly defaultWorkflowHeading = "## Agents 默认执行流程";
  private readonly logger = new Logger(CursorRunner.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(AGENT_RUNTIME_PLUGIN)
    private readonly runtime?: AgentRuntimePlugin,
    @Optional()
    private readonly executionLogService?: ExecutionLogService
  ) {}

  private resolveWorkspaceRoot(): string {
    const cursorRoot = this.configService.get<string | undefined>("CURSOR_WORKDIR", undefined);
    if (cursorRoot !== undefined && cursorRoot !== "") {
      return cursorRoot;
    }
    return this.configService.get<string>("CODEX_WORKDIR", process.cwd());
  }

  getExecutionContext(task: Task): CursorExecutionContext {
    const workspaceRoot = this.resolveWorkspaceRoot();
    const repoTarget = this.resolveRepoTarget(task, workspaceRoot);

    return {
      repo: repoTarget.repo,
      branch: resolveExecutionBranch(task.branch),
      repoRoot: repoTarget.repoRoot,
      worktreePath: repoTarget.worktreePath,
      cloneUrl: repoTarget.cloneUrl,
      isAbsolutePath: repoTarget.isAbsolutePath,
      agentsMdPath: path.posix.join(repoTarget.worktreePath, "AGENTS.md"),
      workflowPromptsPath: path.posix.join(repoTarget.worktreePath, "knowledge", "WORKFLOW_PROMPTS.md")
    };
  }

  async run(task: Task, agent: Agent): Promise<CursorRunResult> {
    const cliBin = this.configService.get<string>("CURSOR_CLI_BIN", "agent");
    const timeout = Number(this.configService.get<string>("CURSOR_TIMEOUT_MS", "1800000"));
    const workspaceRoot = this.resolveWorkspaceRoot();
    const executionContext = this.getExecutionContext(task);
    this.logger.log(
      `[execution-engine] engine=${this.engine} task=${task.id} agent=${agent.id} cliBin=${cliBin}`
    );
    this.logCursorAgentConfig();
    this.logger.log(
      `Task ${task.id} starting on agent ${agent.id}: repo=${executionContext.repo}, branch=${executionContext.branch}, worktree=${executionContext.worktreePath}`
    );

    try {
      this.logger.log(`Task ${task.id}: preparing git worktree at ${executionContext.worktreePath}`);
      await this.prepareWorktreeWorkspace(task, agent, executionContext, workspaceRoot, timeout);
    } catch (error) {
      return this.buildFailureResult("clone", error, executionContext, {
        branchCheckedOut: false,
        codexStarted: false,
        stdout: "",
        stderr: ""
      });
    }

    try {
      this.logger.log(`Task ${task.id}: worktree ready on branch ${executionContext.branch}`);
    } catch (error) {
      return this.buildFailureResult("checkout", error, executionContext, {
        branchCheckedOut: false,
        codexStarted: false,
        stdout: "",
        stderr: ""
      });
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
          const [command, ...args] = this.buildCursorAgentArgs(cliBin, executionContext.worktreePath, node.prompt);
          const executeResult = await this.runRuntimeCommand(
            agent,
            executionContext.worktreePath,
            command,
            args,
            {
              cwd: executionContext.repoRoot,
              maxBuffer: this.maxBuffer,
              timeout
            },
            {
              onStdoutChunk: (chunk) =>
                this.appendStreamChunkLog(task.id, agent.id, "stdout", node.name, loopIndex, loopCount, chunk),
              onStderrChunk: (chunk) =>
                this.appendStreamChunkLog(task.id, agent.id, "stderr", node.name, loopIndex, loopCount, chunk)
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
        repoRoot: executionContext.repoRoot,
        worktreePath: executionContext.worktreePath,
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

  runTask(task: Task, agent: Agent): Promise<CursorRunResult> {
    return this.run(task, agent);
  }

  private resolveRepoTarget(
    task: Task,
    workspaceRoot: string
  ): {
    repo: string;
    isAbsolutePath: boolean;
    repoRoot: string;
    worktreePath: string;
    cloneUrl: string | null;
  } {
    const rawRepo = task.repo;
    const normalizedRepo = this.normalizeRepoValue(rawRepo);
    const worktreeBaseDir = path.join(workspaceRoot, ".worktrees");
    const worktreePath = path.join(worktreeBaseDir, this.sanitizeWorktreeSegment(normalizedRepo), task.id);
    if (normalizedRepo.startsWith("/")) {
      return {
        repo: normalizedRepo,
        isAbsolutePath: true,
        repoRoot: normalizedRepo,
        worktreePath,
        cloneUrl: null
      };
    }

    if (this.looksLikeRemoteRepo(normalizedRepo)) {
      const relativeDir = this.getRemoteWorkspaceDir(normalizedRepo);
      return {
        repo: normalizedRepo,
        isAbsolutePath: false,
        repoRoot: path.join(workspaceRoot, relativeDir),
        worktreePath,
        cloneUrl: normalizedRepo
      };
    }

    return {
      repo: normalizedRepo,
      isAbsolutePath: false,
      repoRoot: path.join(workspaceRoot, normalizedRepo),
      worktreePath,
      cloneUrl: null
    };
  }

  private async prepareWorktreeWorkspace(
    task: Task,
    agent: Agent,
    repoTarget: CursorExecutionContext,
    workspaceRoot: string,
    timeout: number
  ): Promise<void> {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.dirname(repoTarget.worktreePath), { recursive: true });

    if (repoTarget.cloneUrl && !fs.existsSync(repoTarget.repoRoot)) {
      const parentDir = path.dirname(repoTarget.repoRoot);
      fs.mkdirSync(parentDir, { recursive: true });
      await this.runRuntimeCommand(agent, parentDir, "git", ["clone", repoTarget.cloneUrl, path.basename(repoTarget.repoRoot)], {
        cwd: workspaceRoot,
        maxBuffer: this.maxBuffer,
        timeout
      });
    }

    if (!fs.existsSync(path.join(repoTarget.repoRoot, ".git"))) {
      throw new Error(`Repository root ${repoTarget.repoRoot} is not a git repository`);
    }

    if (fs.existsSync(repoTarget.worktreePath)) {
      await this.runRuntimeCommand(agent, repoTarget.repoRoot, "git", ["worktree", "remove", "--force", repoTarget.worktreePath], {
        cwd: repoTarget.repoRoot,
        maxBuffer: this.maxBuffer,
        timeout
      }).catch(() => undefined);
      fs.rmSync(repoTarget.worktreePath, { recursive: true, force: true });
    }

    await this.runRuntimeCommand(
      agent,
      repoTarget.repoRoot,
      "git",
      ["worktree", "add", "--force", "--detach", repoTarget.worktreePath, "HEAD"],
      {
        cwd: repoTarget.repoRoot,
        maxBuffer: this.maxBuffer,
        timeout
      }
    );
    await this.runRuntimeCommand(agent, repoTarget.worktreePath, "git", ["checkout", "-B", repoTarget.branch], {
      cwd: repoTarget.worktreePath,
      maxBuffer: this.maxBuffer,
      timeout
    });
  }

  private async runRuntimeCommand(
    agent: Agent,
    runtimeCwd: string,
    command: string,
    args: string[],
    options: ProcessRunOptions,
    streamHandlers?: {
      onStdoutChunk?: (chunk: string) => void | Promise<void>;
      onStderrChunk?: (chunk: string) => void | Promise<void>;
    }
  ): Promise<{ stdout: string; stderr: string }> {
    if (!this.runtime) {
      throw new Error("Local runtime plugin is not registered");
    }
    return this.runtime.runCommand(agent, {
      cwd: runtimeCwd,
      command,
      args,
      options,
      onStdoutChunk: streamHandlers?.onStdoutChunk,
      onStderrChunk: streamHandlers?.onStderrChunk
    });
  }

  private buildFailureResult(
    stage: CursorRunStage,
    error: unknown,
    executionContext: CursorExecutionContext,
    state: {
      branchCheckedOut: boolean;
      codexStarted: boolean;
      stdout: string;
      stderr: string;
    }
  ): CursorRunResult {
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
        failure.stderr || failure.message || (timedOut ? "Cursor CLI command timed out" : "")
      ),
      timedOut,
      branchCheckedOut: state.branchCheckedOut,
      codexStarted: state.codexStarted,
      repo: executionContext.repo,
      branch: executionContext.branch,
      repoRoot: executionContext.repoRoot,
      worktreePath: executionContext.worktreePath,
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

  private async appendStreamChunkLog(
    taskId: string,
    agentId: string,
    stream: "stdout" | "stderr",
    node: string,
    iteration: number,
    loopCount: number,
    chunk: string
  ): Promise<void> {
    if (!chunk.trim()) {
      return;
    }

    await this.appendWorkflowLog(taskId, agentId, "running", {
      message: `${stream} chunk from workflow node ${node}`,
      metadata: {
        node,
        iteration,
        loopCount,
        stream,
        [stream]: chunk
      }
    });
  }

  private buildWorkflowNodes(task: Task, executionContext: CursorExecutionContext): WorkflowNode[] {
    const { workflowPromptsContent, resolvedWorkflowPromptsPath } = this.loadWorkflowDefinitions(
      executionContext.worktreePath
    );
    executionContext.workflowPromptsPath = path.posix.join(
      executionContext.worktreePath,
      path.relative(executionContext.worktreePath, resolvedWorkflowPromptsPath).split(path.sep).join("/")
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

  private loadWorkflowDefinitions(worktreePath: string): {
    workflowPromptsContent: string;
    resolvedWorkflowPromptsPath: string;
  } {
    const candidates = this.extractWorkflowPromptsCandidates(worktreePath);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return {
          workflowPromptsContent: fs.readFileSync(candidate, "utf8"),
          resolvedWorkflowPromptsPath: candidate
        };
      }
    }

    throw new Error(`Unable to locate WORKFLOW_PROMPTS.md in ${worktreePath}`);
  }

  private extractWorkflowPromptsCandidates(worktreePath: string): string[] {
    const candidates: string[] = [];
    candidates.push(path.join(worktreePath, "knowledge", "WORKFLOW_PROMPTS.md"));
    candidates.push(path.join(worktreePath, "WORKFLOW_PROMPTS.md"));
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
      .filter((value) => /^[A-Za-z][A-Za-z0-9]*$/.test(value));
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
    executionContext: CursorExecutionContext
  ): Record<string, string> {
    const projectName = path.posix.basename(executionContext.repoRoot);
    return {
      taskId: task.id,
      taskTitle: task.title ?? task.id,
      taskPrompt: task.instruction ?? "",
      gitBranch: executionContext.branch,
      gitBaseBranch: "main",
      gitWorktree: executionContext.branch,
      gitWorktreePath: executionContext.worktreePath,
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

  private getWorkflowCompletionStatus(executionContext: CursorExecutionContext): WorkflowCompletionStatus {
    const taskResultPath = path.join(
      executionContext.worktreePath,
      "docs",
      executionContext.branch,
      "taskResult.md"
    );
    if (!fs.existsSync(taskResultPath)) {
      return {
        completed: false,
        reason: `Missing ${path.relative(executionContext.worktreePath, taskResultPath)}`
      };
    }

    const taskResultFirstLine = this.readFirstLine(taskResultPath);
    if (taskResultFirstLine !== "已完成") {
      return {
        completed: false,
        reason: `${path.relative(executionContext.worktreePath, taskResultPath)} first line is "${taskResultFirstLine || "(empty)"}"`
      };
    }

    const latestOpenSpecTasksPath = this.findLatestOpenSpecTasksPath(executionContext.worktreePath);
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
        reason: `${path.relative(executionContext.worktreePath, latestOpenSpecTasksPath)} has unchecked tasks: ${uncheckedTaskIds.join(", ")}`
      };
    }

    return {
      completed: true,
      reason: `${path.relative(executionContext.worktreePath, latestOpenSpecTasksPath)} fully completed`
    };
  }

  private readFirstLine(filePath: string): string {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
  }

  private findLatestOpenSpecTasksPath(worktreePath: string): string | null {
    const changesDir = path.join(worktreePath, "openspec", "changes");
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

  private buildCursorAgentArgs(cliBin: string, worktreePath: string, instruction: string): string[] {
    const outputFormat = this.configService.get<string>("CURSOR_OUTPUT_FORMAT", "text");
    const model = this.configService.get<string | undefined>("CURSOR_MODEL", undefined);
    const mode = this.configService.get<string | undefined>("CURSOR_AGENT_MODE", undefined);
    const sandbox = this.configService.get<string | undefined>("CURSOR_SANDBOX", undefined);
    const trustWorkspace = this.configService.get<string>("CURSOR_TRUST_WORKSPACE", "true");
    const forceCommands = this.configService.get<string>("CURSOR_FORCE_COMMANDS", "true");
    const approveMcps = this.configService.get<string>("CURSOR_APPROVE_MCPS", "false");

    const argv: string[] = [cliBin];
    const binBase = path.basename(cliBin).toLowerCase();
    if (binBase === "cursor" || binBase === "cursor.cmd" || binBase === "cursor.exe") {
      argv.push("agent");
    }

    argv.push("-p", "--workspace", worktreePath, "--output-format", outputFormat);

    if (trustWorkspace === "true") {
      argv.push("--trust");
    }
    if (forceCommands === "true") {
      argv.push("--force");
    }
    if (approveMcps === "true") {
      argv.push("--approve-mcps");
    }

    if (model) {
      argv.push("--model", model);
    }

    if (mode) {
      argv.push("--mode", mode);
    }

    if (sandbox === "enabled" || sandbox === "disabled") {
      argv.push("--sandbox", sandbox);
    }

    argv.push(instruction);
    return argv;
  }

  private logCursorAgentConfig(): void {
    const model = this.configService.get<string | undefined>("CURSOR_MODEL", undefined);
    const outputFormat = this.configService.get<string>("CURSOR_OUTPUT_FORMAT", "text");
    const mode = this.configService.get<string | undefined>("CURSOR_AGENT_MODE", undefined);
    const cliBin = this.configService.get<string>("CURSOR_CLI_BIN", "agent");
    this.logger.log(
      `Cursor agent CLI config: bin=${cliBin}, model=${model ?? "default"}, outputFormat=${outputFormat}, mode=${mode ?? "default"}`
    );
  }

  private async ensureWorkflowPromptsExists(
    agent: Agent,
    executionContext: CursorExecutionContext,
    timeout: number
  ): Promise<void> {
    await this.runRuntimeCommand(
      agent,
      executionContext.worktreePath,
      "sh",
      ["-lc", "test -s 'knowledge/WORKFLOW_PROMPTS.md' || test -s 'WORKFLOW_PROMPTS.md'"],
      {
        cwd: executionContext.repoRoot,
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

  private sanitizeWorktreeSegment(value: string): string {
    return value
      .replace(/^[A-Za-z]+:\/\//, "")
      .replace(/^[^@]+@/, "")
      .replace(/[\\/:]+/g, "_")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "repo";
  }
}
