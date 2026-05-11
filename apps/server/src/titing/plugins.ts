import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  EnvironmentPlugin,
  EvalResult,
  ExecutionPlugin,
  ExecutionResult,
  GovernanceRecord,
  ObservabilityGovernancePlugin,
  PluginConfig,
  PluginHealth,
  PreparedWorkspace,
  QualityPlugin,
  QualityResult,
  RepairGoal,
  TaskIntegrationPlugin,
  TitingTask
} from "@titing/plugin-api";
import { ServerConfig } from "./config";

export class MeegleTaskIntegrationPlugin implements TaskIntegrationPlugin {
  readonly id = "meegle";
  readonly kind = "task-integration" as const;
  readonly priority = 100;
  readonly capabilities = ["meegle"];

  constructor(private readonly config: ServerConfig) {}

  async health(): Promise<PluginHealth> {
    if (this.config.plugins.meegle.sourceMode === "latest_sprint") {
      const readiness = await this.checkLatestSprintReadiness();
      return readiness.healthy
        ? { healthy: true, message: readiness.message }
        : { healthy: false, message: readiness.message };
    }
    if (this.config.plugins.meegle.mode === "webhook") {
      return {
        healthy: Boolean(this.config.plugins.meegle.webhookSecret),
        message: this.config.plugins.meegle.webhookSecret
          ? "Meegle webhook integration ready"
          : "Meegle webhook secret is not configured"
      };
    }
    if (!this.config.plugins.meegle.tasksFile) {
      return { healthy: false, message: "Meegle tasks file is not configured" };
    }
    return { healthy: true, message: `Meegle file integration ready: ${this.config.plugins.meegle.tasksFile}` };
  }

  async pullTasks(): Promise<TitingTask[]> {
    if (this.config.plugins.meegle.sourceMode === "latest_sprint") {
      return this.pullLatestSprintTasks();
    }
    if (!this.config.plugins.meegle.tasksFile || this.config.plugins.meegle.mode !== "polling") {
      return [];
    }
    const payload = JSON.parse(await readFile(this.config.plugins.meegle.tasksFile, "utf8")) as { tasks?: unknown[] };
    const rows = Array.isArray(payload.tasks) ? payload.tasks : [];
    return rows.map((row, index) => mapMeegleTask(row, index));
  }

  async reportResult(task: TitingTask, summary: string): Promise<void> {
    if (!this.config.plugins.meegle.resultsFile || !task.externalId) {
      return;
    }
    const previous = await readJsonArray(this.config.plugins.meegle.resultsFile);
    previous.push({
      taskId: task.id,
      externalId: task.externalId,
      status: task.status,
      summary,
      reportedAt: new Date().toISOString()
    });
    await writeFile(this.config.plugins.meegle.resultsFile, JSON.stringify(previous, null, 2));
  }

  verifyWebhookSecret(secret: string | undefined): boolean {
    if (this.config.plugins.meegle.mode !== "webhook") {
      return false;
    }
    return Boolean(secret) && secret === this.config.plugins.meegle.webhookSecret;
  }

  webhookHealth(): {
    mode: "polling" | "webhook";
    healthy: boolean;
    authMode: "file" | "shared-secret";
    tasksFileConfigured: boolean;
    resultsFileConfigured: boolean;
    webhookSecretConfigured: boolean;
  } {
    return {
      mode: this.config.plugins.meegle.mode,
      healthy: this.config.plugins.meegle.mode === "polling"
        ? Boolean(this.config.plugins.meegle.tasksFile)
        : Boolean(this.config.plugins.meegle.webhookSecret),
      authMode: this.config.plugins.meegle.mode === "polling" ? "file" : "shared-secret",
      tasksFileConfigured: Boolean(this.config.plugins.meegle.tasksFile),
      resultsFileConfigured: Boolean(this.config.plugins.meegle.resultsFile),
      webhookSecretConfigured: Boolean(this.config.plugins.meegle.webhookSecret)
    };
  }

  parseWebhookTasks(payload: unknown): TitingTask[] {
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const rows = Array.isArray(root.tasks)
      ? root.tasks
      : root.task
        ? [root.task]
        : [];
    return rows.map((row, index) => mapMeegleTask(row, index));
  }

  private async checkLatestSprintReadiness(): Promise<{ healthy: boolean; message: string }> {
    const bin = this.config.plugins.meegle.cliBin ?? "meegle";
    const projectKey = this.config.plugins.meegle.projectKey ?? this.config.plugins.meegle.projectScopeName ?? "";
    const result = await runCommand(
      bin,
      ["project", "search", "--project-key", projectKey, "-o", "json", "--envelope"],
      process.cwd(),
      30_000
    );
    if (result.exitCode !== 0) {
      return {
        healthy: false,
        message: result.stderr.trim() || result.stdout.trim() || "Meegle CLI project lookup failed"
      };
    }
    return { healthy: true, message: `Meegle CLI integration ready for ${projectKey}` };
  }

  private async pullLatestSprintTasks(): Promise<TitingTask[]> {
    const bin = this.config.plugins.meegle.cliBin ?? "meegle";
    const projectKey = this.config.plugins.meegle.projectKey ?? this.config.plugins.meegle.projectScopeName ?? "";
    const projectScopeName = this.config.plugins.meegle.projectScopeName ?? projectKey;
    const sprintTypeName = this.config.plugins.meegle.sprintTypeName ?? "迭代";
    const demandTypeName = this.config.plugins.meegle.demandTypeName ?? "需求";
    const sprintLinkField = this.config.plugins.meegle.sprintLinkField ?? "规划迭代";
    const nodeName = this.config.plugins.meegle.nodeName ?? "";
    const queryMql = this.config.plugins.meegle.queryMql?.trim() ?? "";

    const latestSprintRows = await this.runMeegleQuery(bin, projectKey, [
      "SELECT",
      this.buildSelectClause(["工作项ID", "名称", "标题", "description", ...(this.config.plugins.meegle.latestSprintDetailFields ?? [])]),
      "FROM",
      `\`${projectScopeName}\`.\`${sprintTypeName}\``,
      "ORDER BY",
      "`创建时间` DESC",
      "LIMIT",
      "1"
    ].join(" "));

    const latestSprint = latestSprintRows[0];
    if (!latestSprint) {
      return [];
    }

    const sprintLabel = asNonEmptyString(latestSprint.title)
      ?? asNonEmptyString(latestSprint.名称)
      ?? asNonEmptyString(latestSprint["工作项ID"])
      ?? asNonEmptyString(latestSprint.id)
      ?? "";
    if (!sprintLabel) {
      return [];
    }

    const filters: string[] = [
      `\`${sprintLinkField}\` = ${this.quoteMqlString(sprintLabel)}`
    ];
    if (nodeName) {
      filters.push(`\`所属节点\` = ${this.quoteMqlString(nodeName)}`);
    }
    if (queryMql) {
      filters.push(`(${queryMql})`);
    }

    const demandRows = await this.runMeegleQuery(bin, projectKey, [
      "SELECT",
      this.buildSelectClause([
        "工作项ID",
        "名称",
        "标题",
        "instruction",
        "repo",
        "branch",
        "priority",
        "description",
        "title",
        ...(this.config.plugins.meegle.detailFields ?? [])
      ]),
      "FROM",
      `\`${projectScopeName}\`.\`${demandTypeName}\``,
      "WHERE",
      filters.join(" AND ")
    ].join(" "));

    return demandRows.map((row, index) => mapMeegleTask(this.normalizeTaskRow(row, latestSprint), index));
  }

  private async runMeegleQuery(bin: string, projectKey: string, mql: string): Promise<Array<Record<string, unknown>>> {
    const result = await runCommand(
      bin,
      ["workitem", "query", "--project-key", projectKey, "--mql", mql, "-o", "json", "--envelope"],
      process.cwd(),
      60_000
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Meegle query failed");
    }
    const parsed = JSON.parse(result.stdout || "{}") as { data?: unknown };
    return extractRows(parsed.data);
  }

  private buildSelectClause(fields: string[]): string {
    const unique = [...new Set(fields.map((field) => field.trim()).filter(Boolean))];
    return unique.map((field) => `\`${field}\``).join(", ");
  }

  private quoteMqlString(value: string): string {
    return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  }

  private normalizeTaskRow(row: Record<string, unknown>, sprint: Record<string, unknown>): Record<string, unknown> {
    return {
      ...row,
      metadata: {
        ...(typeof row.metadata === "object" && row.metadata !== null ? row.metadata as Record<string, unknown> : {}),
        latestSprint: sprint
      }
    };
  }
}

export class LocalWorktreeEnvironmentPlugin implements EnvironmentPlugin {
  readonly id = "git-worktree-local";
  readonly kind = "environment" as const;
  readonly priority = 100;
  readonly capabilities = ["local-worktree"];

  constructor(private readonly config: ServerConfig) {}

  async health(): Promise<PluginHealth> {
    return { healthy: true, message: `Workspace root ${this.config.workspace.root}` };
  }

  async prepareWorkspace(task: TitingTask): Promise<PreparedWorkspace> {
    const workspacePath = resolve(this.config.workspace.root, `${task.id}-${task.executor}`);
    const repoPath = join(workspacePath, "repo");
    const artifactsPath = join(workspacePath, "artifacts");
    const cachePath = resolve(this.config.workspace.repoCacheRoot, hashRepo(task.repo));
    const env = normalizeWorkspaceEnv(task.metadata.env);

    await mkdir(workspacePath, { recursive: true });
    await mkdir(this.config.workspace.repoCacheRoot, { recursive: true });
    await mkdir(artifactsPath, { recursive: true });

    if (!(await pathExists(cachePath))) {
      await runCheckedCommand("git", ["clone", "--mirror", task.repo, cachePath], this.config.workspace.root, process.env, this.config.goalRecovery.executionTimeoutMs, "clone");
    } else {
      await runCheckedCommand("git", ["--git-dir", cachePath, "fetch", "--all", "--prune"], this.config.workspace.root, process.env, this.config.goalRecovery.executionTimeoutMs, "fetch");
    }

    await rm(repoPath, { recursive: true, force: true });
    const targetRef = await resolveBranchRef(cachePath, task.branch, this.config.goalRecovery.executionTimeoutMs);
    await runCheckedCommand(
      "git",
      ["--git-dir", cachePath, "worktree", "add", "--force", repoPath, targetRef],
      this.config.workspace.root,
      process.env,
      this.config.goalRecovery.executionTimeoutMs,
      "worktree"
    );
    await runCheckedCommand(
      "git",
      ["-C", repoPath, "checkout", "-B", task.branch, targetRef],
      this.config.workspace.root,
      process.env,
      this.config.goalRecovery.executionTimeoutMs,
      "checkout"
    );

    await installDependenciesIfNeeded(repoPath, env, this.config.goalRecovery.executionTimeoutMs);
    await writeFile(join(artifactsPath, "workspace.json"), JSON.stringify({
      taskId: task.id,
      repo: task.repo,
      branch: task.branch,
      preparedAt: new Date().toISOString(),
      envKeys: Object.keys(env)
    }, null, 2));

    return {
      workspacePath,
      repoPath,
      branch: task.branch,
      cachePath,
      artifactsPath,
      env
    };
  }

  async cleanupWorkspace(task: TitingTask, workspace: PreparedWorkspace): Promise<void> {
    try {
      if (await pathExists(workspace.repoPath)) {
        await runCheckedCommand(
          "git",
          ["--git-dir", workspace.cachePath, "worktree", "remove", "--force", workspace.repoPath],
          this.config.workspace.root,
          process.env,
          this.config.goalRecovery.executionTimeoutMs,
          "cleanup"
        );
      }
    } finally {
      const shouldDelete =
        (task.status === "done" && this.config.workspace.cleanupOnSuccess) ||
        (task.status !== "done" && this.config.workspace.cleanupOnFailure);
      if (shouldDelete) {
        await rm(workspace.workspacePath, { recursive: true, force: true });
      }
    }
  }
}

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
    const prompt = goal
      ? `${task.instruction}\n\nRepair goal:\n${goal.objective}\n${goal.doneWhen.join("\n")}`
      : task.instruction;
    const nativeSessionId = await this.createNativeSession(workspace);
    const outputPath = join(workspace.artifactsPath, `${this.id}-last-message.txt`);
    const args = this.buildExecuteArgs(prompt, workspace, outputPath, nativeSessionId);
    return this.runCli(args, workspace, outputPath, nativeSessionId);
  }

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

  protected extractSessionId(result: CommandResult, nativeSessionId: string | null): string | null {
    return this.formatUnifiedSessionId(nativeSessionId);
  }

  protected buildSummary(result: CommandResult, outputMessage: string): string {
    return outputMessage || result.summary;
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
    const redactedSummary = this.governance?.redact?.(this.buildSummary(result, outputMessage)) ?? this.buildSummary(result, outputMessage);
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
    workspace: PreparedWorkspace,
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
    const result = await runCommand(
      this.bin,
      ["create-chat"],
      workspace.repoPath,
      this.timeoutMs,
      workspace.env
    );
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

export class DefaultQualityPlugin implements QualityPlugin {
  readonly id = "default-quality";
  readonly kind = "quality" as const;
  readonly priority = 100;
  readonly capabilities = ["default"];

  constructor(private readonly timeoutMs: number) {}

  async health(): Promise<PluginHealth> {
    return { healthy: true, message: "Script-based quality gate enabled" };
  }

  async evaluate(input: { execution: ExecutionResult; task: TitingTask; workspace: PreparedWorkspace }): Promise<QualityResult> {
    const scriptCommands = await runQualityScripts(input.workspace, this.timeoutMs);
    const diffReport = await collectDiffRisk(input.workspace, this.timeoutMs);
    const exitCodePassed = input.execution.exitCode === 0;
    const commandChecks = scriptCommands.map((command) => ({
      name: command.name,
      passed: command.passed,
      detail: command.detail
    }));
    const riskLevel = deriveRiskLevel(diffReport, scriptCommands, input.execution.timedOut);
    const acceptancePassed = exitCodePassed && commandChecks.every((check) => check.passed) && riskLevel !== "high";
    const passed = acceptancePassed;

    return {
      passed,
      score: calculateQualityScore(exitCodePassed, scriptCommands, riskLevel),
      riskLevel,
      checks: [
        {
          name: "executor-exit-code",
          passed: exitCodePassed,
          detail: exitCodePassed ? "Executor exited cleanly" : `Exit code ${input.execution.exitCode}`
        },
        ...commandChecks,
        {
          name: "diff-risk",
          passed: riskLevel !== "high",
          detail: `files=${diffReport.filesChanged}, insertions=${diffReport.insertions}, deletions=${diffReport.deletions}, risk=${riskLevel}`
        },
        {
          name: "acceptance-criteria",
          passed: acceptancePassed,
          detail: input.task.acceptanceCriteria.length > 0
            ? `Inferred from automation: ${input.task.acceptanceCriteria.join("; ")}`
            : "No explicit acceptance criteria"
        }
      ],
      report: {
        timedOut: input.execution.timedOut,
        scripts: scriptCommands,
        diff: diffReport
      }
    };
  }
}

export class DefaultObservabilityGovernancePlugin implements ObservabilityGovernancePlugin {
  readonly id = "default-observability-governance";
  readonly kind = "observability-governance" as const;
  readonly priority = 100;
  readonly capabilities = ["default"];
  private readonly records: GovernanceRecord[] = [];
  private policy: GovernancePolicy;

  constructor(defaults?: Partial<GovernancePolicy>) {
    this.policy = {
      allowCommandPrefixes: defaults?.allowCommandPrefixes ?? [],
      blockCommandPatterns: defaults?.blockCommandPatterns ?? [
        "\\bgit\\s+push\\b",
        "\\brm\\s+-rf\\s+/",
        "\\bterraform\\s+destroy\\b",
        "\\baws\\s+iam\\b",
        "\\bssh\\b",
        "\\bscp\\b"
      ],
      maxPromptChars: defaults?.maxPromptChars ?? 16000,
      maxOutputChars: defaults?.maxOutputChars ?? 12000,
      maxFilesChanged: defaults?.maxFilesChanged ?? 20,
      maxDiffLines: defaults?.maxDiffLines ?? 400
    };
  }

  async init(config: PluginConfig | null): Promise<void> {
    const next = config?.config ?? {};
    this.policy = {
      allowCommandPrefixes: asPolicyStringArray(next.allowCommandPrefixes),
      blockCommandPatterns: asPolicyStringArray(next.blockCommandPatterns, this.policy.blockCommandPatterns),
      maxPromptChars: asPositiveNumber(next.maxPromptChars, 16000),
      maxOutputChars: asPositiveNumber(next.maxOutputChars, 12000),
      maxFilesChanged: asPositiveNumber(next.maxFilesChanged, 20),
      maxDiffLines: asPositiveNumber(next.maxDiffLines, 400)
    };
  }

  async health(): Promise<PluginHealth> {
    return {
      healthy: true,
      message: `Default observability and governance plugin active (${this.records.length} records)`
    };
  }

  async beforeCommand(command: string[]): Promise<void> {
    const joined = command.join(" ");
    const findings = [
      ...scanSecrets(joined),
      ...scanCommandPolicy(command, this.policy)
    ];
    if (findings.length > 0) {
      this.pushRecord({
        phase: "before_command",
        outcome: "blocked",
        message: "Governance blocked command before execution",
        findings,
        metadata: {
          command: redactCommand(command),
          estimatedPromptChars: joined.length
        }
      });
      throw new Error(`Governance blocked command: ${findings.join("; ")}`);
    }
    this.pushRecord({
      phase: "before_command",
      outcome: "allowed",
      message: "Governance allowed command execution",
      findings: [],
      metadata: {
        command: redactCommand(command),
        estimatedPromptChars: joined.length
      }
    });
  }

  async afterCommand(command: string[], result: ExecutionResult): Promise<void> {
    result.stdout = this.redact(result.stdout);
    result.stderr = this.redact(result.stderr);
    result.summary = this.redact(result.summary);

    const findings = [
      ...scanSecrets(result.stdout),
      ...scanSecrets(result.stderr),
      ...scanSecrets(result.summary)
    ];
    const estimatedOutputChars = result.stdout.length + result.stderr.length + result.summary.length;
    let outputTruncated = false;
    if (result.stdout.length > this.policy.maxOutputChars) {
      result.stdout = truncateWithMarker(result.stdout, this.policy.maxOutputChars);
      outputTruncated = true;
    }
    if (result.stderr.length > this.policy.maxOutputChars) {
      result.stderr = truncateWithMarker(result.stderr, this.policy.maxOutputChars);
      outputTruncated = true;
    }

    const outcome = findings.length > 0 || outputTruncated ? "flagged" : "allowed";
    const message = outcome === "allowed"
      ? "Governance post-command checks passed"
      : "Governance sanitized command output";
    const governanceEntry: {
      pluginId: string;
      phase: GovernanceRecord["phase"];
      outcome: GovernanceRecord["outcome"];
      message: string;
      findings: string[];
      metadata: Record<string, unknown>;
    } = {
      pluginId: this.id,
      phase: "after_command",
      outcome,
      message,
      findings,
      metadata: {
        command: redactCommand(command),
        outputTruncated,
        estimatedOutputChars
      }
    };
    result.metadata = {
      ...result.metadata,
      governance: appendGovernanceEntry(result.metadata.governance, governanceEntry)
    };
    this.pushRecord(governanceEntry);
  }

  async afterEval(result: EvalResult): Promise<void> {
    result.report = sanitizeUnknown(result.report) as Record<string, unknown>;
    const diff = readDiffReport(result.report);
    const findings = [
      ...scanSecrets(JSON.stringify(result.report)),
      ...scanEvalRisk(diff, this.policy)
    ];
    let outcome: GovernanceRecord["outcome"] = "allowed";
    let message = "Governance post-eval checks passed";
    if (findings.length > 0) {
      outcome = "flagged";
      message = "Governance flagged evaluation output";
    }
    if (diff.filesChanged > this.policy.maxFilesChanged || diff.changedLines > this.policy.maxDiffLines) {
      result.passed = false;
      result.riskLevel = "high";
      outcome = "blocked";
      message = "Governance blocked evaluation because diff risk exceeded policy";
    }
    result.report = {
      ...result.report,
      governance: appendGovernanceEntry(result.report.governance, {
        pluginId: this.id,
        phase: "after_eval",
        outcome,
        message,
        findings,
        metadata: {
          filesChanged: diff.filesChanged,
          changedLines: diff.changedLines,
          maxFilesChanged: this.policy.maxFilesChanged,
          maxDiffLines: this.policy.maxDiffLines
        }
      })
    };
    this.pushRecord({
      phase: "after_eval",
      outcome,
      message,
      findings,
      metadata: {
        filesChanged: diff.filesChanged,
        changedLines: diff.changedLines
      }
    });
  }

  redact(value: string): string {
    return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern.regex, pattern.replacement), value);
  }

  getRecords(): GovernanceRecord[] {
    return [...this.records];
  }

  private pushRecord(record: Omit<GovernanceRecord, "recordedAt">): void {
    this.records.push({
      ...record,
      recordedAt: new Date().toISOString()
    });
    if (this.records.length > 200) {
      this.records.splice(0, this.records.length - 200);
    }
  }
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  summary: string;
  timedOut: boolean;
};

function runCommand(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  envOverrides: Record<string, string> = {}
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...envOverrides } });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolveResult({
        exitCode: 124,
        stdout,
        stderr,
        summary: "Execution timed out",
        timedOut: true
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        exitCode: 127,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        summary: `Failed to launch ${basename(bin)}`,
        timedOut: false
      });
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        summary: exitCode === 0 ? "Execution completed" : "Execution failed",
        timedOut: false
      });
    });
  });
}

async function runCheckedCommand(
  bin: string,
  args: string[],
  cwd: string,
  envOverrides: NodeJS.ProcessEnv,
  timeoutMs: number,
  stage: string
): Promise<void> {
  const result = await runCommand(bin, args, cwd, timeoutMs, stringifyEnv(envOverrides));
  if (result.exitCode !== 0) {
    throw new EnvironmentPreparationError(
      stage,
      result.summary,
      result.stderr || result.stdout,
      isRetryableEnvironmentStage(stage)
    );
  }
}

async function resolveBranchRef(cachePath: string, branch: string, timeoutMs: number): Promise<string> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  const localRef = `refs/heads/${branch}`;
  if (await gitRefExists(cachePath, remoteRef, timeoutMs)) {
    return remoteRef;
  }
  if (await gitRefExists(cachePath, localRef, timeoutMs)) {
    return localRef;
  }
  throw new EnvironmentPreparationError("checkout", `Branch ${branch} not found`, branch, false);
}

async function gitRefExists(cachePath: string, ref: string, timeoutMs: number): Promise<boolean> {
  const result = await runCommand("git", ["--git-dir", cachePath, "show-ref", "--verify", "--quiet", ref], cachePath, timeoutMs);
  return result.exitCode === 0;
}

async function installDependenciesIfNeeded(repoPath: string, env: Record<string, string>, timeoutMs: number): Promise<void> {
  if (!(await pathExists(join(repoPath, "package.json")))) {
    return;
  }
  const installCommand = await selectInstallCommand(repoPath);
  await runCheckedCommand(installCommand.bin, installCommand.args, repoPath, { ...process.env, ...env }, timeoutMs, "install");
}

async function selectInstallCommand(repoPath: string): Promise<{ bin: string; args: string[] }> {
  if (await pathExists(join(repoPath, "package-lock.json"))) {
    return { bin: "npm", args: ["install"] };
  }
  return { bin: "npm", args: ["install"] };
}

async function runQualityScripts(workspace: PreparedWorkspace, timeoutMs: number) {
  const scripts = await readPackageScripts(workspace.repoPath);
  const scriptPlan = [
    { name: "lint", script: "lint" },
    { name: "typecheck", script: "typecheck" },
    { name: "unit-test", script: "test" },
    { name: "build", script: "build" }
  ];

  const results: Array<{ name: string; script: string; passed: boolean; detail: string; skipped: boolean }> = [];
  for (const item of scriptPlan) {
    if (!scripts[item.script]) {
      results.push({
        name: item.name,
        script: item.script,
        passed: true,
        detail: `Skipped: script "${item.script}" not defined`,
        skipped: true
      });
      continue;
    }

    const result = await runCommand("npm", ["run", item.script], workspace.repoPath, timeoutMs, workspace.env);
    results.push({
      name: item.name,
      script: item.script,
      passed: result.exitCode === 0,
      detail: result.exitCode === 0 ? `Passed via npm run ${item.script}` : `Failed via npm run ${item.script}: ${result.summary}`,
      skipped: false
    });
  }

  return results;
}

async function collectDiffRisk(workspace: PreparedWorkspace, timeoutMs: number) {
  const diffStat = await runCommand(
    "git",
    ["-C", workspace.repoPath, "diff", "--shortstat", "--find-renames", "HEAD"],
    workspace.repoPath,
    timeoutMs,
    workspace.env
  );
  const changedFiles = await runCommand(
    "git",
    ["-C", workspace.repoPath, "status", "--short"],
    workspace.repoPath,
    timeoutMs,
    workspace.env
  );
  const match = diffStat.stdout.match(/(\d+)\s+files? changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
  const filesChanged = changedFiles.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
  return {
    filesChanged,
    insertions: match?.[2] ? Number(match[2]) : 0,
    deletions: match?.[3] ? Number(match[3]) : 0,
    summary: diffStat.stdout.trim() || "No diff"
  };
}

function deriveRiskLevel(
  diffReport: { filesChanged: number; insertions: number; deletions: number },
  checks: Array<{ passed: boolean; skipped: boolean }>,
  timedOut: boolean
): QualityResult["riskLevel"] {
  if (timedOut || checks.some((check) => !check.passed && !check.skipped)) {
    return "high";
  }
  const churn = diffReport.insertions + diffReport.deletions;
  if (diffReport.filesChanged > 20 || churn > 400) {
    return "high";
  }
  if (diffReport.filesChanged > 8 || churn > 120) {
    return "medium";
  }
  return "low";
}

function calculateQualityScore(
  exitCodePassed: boolean,
  checks: Array<{ passed: boolean; skipped: boolean }>,
  riskLevel: QualityResult["riskLevel"]
): number {
  let score = exitCodePassed ? 40 : 0;
  for (const check of checks) {
    if (check.skipped) {
      score += 5;
      continue;
    }
    score += check.passed ? 15 : 0;
  }
  if (riskLevel === "medium") {
    score -= 10;
  }
  if (riskLevel === "high") {
    score -= 30;
  }
  return Math.max(0, Math.min(100, score));
}

async function readPackageScripts(repoPath: string): Promise<Record<string, string>> {
  const packageJsonPath = join(repoPath, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return {};
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  return packageJson.scripts ?? {};
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

function normalizeWorkspaceEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1]))
      .map(([key, entryValue]) => [key, String(entryValue)])
  );
}

function stringifyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]]))
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hashRepo(repo: string): string {
  return createHash("sha1").update(repo).digest("hex");
}

function isRetryableEnvironmentStage(stage: string): boolean {
  return ["clone", "fetch", "worktree", "install", "cleanup"].includes(stage);
}

function classifyExecutionError(result: CommandResult): ExecutionResult["errorCategory"] {
  if (result.timedOut) {
    return "timeout";
  }
  if (result.exitCode === 127) {
    return "launch_error";
  }
  if (result.exitCode !== 0) {
    return "command_failed";
  }
  return "none";
}

function extractUuid(value: string): string | null {
  const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match?.[0] ?? null;
}

function extractJsonSessionId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const value = parsed.session_id ?? parsed.sessionId ?? parsed.id;
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractCursorSummary(stdout: string): string | null {
  let summary: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.text === "string" && parsed.text.trim()) {
        summary = parsed.text.trim();
      }
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        summary = parsed.message.trim();
      }
    } catch {
      continue;
    }
  }
  return summary;
}

function redactCommand(command: string[]): string[] {
  return command.map((part) => {
    if (part.length > 80) {
      return `${part.slice(0, 32)}...[redacted:${part.length}]`;
    }
    if (/api[-_]?key|token|secret/i.test(part)) {
      return "[redacted]";
    }
    return part;
  });
}

type GovernancePolicy = {
  allowCommandPrefixes: string[];
  blockCommandPatterns: string[];
  maxPromptChars: number;
  maxOutputChars: number;
  maxFilesChanged: number;
  maxDiffLines: number;
};

const SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /sk-[A-Za-z0-9]{20,}/g, replacement: "[redacted-secret]" },
  { regex: /ghp_[A-Za-z0-9]{20,}/g, replacement: "[redacted-secret]" },
  { regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "[redacted-secret]" },
  { regex: /(api[_-]?key\s*[=:]\s*)([^\s]+)/gi, replacement: "$1[redacted-secret]" },
  { regex: /(authorization:\s*bearer\s+)([^\s]+)/gi, replacement: "$1[redacted-secret]" }
];

function appendGovernanceEntry(existing: unknown, entry: Record<string, unknown>): Record<string, unknown>[] {
  const list = Array.isArray(existing)
    ? existing.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
  return [...list, entry];
}

function scanSecrets(value: string): string[] {
  const findings: string[] = [];
  if (/sk-[A-Za-z0-9]{20,}/.test(value)) {
    findings.push("OpenAI-style secret detected");
  }
  if (/ghp_[A-Za-z0-9]{20,}/.test(value)) {
    findings.push("GitHub token detected");
  }
  if (/xox[baprs]-[A-Za-z0-9-]{10,}/.test(value)) {
    findings.push("Slack token detected");
  }
  if (/api[_-]?key\s*[=:]/i.test(value)) {
    findings.push("API key assignment detected");
  }
  if (/authorization:\s*bearer/i.test(value)) {
    findings.push("Bearer token detected");
  }
  return [...new Set(findings)];
}

function scanCommandPolicy(command: string[], policy: GovernancePolicy): string[] {
  const findings: string[] = [];
  const binary = basename(command[0] ?? "").trim();
  const joined = command.join(" ");
  if (policy.allowCommandPrefixes.length > 0 && !policy.allowCommandPrefixes.includes(binary)) {
    findings.push(`Command binary "${binary || "unknown"}" is not on the allowlist`);
  }
  for (const pattern of policy.blockCommandPatterns) {
    try {
      if (new RegExp(pattern, "i").test(joined)) {
        findings.push(`Command matched blocked policy: ${pattern}`);
      }
    } catch {
      findings.push(`Invalid blocked command pattern: ${pattern}`);
    }
  }
  if (joined.length > policy.maxPromptChars) {
    findings.push(`Command payload exceeded maxPromptChars=${policy.maxPromptChars}`);
  }
  return findings;
}

function scanEvalRisk(
  diff: { filesChanged: number; changedLines: number },
  policy: GovernancePolicy
): string[] {
  const findings: string[] = [];
  if (diff.filesChanged > policy.maxFilesChanged) {
    findings.push(`filesChanged ${diff.filesChanged} exceeded limit ${policy.maxFilesChanged}`);
  }
  if (diff.changedLines > policy.maxDiffLines) {
    findings.push(`changedLines ${diff.changedLines} exceeded limit ${policy.maxDiffLines}`);
  }
  return findings;
}

function truncateWithMarker(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 20))}[truncated-output]`;
}

function readDiffReport(report: Record<string, unknown>): { filesChanged: number; changedLines: number } {
  const diff = report.diff;
  if (!diff || typeof diff !== "object") {
    return { filesChanged: 0, changedLines: 0 };
  }
  const value = diff as Record<string, unknown>;
  const insertions = typeof value.insertions === "number" ? value.insertions : 0;
  const deletions = typeof value.deletions === "number" ? value.deletions : 0;
  return {
    filesChanged: typeof value.filesChanged === "number" ? value.filesChanged : 0,
    changedLines: insertions + deletions
  };
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern.regex, pattern.replacement), value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, sanitizeUnknown(entryValue)])
    );
  }
  return value;
}

function asPolicyStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export class EnvironmentPreparationError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly detail: string,
    readonly retryable: boolean
  ) {
    super(`${stage}: ${message}${detail ? ` (${detail})` : ""}`);
    this.name = "EnvironmentPreparationError";
  }
}

export function createBuiltinPlugins(config: ServerConfig) {
  const governance = new DefaultObservabilityGovernancePlugin(config.governance);
  return [
    new MeegleTaskIntegrationPlugin(config),
    new LocalWorktreeEnvironmentPlugin(config),
    new CodexExecutionPlugin(config.plugins.execution.codexBin, config.goalRecovery.executionTimeoutMs, governance),
    new CursorExecutionPlugin(config.plugins.execution.cursorBin, config.goalRecovery.executionTimeoutMs, governance),
    new DefaultQualityPlugin(config.goalRecovery.qualityTimeoutMs),
    governance
  ];
}

function mapMeegleTask(value: unknown, index: number): TitingTask {
  const row = (value ?? {}) as Record<string, unknown>;
  const now = new Date();
  const externalId = asNonEmptyString(row.id)
    ?? asNonEmptyString(row.work_item_id)
    ?? asNonEmptyString(row["工作项ID"])
    ?? `meegle-${index + 1}`;
  const title = asNonEmptyString(row.title)
    ?? asNonEmptyString(row.标题)
    ?? asNonEmptyString(row.名称)
    ?? `Meegle task ${externalId}`;
  const instruction = asNonEmptyString(row.instruction)
    ?? asNonEmptyString(row.description)
    ?? asNonEmptyString(row.描述)
    ?? title;
  const repo = asNonEmptyString(row.repo) ?? "";
  const branch = asNonEmptyString(row.branch) ?? "main";
  const executor = asNonEmptyString(row.executor) ?? "codex";
  const source = "meegle";
  const priority = asTaskPriority(row.priority);
  return {
    id: `meegle-${externalId}`,
    source,
    externalId,
    title,
    instruction,
    repo,
    branch,
    priority,
    status: "created",
    executor,
    traceId: `meegle-${externalId}`,
    constraints: asStringArray(row.constraints),
    acceptanceCriteria: asStringArray(row.acceptanceCriteria),
    metadata: typeof row.metadata === "object" && row.metadata !== null ? row.metadata as Record<string, unknown> : {},
    retryCount: 0,
    repairCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

async function readJsonArray(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
  } catch {
    return [];
  }
}

function extractRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      return record.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    }
    if (Array.isArray(record.list)) {
      return record.list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    }
    if (Array.isArray(record.data)) {
      return record.data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    }
  }
  return [];
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function asTaskPriority(value: unknown): TitingTask["priority"] {
  return value === "high" || value === "low" ? value : "medium";
}
