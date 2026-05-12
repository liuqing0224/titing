import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { HumanReply, NeedsHumanPayload, PluginHealth, TaskIntegrationPlugin, TitingTask } from "@titing/plugin-api";
import { ServerConfig } from "../config";
import { HttpPluginContext, HttpRoutePlugin } from "../http-plugin";
import {
  applyDescriptionFallback,
  asNonEmptyString,
  buildMeegleNeedsHumanComment,
  buildMeegleResultComment,
  extractTaskDetailPayload,
  extractTaskListPayload,
  mapMeegleTask,
  mergeMeegleTaskRecords,
  parseJson,
  readJsonArray,
  runCommand,
  shouldFallbackToWorkitemCli
} from "./shared";

export type MeegleAuthStatus = {
  status: "authenticated" | "unauthenticated" | "unknown";
  authenticated: boolean;
  message: string;
  host?: string;
  profile?: string;
};

export type MeegleAuthStartResult = {
  status: "pending";
  authenticated: false;
  authorizationUrl: string;
  deviceCode: string;
  clientId: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  userCode?: string;
  message: string;
};

export type MeegleAuthPollInput = {
  deviceCode?: string;
  clientId?: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
};

export type MeegleAuthPollResult = {
  status: "pending" | "authenticated" | "failed" | "expired";
  authenticated: boolean;
  message: string;
  host?: string;
  profile?: string;
};

/**
 * Meegle task source + result sink: file polling, CLI polling (legacy / MQL / latest-sprint), or webhook ingestion.
 * Implements {@link HttpRoutePlugin} for `/api/integrations/meegle/*` when wired on the Fastify server.
 */
export class MeegleTaskIntegrationPlugin implements TaskIntegrationPlugin, HttpRoutePlugin {
  readonly id = "meegle";
  readonly kind = "task-integration" as const;
  readonly priority = 100;
  readonly capabilities = ["meegle"];

  constructor(private readonly config: ServerConfig) {}

  /** Webhook mode checks secret; file mode validates path; CLI mode probes `meegle` auth/project. */
  async health(): Promise<PluginHealth> {
    if (this.config.plugins.meegle.mode === "webhook") {
      return {
        healthy: Boolean(this.config.plugins.meegle.webhookSecret),
        message: this.config.plugins.meegle.webhookSecret
          ? "Meegle webhook integration ready"
          : "Meegle webhook secret is not configured"
      };
    }
    if (!this.config.plugins.meegle.tasksFile) {
      return this.checkCliReadiness();
    }
    return { healthy: true, message: `Meegle file integration ready: ${this.config.plugins.meegle.tasksFile}` };
  }

  /**
   * Polling integration only: reads `tasksFile` JSON or shells out to {@link MeegleTaskIntegrationPlugin.pullCliTasks}.
   * Non-polling modes return `[]` (webhook pushes tasks instead).
   */
  async pullTasks(): Promise<TitingTask[]> {
    if (this.config.plugins.meegle.mode !== "polling") {
      return [];
    }
    if (this.config.plugins.meegle.tasksFile) {
      const payload = JSON.parse(await readFile(this.config.plugins.meegle.tasksFile, "utf8")) as { tasks?: unknown[] };
      const rows = Array.isArray(payload.tasks) ? payload.tasks : [];
      return rows.map((row, index) => mapMeegleTask(row, index, this.defaultExecutor()));
    }
    return this.pullCliTasks();
  }

  /**
   * Persists to `resultsFile` when configured; otherwise posts a Meegle comment via CLI when `externalId` exists.
   */
  async reportResult(task: TitingTask, summary: string): Promise<void> {
    if (this.config.plugins.meegle.resultsFile && task.externalId) {
      const previous = await readJsonArray(this.config.plugins.meegle.resultsFile);
      previous.push({
        taskId: task.id,
        externalId: task.externalId,
        status: task.status,
        summary,
        reportedAt: new Date().toISOString()
      });
      await writeFile(this.config.plugins.meegle.resultsFile, JSON.stringify(previous, null, 2));
      return;
    }
    if (!task.externalId) {
      return;
    }
    await this.addComment(task.externalId, buildMeegleResultComment(task, summary));
  }

  async reportNeedsHuman(task: TitingTask, payload: NeedsHumanPayload): Promise<void> {
    if (!task.externalId) {
      return;
    }
    await this.addComment(task.externalId, buildMeegleNeedsHumanComment(task, payload));
  }

  async pullHumanReplies(tasks: TitingTask[]): Promise<HumanReply[]> {
    const replies = await Promise.all(tasks.map(async (task) => this.listHumanReplies(task)));
    return replies.flat();
  }

  /** Shared-secret gate for webhook requests (`x-titing-webhook-secret`). */
  verifyWebhookSecret(secret: string | undefined): boolean {
    if (this.config.plugins.meegle.mode !== "webhook") {
      return false;
    }
    return Boolean(secret) && secret === this.config.plugins.meegle.webhookSecret;
  }

  /** Returns sanitized Meegle CLI auth state for UI/readiness surfaces. */
  async getAuthStatus(): Promise<MeegleAuthStatus> {
    const result = await runCommand(this.meegleBin(), this.withAuthGlobalArgs(["auth", "status", "--format", "json"]), process.cwd(), 30_000);
    if (result.exitCode !== 0) {
      return {
        status: "unauthenticated",
        authenticated: false,
        message: result.stderr.trim() || result.stdout.trim() || "Meegle authorization required"
      };
    }
    const payload = parseOptionalJsonObject(result.stdout);
    return {
      status: "authenticated",
      authenticated: true,
      message: "Meegle CLI is authenticated",
      host: readStringCandidate(payload, ["host", "domain"]),
      profile: readStringCandidate(payload, ["profile"])
    };
  }

  /** Starts Meegle CLI device-code login and returns only browser/relay metadata. */
  async startAuth(): Promise<MeegleAuthStartResult> {
    const result = await runCommand(
      this.meegleBin(),
      this.withAuthGlobalArgs(["auth", "login", "--device-code", "--phase", "init", "--format", "json"]),
      process.cwd(),
      30_000
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Meegle authorization initialization failed");
    }
    const payload = parseJson(result.stdout) as Record<string, unknown>;
    const authorizationUrl = readStringCandidate(payload, [
      "authorizationUrl",
      "authorization_url",
      "verificationUriComplete",
      "verification_uri_complete",
      "verificationUrl",
      "verification_url",
      "url"
    ]);
    const deviceCode = readStringCandidate(payload, ["deviceCode", "device_code"]);
    const clientId = readStringCandidate(payload, ["clientId", "client_id"]);
    if (!authorizationUrl || !deviceCode || !clientId) {
      throw new Error("Meegle authorization response is missing authorizationUrl, deviceCode, or clientId");
    }
    const intervalSeconds = readNumberCandidate(payload, ["intervalSeconds", "interval_seconds", "interval"]) ?? 5;
    const expiresInSeconds = readNumberCandidate(payload, ["expiresInSeconds", "expires_in_seconds", "expiresIn", "expires_in"]) ?? 600;
    return {
      status: "pending",
      authenticated: false,
      authorizationUrl,
      deviceCode,
      clientId,
      intervalSeconds,
      expiresInSeconds,
      userCode: readStringCandidate(payload, ["userCode", "user_code"]),
      message: "Open the authorization URL to authorize Meegle"
    };
  }

  /** Performs a single non-blocking Meegle device-code poll. */
  async pollAuth(input: MeegleAuthPollInput): Promise<MeegleAuthPollResult> {
    const deviceCode = input.deviceCode?.trim() ?? "";
    const clientId = input.clientId?.trim() ?? "";
    if (!deviceCode || !clientId) {
      throw new Error("deviceCode and clientId are required");
    }
    const args = this.withAuthGlobalArgs([
      "auth",
      "login",
      "--device-code",
      "--phase",
      "poll",
      "--once",
      "--device-code-value",
      deviceCode,
      "--client-id",
      clientId,
      "--interval",
      String(input.intervalSeconds ?? 5),
      "--expires-in",
      String(input.expiresInSeconds ?? 600),
      "--format",
      "json"
    ]);
    const result = await runCommand(this.meegleBin(), args, process.cwd(), 30_000);
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const payload = parseOptionalJsonObject(result.stdout);
    if (result.exitCode === 0 && payload.authenticated === true) {
      return {
        status: "authenticated",
        authenticated: true,
        message: "Meegle authorization completed",
        host: readStringCandidate(payload, ["host", "domain"]),
        profile: readStringCandidate(payload, ["profile"])
      };
    }
    const pending = result.exitCode === 0 || /authorization_pending|pending|slow_down/i.test(combined);
    if (pending) {
      return {
        status: "pending",
        authenticated: false,
        message: readStringCandidate(payload, ["message"]) ?? "Waiting for Meegle authorization"
      };
    }
    return {
      status: /expired/i.test(combined) ? "expired" : "failed",
      authenticated: false,
      message: result.stderr.trim() || result.stdout.trim() || "Meegle authorization polling failed"
    };
  }

  /** Logs out the Meegle CLI profile used by this server process. */
  async logoutAuth(): Promise<{ ok: boolean; message: string }> {
    const result = await runCommand(this.meegleBin(), this.withAuthGlobalArgs(["auth", "logout", "--format", "json"]), process.cwd(), 30_000);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Meegle logout failed");
    }
    return { ok: true, message: "Meegle CLI logged out" };
  }

  /** Structured status for ops dashboards: which auth path and files are configured. */
  webhookHealth(): {
    mode: "polling" | "webhook";
    healthy: boolean;
    authMode: "file" | "shared-secret" | "cli-device-code";
    tasksFileConfigured: boolean;
    resultsFileConfigured: boolean;
    webhookSecretConfigured: boolean;
  } {
    return {
      mode: this.config.plugins.meegle.mode,
      healthy: this.config.plugins.meegle.mode === "polling"
        ? Boolean(this.config.plugins.meegle.tasksFile)
        : Boolean(this.config.plugins.meegle.webhookSecret),
      authMode: this.config.plugins.meegle.mode === "polling"
        ? (this.config.plugins.meegle.tasksFile ? "file" : "cli-device-code")
        : "shared-secret",
      tasksFileConfigured: Boolean(this.config.plugins.meegle.tasksFile),
      resultsFileConfigured: Boolean(this.config.plugins.meegle.resultsFile),
      webhookSecretConfigured: Boolean(this.config.plugins.meegle.webhookSecret)
    };
  }

  /** Normalizes `{ tasks: [] }`, `{ task: {} }`, or bare arrays into {@link mapMeegleTask} inputs. */
  parseWebhookTasks(payload: unknown): TitingTask[] {
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const rows = Array.isArray(root.tasks)
      ? root.tasks
      : root.task
        ? [root.task]
        : [];
    return rows.map((row, index) => mapMeegleTask(row, index, this.defaultExecutor()));
  }

  /**
   * Registers health + webhook routes. Webhook path verifies secret, parses tasks, then calls
   * `context.services.ingestTaskFromIntegration` for each row (202 with accepted counts).
   */
  registerRoutes(fastify: FastifyInstance, context: HttpPluginContext): void {
    fastify.get("/api/integrations/meegle/health", async () => {
      const health = await this.health();
      return {
        ok: health.healthy,
        pluginId: this.id,
        ...health
      };
    });

    fastify.get("/api/integrations/meegle/auth/status", async () => this.getAuthStatus());

    fastify.post("/api/integrations/meegle/auth/start", async () => this.startAuth());

    fastify.post("/api/integrations/meegle/auth/poll", async (request: FastifyRequest) => {
      return this.pollAuth((request.body ?? {}) as MeegleAuthPollInput);
    });

    fastify.post("/api/integrations/meegle/auth/logout", async () => this.logoutAuth());

    fastify.post("/api/integrations/meegle/webhook", async (request: FastifyRequest, reply: FastifyReply) => {
      if (this.config.plugins.meegle.mode !== "webhook") {
        return reply.status(409).send({ error: "Meegle webhook mode is not enabled" });
      }
      const secret = request.headers["x-titing-webhook-secret"];
      const providedSecret = Array.isArray(secret) ? secret[0] : secret;
      if (!this.verifyWebhookSecret(providedSecret)) {
        return reply.status(401).send({ error: "Invalid Meegle webhook secret" });
      }
      const tasks = this.parseWebhookTasks(request.body);
      if (tasks.length === 0) {
        return reply.status(400).send({ error: "Webhook payload must include task or tasks" });
      }
      const ingested = (
        await Promise.all(tasks.map((task) => context.services.ingestTaskFromIntegration(task, "meegle-webhook")))
      ).filter((task): task is NonNullable<typeof task> => Boolean(task));
      return reply.status(202).send({
        accepted: ingested.length,
        externalIds: ingested.map((task) => task.externalId).filter((value): value is string => Boolean(value))
      });
    });
  }

  /** Proves `meegle` CLI is on PATH and either authenticated or scoped to `projectKey`. */
  private async checkCliReadiness(): Promise<{ healthy: boolean; message: string }> {
    const projectKey = this.config.plugins.meegle.projectKey?.trim() ?? "";
    const result = projectKey
      ? await runCommand(this.meegleBin(), ["project", "search", "--project-key", projectKey, "-o", "json", "--envelope"], process.cwd(), 30_000)
      : null;
    if (!result) {
      const auth = await this.getAuthStatus();
      return {
        healthy: auth.authenticated,
        message: auth.authenticated ? `Meegle CLI integration ready: ${this.meegleBin()}` : auth.message
      };
    }
    if (result.exitCode !== 0) {
      return {
        healthy: false,
        message: result.stderr.trim() || result.stdout.trim() || "Meegle CLI readiness check failed"
      };
    }
    return {
      healthy: true,
      message: `Meegle CLI integration ready for ${projectKey}`
    };
  }

  private meegleBin(): string {
    return this.config.plugins.meegle.cliBin ?? "meegle";
  }

  private defaultExecutor(): "codex" | "cursor" {
    return this.config.plugins.execution.defaultExecutor;
  }

  private withAuthGlobalArgs(args: string[]): string[] {
    const withGlobal = [...args];
    const authHost = this.config.plugins.meegle.authHost?.trim();
    if (authHost && args[0] === "auth" && args[1] === "login") {
      withGlobal.push("--host", authHost);
    }
    const authProfile = this.config.plugins.meegle.authProfile?.trim();
    if (authProfile) {
      withGlobal.push("--profile", authProfile);
    }
    return withGlobal;
  }

  /**
   * CLI polling resolution order: legacy `task list/get` → if CLI only supports `workitem`, skip to newest flow:
   * latest-sprint MQL pipeline when configured, otherwise generic MQL {@link pullMqlTasks}.
   */
  private async pullCliTasks(): Promise<TitingTask[]> {
    const bin = this.config.plugins.meegle.cliBin ?? "meegle";
    const legacy = await this.tryPullLegacyCliTasks(bin);
    if (legacy) {
      return legacy;
    }
    if (this.shouldUseLatestSprintFlow()) {
      return this.pullLatestSprintTasks(bin);
    }
    return this.pullMqlTasks(bin);
  }

  /**
   * Older Meegle CLI shape: `task list --status open` then per-id `task get`. Returns `null` when stderr indicates
   * unknown `task` subcommand so callers can fall back to `workitem` flows.
   */
  private async tryPullLegacyCliTasks(bin: string): Promise<TitingTask[] | null> {
    const listArgs = ["task", "list", "--status", "open"];
    const listResult = await runCommand(bin, listArgs, process.cwd(), 60_000);
    if (listResult.exitCode !== 0) {
      if (shouldFallbackToWorkitemCli(listArgs, listResult)) {
        return null;
      }
      throw new Error(listResult.stderr.trim() || listResult.stdout.trim() || "Meegle legacy task list failed");
    }

    const listItems = extractTaskListPayload(parseJson(listResult.stdout));
    const tasks: TitingTask[] = [];
    for (const [index, item] of listItems.entries()) {
      const taskId = asNonEmptyString(item.id);
      if (!taskId) {
        continue;
      }
      const detailResult = await runCommand(bin, ["task", "get", taskId], process.cwd(), 60_000);
      if (detailResult.exitCode !== 0) {
        throw new Error(detailResult.stderr.trim() || detailResult.stdout.trim() || `Meegle task get failed for ${taskId}`);
      }
      const detail = extractTaskDetailPayload(parseJson(detailResult.stdout));
      tasks.push(mapMeegleTask(mergeMeegleTaskRecords(item, detail), index, this.defaultExecutor()));
    }
    return tasks;
  }

  /**
   * `workitem query` with configured MQL: list envelope → hydrate each row via {@link fetchWorkitemDetail}.
   */
  private async pullMqlTasks(bin: string): Promise<TitingTask[]> {
    const projectKey = this.requireMeegleConfig("MEEGLE_PROJECT_KEY", this.config.plugins.meegle.projectKey);
    const mql = this.requireMeegleConfig("MEEGLE_QUERY_MQL", this.config.plugins.meegle.queryMql);
    const queryResult = await runCommand(
      bin,
      ["workitem", "query", "--project-key", projectKey, "--mql", mql, "-o", "json", "--envelope"],
      process.cwd(),
      60_000
    );
    if (queryResult.exitCode !== 0) {
      throw new Error(queryResult.stderr.trim() || queryResult.stdout.trim() || "Meegle query failed");
    }
    const listItems: Array<Record<string, unknown>> = extractTaskListPayload(parseJson(queryResult.stdout)).map((item) => ({
      ...item,
      projectKey
    }));
    const tasks: TitingTask[] = [];
    for (const [index, item] of listItems.entries()) {
      const taskId = asNonEmptyString(item.id);
      if (!taskId) {
        continue;
      }
      const detail = await this.fetchWorkitemDetail(bin, projectKey, taskId, this.getDetailFields());
      tasks.push(mapMeegleTask(mergeMeegleTaskRecords(item, detail, projectKey), index, this.defaultExecutor()));
    }
    return tasks;
  }

  /**
   * Sprint-centric mode: newest sprint row via MQL → demand workitems linked to that sprint (optional node filter) → detail fetch.
   * Enriches task metadata with `latestSprint` payload for downstream context.
   */
  private async pullLatestSprintTasks(bin: string): Promise<TitingTask[]> {
    const projectKey = this.requireMeegleConfig("MEEGLE_PROJECT_KEY", this.config.plugins.meegle.projectKey);
    const projectScopeName = this.requireMeegleConfig("MEEGLE_PROJECT_SCOPE_NAME", this.config.plugins.meegle.projectScopeName);
    const sprintTypeName = this.requireMeegleConfig("MEEGLE_SPRINT_TYPE_NAME", this.config.plugins.meegle.sprintTypeName);
    const demandTypeName = this.requireMeegleConfig("MEEGLE_DEMAND_TYPE_NAME", this.config.plugins.meegle.demandTypeName);
    const sprintLinkField = this.requireMeegleConfig("MEEGLE_SPRINT_LINK_FIELD", this.config.plugins.meegle.sprintLinkField);
    const nodeName = this.config.plugins.meegle.nodeName?.trim() ?? "";

    const sprintQuery =
      `SELECT \`工作项id\`, \`名称\`, \`状态\` FROM \`${projectScopeName}\`.\`${sprintTypeName}\` ` +
      "ORDER BY `工作项id` DESC LIMIT 1";
    const sprintResult = await runCommand(
      bin,
      ["workitem", "query", "--project-key", projectKey, "--mql", sprintQuery, "-o", "json", "--envelope"],
      process.cwd(),
      60_000
    );
    if (sprintResult.exitCode !== 0) {
      throw new Error(sprintResult.stderr.trim() || sprintResult.stdout.trim() || "Meegle latest sprint query failed");
    }
    const sprintRows = extractTaskListPayload(parseJson(sprintResult.stdout));
    const sprintId = asNonEmptyString(sprintRows[0]?.id);
    if (!sprintId) {
      return [];
    }
    const filters = [
      `any_relation_match(\`${sprintLinkField}\`, x -> x.\`工作项ID<target:all>\` = ${sprintId})`
    ];
    if (nodeName) {
      filters.push(`array_contains(in_progress_nodes_name(), ${this.quoteMqlString(nodeName)})`);
    }
    const demandQuery =
      `SELECT \`工作项id\`, \`名称\` FROM \`${projectScopeName}\`.\`${demandTypeName}\` ` +
      `WHERE ${filters.join(" AND ")} ORDER BY \`工作项id\` DESC LIMIT 200`;
    const demandResult = await runCommand(
      bin,
      ["workitem", "query", "--project-key", projectKey, "--mql", demandQuery, "-o", "json", "--envelope"],
      process.cwd(),
      60_000
    );
    if (demandResult.exitCode !== 0) {
      throw new Error(demandResult.stderr.trim() || demandResult.stdout.trim() || "Meegle latest sprint demand query failed");
    }
    const listItems = extractTaskListPayload(parseJson(demandResult.stdout));
    const detailFields = this.getLatestSprintDetailFields();
    const tasks: TitingTask[] = [];
    for (const [index, item] of listItems.entries()) {
      const taskId = asNonEmptyString(item.id);
      if (!taskId) {
        continue;
      }
      const detail = await this.fetchWorkitemDetail(bin, projectKey, taskId, detailFields);
      tasks.push(mapMeegleTask(
        this.normalizeTaskRow(applyDescriptionFallback(mergeMeegleTaskRecords(item, detail, projectKey)), sprintRows[0] ?? {}),
        index,
        this.defaultExecutor()
      ));
    }
    return tasks;
  }

  /** Thin wrapper around `workitem get` with explicit `--fields` projection list. */
  private async fetchWorkitemDetail(
    bin: string,
    projectKey: string,
    taskId: string,
    fields: string[]
  ): Promise<Record<string, unknown>> {
    const args = ["workitem", "get", "--work-item-id", taskId, "--project-key", projectKey, "-o", "json", "--envelope"];
    for (const field of fields) {
      args.push("--fields", field);
    }
    const result = await runCommand(bin, args, process.cwd(), 60_000);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Meegle workitem get failed for ${taskId}`);
    }
    return extractTaskDetailPayload(parseJson(result.stdout));
  }

  /** `meegle comment add` with optional `--project-key`. */
  private async addComment(taskId: string, text: string): Promise<void> {
    const bin = this.config.plugins.meegle.cliBin ?? "meegle";
    const args = ["comment", "add", "--work-item-id", taskId, "--content", text];
    const projectKey = this.config.plugins.meegle.projectKey?.trim() ?? "";
    if (projectKey) {
      args.push("--project-key", projectKey);
    }
    const result = await runCommand(bin, args, process.cwd(), 60_000);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Meegle comment add failed for ${taskId}`);
    }
  }

  private async listHumanReplies(task: TitingTask): Promise<HumanReply[]> {
    if (!task.externalId) {
      return [];
    }
    const result = await runCommand(this.meegleBin(), this.buildCommentListArgs(task.externalId), process.cwd(), 60_000);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Meegle comment list failed for ${task.externalId}`);
    }
    const comments = extractCommentPayload(parseJson(result.stdout));
    const requestedAt = readHumanLoopRequestedAt(task.metadata);
    return comments
      .filter((comment) => !comment.body.includes("[TITING_NEEDS_HUMAN"))
      .filter((comment) => !requestedAt || new Date(comment.createdAt).getTime() >= new Date(requestedAt).getTime())
      .map((comment) => ({
        taskId: task.id,
        externalId: task.externalId ?? "",
        replyId: comment.id ?? buildReplyFingerprint(task.externalId ?? "", comment),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt
      }));
  }

  private buildCommentListArgs(taskId: string): string[] {
    const args = ["comment", "list", "--work-item-id", taskId, "-o", "json", "--envelope"];
    const projectKey = this.config.plugins.meegle.projectKey?.trim() ?? "";
    if (projectKey) {
      args.push("--project-key", projectKey);
    }
    return args;
  }

  /** Default field bundle for generic MQL/detail hydration. */
  private getDetailFields(): string[] {
    const configured = this.config.plugins.meegle.detailFields ?? ["repo", "branch", "instruction", "priority", "description", "title"];
    return configured.map((field) => field.trim()).filter(Boolean);
  }

  /** Lighter projection for sprint demand rows (defaults to description only). */
  private getLatestSprintDetailFields(): string[] {
    const configured = this.config.plugins.meegle.latestSprintDetailFields ?? ["description"];
    return configured.map((field) => field.trim()).filter(Boolean);
  }

  /** `sourceMode=latest_sprint` wins; absent explicit `queryMql` also triggers sprint flow for CLI-only setups. */
  private shouldUseLatestSprintFlow(): boolean {
    if (this.config.plugins.meegle.sourceMode === "latest_sprint") {
      return true;
    }
    return !(this.config.plugins.meegle.queryMql?.trim());
  }

  /** CLI paths require non-empty trimmed config; throws fast with `${NAME} is required`. */
  private requireMeegleConfig(name: string, value: string | null | undefined): string {
    const trimmed = value?.trim() ?? "";
    if (!trimmed) {
      throw new Error(`${name} is required when using the Meegle CLI`);
    }
    return trimmed;
  }

  /** Escapes user-controlled `nodeName` etc. for embedding inside MQL string literals. */
  private quoteMqlString(value: string): string {
    return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  }

  /** Attaches sprint snapshot under `metadata.latestSprint` for observability/linkage. */
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

function parseOptionalJsonObject(value: string): Record<string, unknown> {
  if (!value.trim()) {
    return {};
  }
  try {
    const parsed = parseJson(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readStringCandidate(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return undefined;
}

function readNumberCandidate(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function extractCommentPayload(value: unknown): Array<{
  id?: string;
  body: string;
  author?: string;
  createdAt: string;
}> {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (() => {
          const record = value as Record<string, unknown>;
          const nested = record.comments ?? record.items ?? record.data ?? record.list ?? record.records;
          return Array.isArray(nested) ? nested : [];
        })()
      : [];
  return rows
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const body = readStringCandidate(item, ["content", "body", "text", "comment", "message"]) ?? "";
      const createdAt = readStringCandidate(item, ["createdAt", "created_at", "timestamp"]) ?? new Date(0).toISOString();
      return {
        id: readStringCandidate(item, ["id", "commentId", "comment_id"]),
        body,
        author: readStringCandidate(item, ["author", "creator", "user", "createdBy", "created_by"]),
        createdAt
      };
    })
    .filter((item) => item.body.trim().length > 0);
}

function readHumanLoopRequestedAt(metadata: Record<string, unknown>): string | null {
  const humanLoop = metadata.humanLoop;
  if (!humanLoop || typeof humanLoop !== "object") {
    return null;
  }
  const requestedAt = (humanLoop as Record<string, unknown>).requestedAt;
  return typeof requestedAt === "string" && requestedAt.trim() ? requestedAt : null;
}

function buildReplyFingerprint(taskId: string, comment: { body: string; author?: string; createdAt: string }): string {
  return createHash("sha256")
    .update(`${taskId}:${comment.author ?? ""}:${comment.createdAt}:${comment.body}`)
    .digest("hex");
}
