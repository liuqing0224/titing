import { join } from "node:path";
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

/**
 * Shared CLI execution flow: build prompt → optional native session → governance `beforeCommand` → `runCommand` →
 * read artifact message file → redact streams → governance `afterCommand` → {@link ExecutionResult}.
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

  /** Sanity check only; does not spawn the binary. */
  async health(): Promise<PluginHealth> {
    return { healthy: true, message: `${this.id} executor configured with binary ${this.bin}` };
  }

  /**
   * Fresh run: merge repair goal into prompt when present, optional `createNativeSession`, then delegate to {@link BaseCliExecutionPlugin.runCli}.
   */
  async execute(task: TitingTask, workspace: PreparedWorkspace, goal: RepairGoal | null): Promise<ExecutionResult> {
    const prompt = goal
      ? `${task.instruction}\n\nRepair goal:\n${goal.objective}\n${goal.doneWhen.join("\n")}`
      : task.instruction;
    const nativeSessionId = await this.createNativeSession(workspace);
    const outputPath = join(workspace.artifactsPath, `${this.id}-last-message.txt`);
    const args = this.buildExecuteArgs(prompt, workspace, outputPath, nativeSessionId);
    return this.runCli(args, workspace, outputPath, nativeSessionId);
  }

  /**
   * Resume path: parses unified `${pluginId}:${nativeId}` ids, rebuilds CLI resume args, then {@link BaseCliExecutionPlugin.runCli}.
   */
  async continueSession(
    sessionId: string,
    task: TitingTask,
    workspace: PreparedWorkspace,
    goal: RepairGoal
  ): Promise<ExecutionResult> {
    const prompt = `${task.instruction}\n\nRepair goal:\n${goal.objective}\n${goal.doneWhen.join("\n")}`;
    const nativeSessionId = this.parseUnifiedSessionId(sessionId);
    const outputPath = join(workspace.artifactsPath, `${this.id}-last-message.txt`);
    const args = this.buildResumeArgs(prompt, workspace, outputPath, nativeSessionId);
    return this.runCli(args, workspace, outputPath, nativeSessionId);
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

  /** Codex overrides as no-op; Cursor runs `create-chat` first. */
  protected async createNativeSession(_workspace: PreparedWorkspace): Promise<string | null> {
    return null;
  }

  /** Prefix native CLI session id so multiple executor plugins cannot collide when stored downstream. */
  protected formatUnifiedSessionId(nativeSessionId: string | null): string | null {
    if (!nativeSessionId) {
      return null;
    }
    return `${this.id}:${nativeSessionId}`;
  }

  /** Strips `{id}:` when present so subprocess resume flags receive the vendor-native id. */
  protected parseUnifiedSessionId(sessionId: string): string | null {
    const prefix = `${this.id}:`;
    if (!sessionId.startsWith(prefix)) {
      return sessionId;
    }
    return sessionId.slice(prefix.length);
  }

  /** Override to scrape session ids from CLI JSON/stream; base returns prefixed `nativeSessionId` only. */
  protected extractSessionId(_result: CommandResult, nativeSessionId: string | null): string | null {
    return this.formatUnifiedSessionId(nativeSessionId);
  }

  /** Prefer last-message artifact when the CLI wrote `-o path`; Cursor subclasses also scrape JSON summaries. */
  protected buildSummary(result: CommandResult, outputMessage: string): string {
    return outputMessage || result.summary;
  }

  /**
   * Core path: governance pre-check (may short-circuit) → timed `runCommand` in `repoPath` → optional output file →
   * derive session/summary/errorCategory → governance post-hook mutates/redacts `ExecutionResult`.
   */
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

/** Codex CLI: writes last assistant text to `-o` file; session id mined from JSON lines / UUID patterns in stdout/stderr. */
export class CodexExecutionPlugin extends BaseCliExecutionPlugin {
  readonly id = "codex";
  readonly priority = 100;
  readonly capabilities = ["codex"];

  /** Single-shot `codex exec` with JSON stdout and repo pinned to prepared worktree. */
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

  /** `codex exec resume`; falls back to `--last` when we never captured a concrete session id. */
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

  /** Parses rolling JSON fragments from Codex `--json` output for `session_id` / UUID-shaped tokens. */
  protected extractSessionId(result: CommandResult, nativeSessionId: string | null): string | null {
    const parsed = extractJsonSessionId(result.stdout) ?? extractUuid(result.stdout) ?? extractUuid(result.stderr) ?? nativeSessionId ?? "last";
    return this.formatUnifiedSessionId(parsed);
  }
}

/** Cursor agent CLI: proactive `create-chat`, then `--resume`/`--continue` around `agent --print`. */
export class CursorExecutionPlugin extends BaseCliExecutionPlugin {
  readonly id = "cursor";
  readonly priority = 100;
  readonly capabilities = ["cursor"];

  /** Spins up empty chat session; last whitespace-delimited stdout token treated as chat id. */
  protected async createNativeSession(workspace: PreparedWorkspace): Promise<string | null> {
    const result = await runCommand(this.bin, ["create-chat"], workspace.repoPath, this.timeoutMs, workspace.env);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create Cursor chat: ${result.stderr || result.stdout || result.summary}`);
    }
    return result.stdout.trim().split(/\s+/).at(-1) ?? null;
  }

  /** First message in session uses `--resume` when we already have a native chat id from `createNativeSession`. */
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

  /** Subsequent turns resume existing chat id, or `--continue` when missing. */
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

  /** Cursor returns the chat id captured at `create-chat` time; stdout JSON is not parsed for ids here. */
  protected extractSessionId(_result: CommandResult, nativeSessionId: string | null): string | null {
    return this.formatUnifiedSessionId(nativeSessionId);
  }

  /** Pulls human text from JSON line objects (`text` / `message`) when artifact file is empty. */
  protected buildSummary(result: CommandResult, outputMessage: string): string {
    return outputMessage || extractCursorSummary(result.stdout) || result.summary;
  }
}
