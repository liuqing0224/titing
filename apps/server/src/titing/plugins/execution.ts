import { join, relative } from "node:path";
import {
  ExecutionContext,
  ExecutionPlugin,
  ExecutionResult,
  ObservabilityGovernancePlugin,
  PluginHealth,
  PreparedWorkspace,
  RepairGoal,
  TitingTask
} from "@titing/plugin-api";
import {
  appendJsonLine,
  classifyExecutionError,
  CommandLifecycleEvent,
  CommandResult,
  extractCursorSummary,
  extractJsonSessionId,
  extractUuid,
  readOptionalFile,
  redactCommand,
  runCommand
} from "./shared";
import { loadWorkflowDefinition, renderWorkflowTemplate, WorkflowNodeDefinition } from "./workflow";

type WorkflowNodeExecutionRecord = {
  node: string;
  iteration: number;
  loopCount: number;
  exitCode: number;
  stdoutLength: number;
  stderrLength: number;
  timedOut: boolean;
};

/**
 * Shared CLI execution flow: load project workflow → render prompt variables → execute each workflow node with shared
 * session continuity → aggregate result/metadata → governance wraps each CLI command invocation.
 */
abstract class BaseCliExecutionPlugin implements ExecutionPlugin {
  abstract readonly id: string;
  readonly kind = "execution" as const;
  abstract readonly priority: number;
  abstract readonly capabilities: string[];

  constructor(
    protected readonly bin: string,
    protected readonly timeoutMs: number,
    private readonly governance?: ObservabilityGovernancePlugin
  ) {}

  async health(): Promise<PluginHealth> {
    return { healthy: true, message: `${this.id} executor configured with binary ${this.bin}` };
  }

  async execute(
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal | null,
    context?: ExecutionContext
  ): Promise<ExecutionResult> {
    try {
      const workflow = await loadWorkflowDefinition(workspace.repoPath);
      const nativeSessionId = await this.createNativeSession(workspace, task, context);
      return this.runWorkflow(task, workspace, goal, workflow.path, workflow.nodes, nativeSessionId, false, context);
    } catch (error) {
      return this.buildWorkflowFailureResult(workspace, error);
    }
  }

  async continueSession(
    sessionId: string,
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal,
    context?: ExecutionContext
  ): Promise<ExecutionResult> {
    try {
      const workflow = await loadWorkflowDefinition(workspace.repoPath);
      return this.runWorkflow(
        task,
        workspace,
        goal,
        workflow.path,
        workflow.nodes,
        this.parseUnifiedSessionId(sessionId),
        true,
        context
      );
    } catch (error) {
      return this.buildWorkflowFailureResult(workspace, error);
    }
  }

  protected abstract buildExecuteArgs(
    prompt: string,
    workspace: PreparedWorkspace,
    outputPath: string,
    nativeSessionId: string | null
  ): string[];

  protected abstract buildResumeArgs(
    prompt: string,
    workspace: PreparedWorkspace,
    outputPath: string,
    nativeSessionId: string | null
  ): string[];

  protected async createNativeSession(
    _workspace: PreparedWorkspace,
    _task?: TitingTask,
    _context?: ExecutionContext
  ): Promise<string | null> {
    return null;
  }

  protected formatUnifiedSessionId(nativeSessionId: string | null): string | null {
    if (!nativeSessionId) {
      return null;
    }
    return `${this.id}:${nativeSessionId}`;
  }

  protected parseUnifiedSessionId(sessionId: string): string | null {
    const prefix = `${this.id}:`;
    if (!sessionId.startsWith(prefix)) {
      return sessionId;
    }
    return sessionId.slice(prefix.length);
  }

  protected extractSessionId(_result: CommandResult, nativeSessionId: string | null): string | null {
    return this.formatUnifiedSessionId(nativeSessionId);
  }

  protected buildSummary(result: CommandResult, outputMessage: string): string {
    return outputMessage || result.summary;
  }

  private async runWorkflow(
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal | null,
    workflowPromptsPath: string,
    nodes: WorkflowNodeDefinition[],
    initialNativeSessionId: string | null,
    resumeWorkflow: boolean,
    context?: ExecutionContext
  ): Promise<ExecutionResult> {
    const nodeExecutions: WorkflowNodeExecutionRecord[] = [];
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    const summaries: Array<{ label: string; summary: string }> = [];
    let nativeSessionId = initialNativeSessionId;
    let latestSessionId = this.formatUnifiedSessionId(nativeSessionId);
    let latestMetadata: Record<string, unknown> = {};
    let isFirstInvocation = true;

    for (const node of nodes) {
      const loopCount = node.loopEnabled ? node.maxLoops : 1;
      for (let iteration = 1; iteration <= loopCount; iteration += 1) {
        const prompt = this.buildWorkflowPrompt(task, workspace, goal, node, workflowPromptsPath);
        const outputPath = join(workspace.artifactsPath, `${this.id}-last-message.txt`);
        const args = isFirstInvocation
          ? (resumeWorkflow
            ? this.buildResumeArgs(prompt, workspace, outputPath, nativeSessionId)
            : this.buildExecuteArgs(prompt, workspace, outputPath, nativeSessionId))
          : this.buildResumeArgs(prompt, workspace, outputPath, nativeSessionId);
        const result = await this.runCli(args, workspace, outputPath, nativeSessionId, context);
        const nextNativeSessionId = result.sessionId ? this.parseUnifiedSessionId(result.sessionId) : nativeSessionId;
        nativeSessionId = nextNativeSessionId;
        latestSessionId = result.sessionId ?? latestSessionId;
        latestMetadata = { ...latestMetadata, ...result.metadata };
        isFirstInvocation = false;

        nodeExecutions.push({
          node: node.name,
          iteration,
          loopCount,
          exitCode: result.exitCode,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
          timedOut: result.timedOut
        });
        if (result.stdout) {
          stdoutParts.push(this.labelOutput(node.name, iteration, loopCount, "stdout", result.stdout));
        }
        if (result.stderr) {
          stderrParts.push(this.labelOutput(node.name, iteration, loopCount, "stderr", result.stderr));
        }
        if (result.summary) {
          summaries.push({
            label: this.labelNodeRun(node.name, iteration, loopCount),
            summary: result.summary
          });
        }

        if (result.exitCode !== 0) {
          return {
            ...result,
            sessionId: latestSessionId,
            stdout: stdoutParts.join("\n\n"),
            stderr: stderrParts.join("\n\n"),
            summary: this.buildAggregateSummary(summaries, result.summary),
            metadata: {
              ...latestMetadata,
              workflowStage: "execute",
              workflowPromptsPath,
              workflowNodeNames: nodes.map((item) => item.name),
              nodeExecutions
            }
          };
        }
      }
    }

    return {
      exitCode: 0,
      stdout: stdoutParts.join("\n\n"),
      stderr: stderrParts.join("\n\n"),
      summary: this.buildAggregateSummary(summaries, "Workflow completed"),
      sessionId: latestSessionId,
      timedOut: false,
      errorCategory: "none",
      timeoutCategory: "none",
      metadata: {
        ...latestMetadata,
        workflowStage: "execute",
        workflowPromptsPath,
        workflowNodeNames: nodes.map((item) => item.name),
        nodeExecutions
      }
    };
  }

  private buildWorkflowPrompt(
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal | null,
    node: WorkflowNodeDefinition,
    workflowPromptsPath: string
  ): string {
    const variables = this.buildWorkflowVariables(task, workspace, goal, workflowPromptsPath);
    const basePrompt = renderWorkflowTemplate(node.promptTemplate, variables);
    if (!goal) {
      return basePrompt;
    }
    return `${basePrompt}\n\nRepair goal:\n${goal.objective}\n${goal.doneWhen.join("\n")}\n${goal.constraints.join("\n")}`.trim();
  }

  private buildWorkflowVariables(
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal | null,
    workflowPromptsPath: string
  ): Record<string, string> {
    const projectName = relative(workspace.workspacePath, workspace.repoPath) === "repo"
      ? task.repo.split("/").filter(Boolean).at(-1)?.replace(/\.git$/, "") ?? "repo"
      : "repo";
    return {
      taskId: task.id,
      taskTitle: task.title,
      taskPrompt: task.instruction,
      gitBranch: workspace.branch,
      gitBaseBranch: "main",
      gitWorktreePath: workspace.repoPath,
      projectName,
      projectDefaultBranch: "main",
      repoPath: workspace.repoPath,
      workspacePath: workspace.workspacePath,
      artifactsPath: workspace.artifactsPath,
      acceptanceCriteria: task.acceptanceCriteria.join("\n"),
      taskConstraints: task.constraints.join("\n"),
      repairObjective: goal?.objective ?? "",
      repairDoneWhen: goal?.doneWhen.join("\n") ?? "",
      workflowPromptsPath
    };
  }

  private buildAggregateSummary(summaries: Array<{ label: string; summary: string }>, fallback: string): string {
    if (summaries.length === 0) {
      return fallback;
    }
    if (summaries.length === 1) {
      return summaries[0].summary;
    }
    return summaries.map((item) => `${item.label}: ${item.summary}`).join("\n");
  }

  private labelOutput(nodeName: string, iteration: number, loopCount: number, stream: "stdout" | "stderr", content: string): string {
    return `${this.labelNodeRun(nodeName, iteration, loopCount)} ${stream}:\n${content}`;
  }

  private labelNodeRun(nodeName: string, iteration: number, loopCount: number): string {
    return loopCount > 1 ? `${nodeName} iteration ${iteration}/${loopCount}` : nodeName;
  }

  private buildWorkflowFailureResult(workspace: PreparedWorkspace, error: unknown): ExecutionResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: "",
      stderr: message,
      summary: "Project WORKFLOW_PROMPTS.md is missing or invalid",
      sessionId: null,
      timedOut: false,
      errorCategory: "command_failed",
      timeoutCategory: "none",
      metadata: {
        cwd: workspace.repoPath,
        workflowStage: "workflow-prompts",
        workflowError: message
      }
    };
  }

  private async runCli(
    args: string[],
    workspace: PreparedWorkspace,
    outputPath: string,
    nativeSessionId: string | null,
    context?: ExecutionContext
  ): Promise<ExecutionResult> {
    const runtimeLogPath = join(workspace.artifactsPath, "executor-runtime.jsonl");
    try {
      await this.governance?.beforeCommand?.([this.bin, ...args]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordRuntimeEvent(workspace, context, {
        phase: "before_command",
        event: "blocked",
        executor: this.id,
        occurredAt: new Date().toISOString(),
        command: redactCommand([this.bin, ...args]),
        nativeSessionId,
        message
      });
      return {
        exitCode: 126,
        stdout: "",
        stderr: message,
        summary: message,
        sessionId: this.extractSessionId({ exitCode: 126, stdout: "", stderr: message, summary: message, timedOut: false }, nativeSessionId),
        timedOut: false,
        errorCategory: "governance_blocked",
        timeoutCategory: "none",
        metadata: {
          command: redactCommand([this.bin, ...args]),
          cwd: workspace.repoPath,
          nativeSessionId,
          runtimeLogPath,
          governance: [{
            pluginId: this.governance?.id,
            phase: "before_command",
            outcome: "blocked",
            message,
            findings: [message],
            metadata: {
              command: redactCommand([this.bin, ...args])
            }
          }]
        }
      };
    }
    await this.recordRuntimeEvent(workspace, context, {
      phase: "command",
      event: "start",
      executor: this.id,
      occurredAt: new Date().toISOString(),
      command: redactCommand([this.bin, ...args]),
      cwd: workspace.repoPath,
      outputPath,
      nativeSessionId
    });
    const result = await runCommand(
      this.bin,
      args,
      workspace.repoPath,
      this.timeoutMs,
      workspace.env,
      (event) => {
        void this.recordRuntimeEvent(workspace, context, this.toRuntimeLogEntry(event, args, workspace, nativeSessionId));
      }
    );
    const outputMessage = await readOptionalFile(outputPath);
    const sessionId = this.extractSessionId(result, nativeSessionId);
    const redactedStdout = this.governance?.redact?.(result.stdout) ?? result.stdout;
    const redactedStderr = this.governance?.redact?.(result.stderr) ?? result.stderr;
    const builtSummary = this.buildSummary(result, outputMessage);
    const redactedSummary = this.governance?.redact?.(builtSummary) ?? builtSummary;
    const executionResult: ExecutionResult = {
      exitCode: result.exitCode,
      stdout: redactedStdout,
      stderr: redactedStderr,
      summary: redactedSummary,
      sessionId,
      timedOut: result.timedOut,
      errorCategory: classifyExecutionError(result),
      timeoutCategory: result.timedOut ? "execution_timeout" : "none",
      metadata: {
        command: redactCommand([this.bin, ...args]),
        cwd: workspace.repoPath,
        nativeSessionId,
        outputMessage,
        outputPath,
        runtimeLogPath
      }
    };
    await this.governance?.afterCommand?.([this.bin, ...args], executionResult);
    await this.recordRuntimeEvent(workspace, context, {
      phase: "command",
      event: "result",
      executor: this.id,
      occurredAt: new Date().toISOString(),
      command: redactCommand([this.bin, ...args]),
      nativeSessionId,
      sessionId,
      exitCode: executionResult.exitCode,
      timedOut: executionResult.timedOut,
      errorCategory: executionResult.errorCategory,
      timeoutCategory: executionResult.timeoutCategory,
      stdoutLength: executionResult.stdout.length,
      stderrLength: executionResult.stderr.length,
      summary: executionResult.summary
    });
    return executionResult;
  }

  private async recordRuntimeEvent(
    workspace: PreparedWorkspace,
    context: ExecutionContext | undefined,
    event: Record<string, unknown>
  ): Promise<void> {
    await appendJsonLine(join(workspace.artifactsPath, "executor-runtime.jsonl"), event);
    await context?.runtimeLogger?.(this.toExecutionRuntimeEvent(event, workspace.repoPath));
  }

  private toExecutionRuntimeEvent(event: Record<string, unknown>, cwd: string) {
    const command = Array.isArray(event.command) ? event.command.filter((item): item is string => typeof item === "string") : [];
    const occurredAt = typeof event.occurredAt === "string" ? event.occurredAt : new Date().toISOString();
    const nativeSessionId = typeof event.nativeSessionId === "string" || event.nativeSessionId === null
      ? event.nativeSessionId as string | null
      : undefined;
    const eventName = typeof event.event === "string" ? event.event : "";
    switch (eventName) {
      case "start":
        return { type: "command_start", command, cwd, outputPath: typeof event.outputPath === "string" ? event.outputPath : undefined, nativeSessionId, occurredAt } as const;
      case "spawn":
        return { type: "spawn", command, cwd, pid: typeof event.pid === "number" ? event.pid : undefined, nativeSessionId, occurredAt } as const;
      case "stdout":
      case "stderr":
        return { type: eventName, command, cwd, bytes: typeof event.bytes === "number" ? event.bytes : 0, chunk: typeof event.preview === "string" ? event.preview : "", nativeSessionId, occurredAt } as const;
      case "timeout":
        return { type: "timeout", command, cwd, signal: typeof event.signal === "string" ? event.signal : "SIGTERM", timeoutMs: typeof event.timeoutMs === "number" ? event.timeoutMs : 0, nativeSessionId, occurredAt } as const;
      case "error":
        return { type: "error", command, cwd, error: typeof event.error === "string" ? event.error : "unknown error", nativeSessionId, occurredAt } as const;
      case "close":
        return { type: "close", command, cwd, exitCode: typeof event.exitCode === "number" ? event.exitCode : null, stdoutBytes: typeof event.stdoutBytes === "number" ? event.stdoutBytes : 0, stderrBytes: typeof event.stderrBytes === "number" ? event.stderrBytes : 0, timedOut: event.timedOut === true, nativeSessionId, occurredAt } as const;
      case "result":
        return {
          type: "result",
          command,
          cwd,
          exitCode: typeof event.exitCode === "number" ? event.exitCode : 1,
          timedOut: event.timedOut === true,
          errorCategory: typeof event.errorCategory === "string" ? event.errorCategory : "none",
          timeoutCategory: typeof event.timeoutCategory === "string" ? event.timeoutCategory : "none",
          stdoutLength: typeof event.stdoutLength === "number" ? event.stdoutLength : 0,
          stderrLength: typeof event.stderrLength === "number" ? event.stderrLength : 0,
          summary: typeof event.summary === "string" ? event.summary : "",
          sessionId: typeof event.sessionId === "string" || event.sessionId === null ? event.sessionId as string | null : undefined,
          nativeSessionId,
          occurredAt
        } as const;
      case "create_chat_start":
        return { type: "session_create_start", command, cwd, occurredAt } as const;
      case "create_chat_result":
        return {
          type: "session_create_result",
          command,
          cwd,
          exitCode: typeof event.exitCode === "number" ? event.exitCode : undefined,
          stdoutLength: typeof event.stdoutLength === "number" ? event.stdoutLength : undefined,
          stderrLength: typeof event.stderrLength === "number" ? event.stderrLength : undefined,
          sessionId: typeof event.sessionId === "string" || event.sessionId === null ? event.sessionId as string | null : undefined,
          occurredAt
        } as const;
      default:
        return { type: "error", command, cwd, error: `unknown runtime event: ${eventName}`, nativeSessionId, occurredAt } as const;
    }
  }

  private toRuntimeLogEntry(
    event: CommandLifecycleEvent,
    args: string[],
    workspace: PreparedWorkspace,
    nativeSessionId: string | null
  ): Record<string, unknown> {
    if (event.type === "stdout" || event.type === "stderr") {
      return {
        phase: "command",
        event: event.type,
        executor: this.id,
        occurredAt: event.occurredAt,
        command: redactCommand([this.bin, ...args]),
        cwd: workspace.repoPath,
        nativeSessionId,
        bytes: event.bytes,
        preview: event.chunk.slice(0, 2000)
      };
    }
    return {
      phase: "command",
      event: event.type,
      executor: this.id,
      occurredAt: event.occurredAt,
      command: "command" in event ? redactCommand(event.command) : redactCommand([this.bin, ...args]),
      cwd: workspace.repoPath,
      nativeSessionId,
      ...("pid" in event ? { pid: event.pid } : {}),
      ...("timeoutMs" in event ? { timeoutMs: event.timeoutMs, signal: event.signal } : {}),
      ...("error" in event ? { error: event.error } : {}),
      ...("exitCode" in event
        ? {
            exitCode: event.exitCode,
            stdoutBytes: event.stdoutBytes,
            stderrBytes: event.stderrBytes,
            timedOut: event.timedOut
          }
        : {})
    };
  }
}

export class CodexExecutionPlugin extends BaseCliExecutionPlugin {
  readonly id = "codex";
  readonly priority = 100;
  readonly capabilities = ["codex"];

  protected buildExecuteArgs(
    prompt: string,
    workspace: PreparedWorkspace,
    outputPath: string
  ): string[] {
    return [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      workspace.repoPath,
      "-o",
      outputPath,
      prompt
    ];
  }

  protected buildResumeArgs(
    prompt: string,
    _workspace: PreparedWorkspace,
    outputPath: string,
    nativeSessionId: string | null
  ): string[] {
    return [
      "exec",
      "resume",
      ...(nativeSessionId && nativeSessionId !== "last" ? [nativeSessionId] : ["--last"]),
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-o",
      outputPath,
      prompt
    ];
  }

  protected extractSessionId(result: CommandResult, nativeSessionId: string | null): string | null {
    const parsed = extractJsonSessionId(result.stdout) ?? extractUuid(result.stdout) ?? extractUuid(result.stderr) ?? nativeSessionId ?? "last";
    return this.formatUnifiedSessionId(parsed);
  }
}

export class CursorExecutionPlugin extends BaseCliExecutionPlugin {
  readonly id = "cursor";
  readonly priority = 100;
  readonly capabilities = ["cursor"];

  protected async createNativeSession(
    workspace: PreparedWorkspace,
    task?: TitingTask,
    context?: ExecutionContext
  ): Promise<string | null> {
    const runtimeLogPath = join(workspace.artifactsPath, "executor-runtime.jsonl");
    const startEvent = {
      phase: "session",
      event: "create_chat_start",
      executor: this.id,
      occurredAt: new Date().toISOString(),
      taskId: task?.id,
      command: [this.bin, "create-chat"],
      cwd: workspace.repoPath
    };
    await appendJsonLine(runtimeLogPath, startEvent);
    await context?.runtimeLogger?.({
      type: "session_create_start",
      command: [this.bin, "create-chat"],
      cwd: workspace.repoPath,
      occurredAt: startEvent.occurredAt
    });
    const result = await runCommand(
      this.bin,
      ["create-chat"],
      workspace.repoPath,
      this.timeoutMs,
      workspace.env,
      (event) => {
        void appendJsonLine(runtimeLogPath, {
          phase: "session",
          executor: this.id,
          taskId: task?.id,
          ...this.toSessionRuntimeLogEntry(event)
        });
      }
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create Cursor chat: ${result.stderr || result.stdout || result.summary}`);
    }
    const sessionId = result.stdout.trim().split(/\s+/).at(-1) ?? null;
    const resultEvent = {
      phase: "session",
      event: "create_chat_result",
      executor: this.id,
      occurredAt: new Date().toISOString(),
      taskId: task?.id,
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
      sessionId
    };
    await appendJsonLine(runtimeLogPath, resultEvent);
    await context?.runtimeLogger?.({
      type: "session_create_result",
      command: [this.bin, "create-chat"],
      cwd: workspace.repoPath,
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
      sessionId,
      occurredAt: resultEvent.occurredAt
    });
    return sessionId;
  }

  protected buildExecuteArgs(
    prompt: string,
    workspace: PreparedWorkspace,
    _outputPath: string,
    nativeSessionId: string | null
  ): string[] {
    return [
      "agent",
      "--print",
      "--output-format",
      "json",
      "--force",
      "--trust",
      "--workspace",
      workspace.repoPath,
      ...(nativeSessionId ? ["--resume", nativeSessionId] : []),
      prompt
    ];
  }

  protected buildResumeArgs(
    prompt: string,
    workspace: PreparedWorkspace,
    _outputPath: string,
    nativeSessionId: string | null
  ): string[] {
    return [
      "agent",
      "--print",
      "--output-format",
      "json",
      "--force",
      "--trust",
      "--workspace",
      workspace.repoPath,
      ...(nativeSessionId ? ["--resume", nativeSessionId] : ["--continue"]),
      prompt
    ];
  }

  protected extractSessionId(_result: CommandResult, nativeSessionId: string | null): string | null {
    return this.formatUnifiedSessionId(nativeSessionId);
  }

  protected buildSummary(result: CommandResult, outputMessage: string): string {
    return outputMessage || extractCursorSummary(result.stdout) || result.summary;
  }

  private toSessionRuntimeLogEntry(event: CommandLifecycleEvent): Record<string, unknown> {
    if (event.type === "stdout" || event.type === "stderr") {
      return {
        event: `create_chat_${event.type}`,
        occurredAt: event.occurredAt,
        bytes: event.bytes,
        preview: event.chunk.slice(0, 2000)
      };
    }
    return {
      event: `create_chat_${event.type}`,
      occurredAt: event.occurredAt,
      ...("pid" in event ? { pid: event.pid } : {}),
      ...("timeoutMs" in event ? { timeoutMs: event.timeoutMs, signal: event.signal } : {}),
      ...("error" in event ? { error: event.error } : {}),
      ...("exitCode" in event
        ? {
            exitCode: event.exitCode,
            stdoutBytes: event.stdoutBytes,
            stderrBytes: event.stderrBytes,
            timedOut: event.timedOut
          }
        : {})
    };
  }
}
