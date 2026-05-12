import { join, relative } from "node:path";
import {
  ExecutionPlugin,
  ExecutionResult,
  ObservabilityGovernancePlugin,
  PluginHealth,
  PreparedWorkspace,
  RepairGoal,
  TitingTask
} from "@titing/plugin-api";
import {
  classifyExecutionError,
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

  async execute(task: TitingTask, workspace: PreparedWorkspace, goal: RepairGoal | null): Promise<ExecutionResult> {
    try {
      const workflow = await loadWorkflowDefinition(workspace.repoPath);
      const nativeSessionId = await this.createNativeSession(workspace);
      return this.runWorkflow(task, workspace, goal, workflow.path, workflow.nodes, nativeSessionId, false);
    } catch (error) {
      return this.buildWorkflowFailureResult(workspace, error);
    }
  }

  async continueSession(
    sessionId: string,
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal
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
        true
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

  protected async createNativeSession(_workspace: PreparedWorkspace): Promise<string | null> {
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
    resumeWorkflow: boolean
  ): Promise<ExecutionResult> {
    const nodeExecutions: WorkflowNodeExecutionRecord[] = [];
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    const summaries: Array<{ label: string; summary: string }> = [];
    let nativeSessionId = initialNativeSessionId;
    let latestSessionId = this.formatUnifiedSessionId(nativeSessionId);
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
        const result = await this.runCli(args, workspace, outputPath, nativeSessionId);
        const nextNativeSessionId = result.sessionId ? this.parseUnifiedSessionId(result.sessionId) : nativeSessionId;
        nativeSessionId = nextNativeSessionId;
        latestSessionId = result.sessionId ?? latestSessionId;
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
              ...result.metadata,
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
    nativeSessionId: string | null
  ): Promise<ExecutionResult> {
    try {
      await this.governance?.beforeCommand?.([this.bin, ...args]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    const result = await runCommand(this.bin, args, workspace.repoPath, this.timeoutMs, workspace.env);
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
        outputMessage
      }
    };
    await this.governance?.afterCommand?.([this.bin, ...args], executionResult);
    return executionResult;
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

  protected async createNativeSession(workspace: PreparedWorkspace): Promise<string | null> {
    const result = await runCommand(this.bin, ["create-chat"], workspace.repoPath, this.timeoutMs, workspace.env);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create Cursor chat: ${result.stderr || result.stdout || result.summary}`);
    }
    return result.stdout.trim().split(/\s+/).at(-1) ?? null;
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
}
