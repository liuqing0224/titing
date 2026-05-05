import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { resolveExecutionBranch } from "../tasks/task-branch";
import { RawMeegleTask } from "./task-mapper";

const execFileAsync = promisify(execFile);

export type CliRunResult = {
  stdout: string;
  stderr: string;
};

export type MeegleAuthStatus = {
  authenticated: boolean;
  host: string;
};

export type MeegleLoginInit = {
  clientId: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
};

export type MeegleLoginPollInput = {
  clientId: string;
  deviceCode: string;
  interval?: number;
  expiresIn?: number;
};

export type MeegleLoginPollResult = {
  authenticated: boolean;
  host: string;
};

export type CliRunner = {
  run(command: string, args: string[]): Promise<CliRunResult>;
};

export class MeegleCliError extends Error {
  readonly name = "MeegleCliError";

  constructor(
    message: string,
    readonly command: string,
    readonly args: string[],
    readonly stderr?: string,
    readonly stdout?: string
  ) {
    super(message);
  }
}

class ExecFileCliRunner implements CliRunner {
  async run(command: string, args: string[]): Promise<CliRunResult> {
    try {
      return await execFileAsync(command, args);
    } catch (error) {
      const failure = error as { message?: string; stderr?: string; stdout?: string };
      throw new MeegleCliError(
        failure.message ?? "Meegle CLI command failed",
        command,
        args,
        failure.stderr,
        failure.stdout
      );
    }
  }
}

@Injectable()
export class MeegleAdapter {
  private readonly logger = new Logger(MeegleAdapter.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly cliRunner: CliRunner = new ExecFileCliRunner()
  ) {}

  async listOpenTasks(): Promise<RawMeegleTask[]> {
    const cliBin = this.configService.get<string>("MEEGLE_CLI_BIN", "meegle");
    try {
      this.logger.log("Trying legacy meegle task list flow");
      const { stdout } = await this.cliRunner.run(cliBin, ["task", "list", "--status", "open"]);
      const listItems = this.extractTaskList(this.parseJson(stdout));
      const tasks: RawMeegleTask[] = [];

      for (const item of listItems) {
        const { stdout: detailStdout } = await this.cliRunner.run(cliBin, ["task", "get", item.id]);
        const detail = this.extractTaskDetail(this.parseJson(detailStdout));
        tasks.push(this.mergeTaskDetail(item, detail));
      }

      return tasks;
    } catch (error) {
      this.logger.warn(`Legacy meegle task flow failed, fallback=${error instanceof MeegleCliError && this.shouldFallbackToWorkitemCli(error)}`);
      if (!(error instanceof MeegleCliError) || !this.shouldFallbackToWorkitemCli(error)) {
        throw error;
      }
    }

    return this.listOpenTasksViaWorkitem(cliBin);
  }

  async getAuthStatus(): Promise<MeegleAuthStatus> {
    const cliBin = this.configService.get<string>("MEEGLE_CLI_BIN", "meegle");
    let stdout = "";
    try {
      ({ stdout } = await this.cliRunner.run(cliBin, ["auth", "status"]));
    } catch (error) {
      if (!(error instanceof MeegleCliError) || !error.stdout?.trim()) {
        throw error;
      }
      stdout = error.stdout;
    }
    const parsed = this.parseJson(stdout);
    if (!this.isRecord(parsed)) {
      throw new Error("Meegle auth status output is invalid");
    }

    const result = {
      authenticated: Boolean(parsed.authenticated),
      host: this.unwrapScalar(parsed.host) ?? this.getMeegleHost()
    };
    this.logger.log(`Meegle auth status authenticated=${result.authenticated} host=${result.host}`);
    return result;
  }

  async beginLogin(): Promise<MeegleLoginInit> {
    const cliBin = this.configService.get<string>("MEEGLE_CLI_BIN", "meegle");
    const { stdout } = await this.cliRunner.run(cliBin, [
      "auth",
      "login",
      "--device-code",
      "--phase",
      "init",
      "--host",
      this.getMeegleHost(),
      "--format",
      "json"
    ]);
    const parsed = this.parseJson(stdout);
    if (!this.isRecord(parsed)) {
      throw new Error("Meegle login init output is invalid");
    }

    const result = {
      clientId: this.unwrapScalar(parsed.client_id) ?? "",
      deviceCode: this.unwrapScalar(parsed.device_code) ?? "",
      expiresIn: Number(parsed.expires_in ?? 0),
      interval: Number(parsed.interval ?? 0),
      userCode: this.unwrapScalar(parsed.user_code) ?? "",
      verificationUri: this.unwrapScalar(parsed.verification_uri) ?? "",
      verificationUriComplete: this.unwrapScalar(parsed.verification_uri_complete) ?? ""
    };
    this.logger.log(`Started Meegle device login host=${this.getMeegleHost()} userCode=${result.userCode}`);
    return result;
  }

  async pollLogin(input: MeegleLoginPollInput): Promise<MeegleLoginPollResult> {
    const cliBin = this.configService.get<string>("MEEGLE_CLI_BIN", "meegle");
    try {
      this.logger.log(`Polling Meegle login deviceCode=${input.deviceCode}`);
      await this.cliRunner.run(cliBin, [
        "auth",
        "login",
        "--device-code",
        "--phase",
        "poll",
        "--host",
        this.getMeegleHost(),
        "--client-id",
        input.clientId,
        "--device-code-value",
        input.deviceCode,
        "--interval",
        String(input.interval ?? 5),
        "--expires-in",
        String(input.expiresIn ?? 600),
        "--once",
        "--format",
        "json"
      ]);
    } catch (error) {
      if (error instanceof MeegleCliError) {
        const authStatus = await this.getAuthStatus();
        return {
          authenticated: authStatus.authenticated,
          host: authStatus.host
        };
      }
      throw error;
    }

    const authStatus = await this.getAuthStatus();
    const result = {
      authenticated: authStatus.authenticated,
      host: authStatus.host
    };
    this.logger.log(`Meegle login poll result authenticated=${result.authenticated}`);
    return result;
  }

  async addComment(taskId: string, text: string): Promise<void> {
    const args = [
      "comment",
      "add",
      "--work-item-id",
      taskId,
      "--content",
      text
    ];
    const projectKey = this.configService.get<string>("MEEGLE_PROJECT_KEY", "").trim();
    if (projectKey) {
      args.push("--project-key", projectKey);
    }
    this.logger.log(`Adding Meegle comment to taskId=${taskId}`);
    await this.cliRunner.run(this.configService.get<string>("MEEGLE_CLI_BIN", "meegle"), args);
  }

  private async listOpenTasksViaWorkitem(cliBin: string): Promise<RawMeegleTask[]> {
    if (this.shouldUseLatestSprintFlow()) {
      return this.listOpenTasksViaLatestSprint(cliBin);
    }
    const projectKey = this.getRequiredConfig("MEEGLE_PROJECT_KEY");
    const mql = this.getRequiredConfig("MEEGLE_QUERY_MQL");
    this.logger.log(`Running Meegle MQL source projectKey=${projectKey} mql=${JSON.stringify(mql)}`);
    const { stdout } = await this.cliRunner.run(cliBin, [
      "workitem",
      "query",
      "--project-key",
      projectKey,
      "--mql",
      mql
    ]);
    const listItems = this.extractTaskList(this.parseJson(stdout)).map((item) => ({
      ...item,
      projectKey
    }));
    const tasks: RawMeegleTask[] = [];

    for (const item of listItems) {
      const args = ["workitem", "get", "--work-item-id", item.id, "--project-key", projectKey];
      for (const field of this.getDetailFields()) {
        args.push("--fields", field);
      }
      const { stdout: detailStdout } = await this.cliRunner.run(cliBin, args);
      const detail = this.extractTaskDetail(this.parseJson(detailStdout));
      tasks.push(this.mergeTaskDetail(item, detail, projectKey));
    }

    this.logger.log(`Meegle MQL source returned ${tasks.length} task(s)`);
    return tasks;
  }

  private async listOpenTasksViaLatestSprint(cliBin: string): Promise<RawMeegleTask[]> {
    const projectKey = this.getRequiredConfig("MEEGLE_PROJECT_KEY");
    const projectScopeName = this.getRequiredConfig("MEEGLE_PROJECT_SCOPE_NAME");
    const sprintTypeName = this.getRequiredConfig("MEEGLE_SPRINT_TYPE_NAME");
    const demandTypeName = this.getRequiredConfig("MEEGLE_DEMAND_TYPE_NAME");
    const sprintLinkField = this.getRequiredConfig("MEEGLE_SPRINT_LINK_FIELD");
    const nodeName = this.getRequiredConfig("MEEGLE_NODE_NAME");

    const sprintQuery =
      `SELECT \`工作项id\`, \`名称\`, \`状态\` FROM \`${projectScopeName}\`.\`${sprintTypeName}\` ` +
      "ORDER BY `工作项id` DESC LIMIT 1";
    this.logger.log(`Running latest sprint query projectKey=${projectKey} mql=${JSON.stringify(sprintQuery)}`);
    const { stdout: sprintStdout } = await this.cliRunner.run(cliBin, [
      "workitem",
      "query",
      "--project-key",
      projectKey,
      "--mql",
      sprintQuery
    ]);
    const sprintRows = this.extractTaskList(this.parseJson(sprintStdout));
    const sprintId = sprintRows[0]?.id?.trim();
    if (!sprintId) {
      this.logger.warn("Latest sprint query returned no sprint id");
      return [];
    }
    this.logger.log(`Resolved latest sprint id=${sprintId}`);

    const demandQuery =
      `SELECT \`工作项id\`, \`名称\` FROM \`${projectScopeName}\`.\`${demandTypeName}\` ` +
      `WHERE any_relation_match(\`${sprintLinkField}\`, x -> x.\`工作项ID<target:all>\` = ${sprintId}) ` +
      `AND array_contains(in_progress_nodes_name(), '${nodeName.replace(/'/g, "\\'")}') ` +
      "ORDER BY `工作项id` DESC LIMIT 200";
    this.logger.log(`Running latest sprint demand query projectKey=${projectKey} mql=${JSON.stringify(demandQuery)}`);
    const { stdout: demandStdout } = await this.cliRunner.run(cliBin, [
      "workitem",
      "query",
      "--project-key",
      projectKey,
      "--mql",
      demandQuery
    ]);
    const listItems = this.extractTaskList(this.parseJson(demandStdout));
    const detailFields = this.getLatestSprintDetailFields();
    const tasks: RawMeegleTask[] = [];

    for (const item of listItems) {
      const args = ["workitem", "get", "--work-item-id", item.id, "--project-key", projectKey];
      for (const field of detailFields) {
        args.push("--fields", field);
      }
      const { stdout: detailStdout } = await this.cliRunner.run(cliBin, args);
      const detail = this.extractTaskDetail(this.parseJson(detailStdout));
      const merged = this.mergeTaskDetail(item, detail, projectKey);
      tasks.push(this.applyDescriptionFallback(merged));
    }

    this.logger.log(`Latest sprint source returned ${tasks.length} task(s)`);
    return tasks;
  }

  private parseJson(stdout: string): unknown {
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error("Meegle CLI returned non-JSON output");
    }
  }

  private extractTaskList(value: unknown): RawMeegleTask[] {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeRawTask(item));
    }
    if (this.isRecord(value)) {
      if (Array.isArray(value.moql_field_list)) {
        return [this.normalizeRawTask(value)];
      }
      const nested =
        value.tasks ??
        value.items ??
        value.data ??
        value.workItems ??
        value.work_items ??
        value.list ??
        value.records;
      if (Array.isArray(nested)) {
        return nested.map((item) => this.normalizeRawTask(item));
      }
      if (this.isRecord(nested)) {
        const groupedItems = Object.values(nested).filter(Array.isArray).flat();
        if (groupedItems.length > 0) {
          return groupedItems.map((item) => this.normalizeRawTask(item));
        }
        return this.extractTaskList(nested);
      }
    }
    throw new Error("Meegle task list output does not contain tasks");
  }

  private extractTaskDetail(value: unknown): Partial<RawMeegleTask> {
    const detail = this.isRecord(value) && this.isRecord(value.data) ? value.data : value;
    if (!this.isRecord(detail)) {
      return {};
    }

    if (this.isRecord(detail.work_item_attribute)) {
      const attribute = detail.work_item_attribute;
      const normalized: Record<string, unknown> = {
        work_item_id: attribute.work_item_id,
        name: attribute.work_item_name,
        priority: this.readNestedStatusName(attribute.work_item_status),
        project_key: this.isRecord(attribute.owned_project)
          ? (attribute.owned_project.key ?? attribute.owned_project.simple_name)
          : undefined
      };

      if (Array.isArray(detail.work_item_fields)) {
        const fields: Record<string, unknown> = {};
        for (const field of detail.work_item_fields) {
          if (!this.isRecord(field)) {
            continue;
          }
          const key = this.unwrapScalar(field.key) ?? this.unwrapScalar(field.name);
          if (!key) {
            continue;
          }
          fields[key] = field.value;
        }
        normalized.fields = fields;
      }

      return this.normalizeRawTask(normalized);
    }

    return this.normalizeRawTask(detail);
  }

  private normalizeRawTask(value: unknown): RawMeegleTask {
    const normalizedValue = this.normalizeMoqlRecord(value);
    if (!this.isRecord(normalizedValue)) {
      throw new Error("Meegle task output is missing id");
    }

    const id = this.readString(normalizedValue, [
      "id",
      "workItemId",
      "work_item_id",
      "workitem_id",
      "工作项ID",
      "工作项id"
    ]);

    if (!id) {
      throw new Error("Meegle task output is missing id");
    }

    return {
      id,
      title: this.readString(normalizedValue, ["title", "name", "名称"]) ?? "",
      description: this.readString(normalizedValue, ["description", "desc", "描述"]),
      repo: this.readString(normalizedValue, ["repo", "repository", "代码库", "仓库"]),
      branch: this.readString(normalizedValue, ["branch", "分支"]),
      instruction: this.readString(normalizedValue, ["instruction", "prompt", "指令"]),
      priority: this.readString(normalizedValue, ["priority", "优先级", "status", "状态"]),
      projectKey: this.readString(normalizedValue, ["projectKey", "project_key", "项目key", "空间key"])
    };
  }

  private normalizeMoqlRecord(value: unknown): unknown {
    if (!this.isRecord(value) || !Array.isArray(value.moql_field_list)) {
      return value;
    }

    const normalized: Record<string, unknown> = {};
    const fields: Record<string, unknown> = {};

    for (const entry of value.moql_field_list) {
      if (!this.isRecord(entry)) {
        continue;
      }
      const key = this.unwrapScalar(entry.key);
      const name = this.unwrapScalar(entry.name);
      const fieldValue = entry.value;

      if (key) {
        normalized[key] = fieldValue;
        fields[key] = fieldValue;
      }
      if (name) {
        normalized[name] = fieldValue;
        fields[name] = fieldValue;
      }
    }

    normalized.fields = fields;
    return normalized;
  }

  private mergeTaskDetail(
    listItem: RawMeegleTask,
    detail: Partial<RawMeegleTask>,
    projectKey?: string
  ): RawMeegleTask {
    return {
      id: detail.id ?? listItem.id,
      title: detail.title || listItem.title,
      description: detail.description ?? listItem.description ?? null,
      repo: detail.repo ?? listItem.repo ?? null,
      branch: detail.branch ?? listItem.branch ?? null,
      instruction: detail.instruction ?? listItem.instruction ?? null,
      priority: detail.priority ?? listItem.priority ?? null,
      projectKey: detail.projectKey ?? listItem.projectKey ?? projectKey ?? null
    };
  }

  private applyDescriptionFallback(task: RawMeegleTask): RawMeegleTask {
    if (task.repo?.trim() && task.instruction?.trim()) {
      return task;
    }
    if (!task.description?.trim()) {
      return task;
    }

    try {
      const parsed = this.parseDescriptionBlock(task.description);
      return {
        ...task,
        repo: task.repo?.trim() || parsed.localPath || parsed.repo,
        branch: resolveExecutionBranch(task.branch?.trim() || parsed.branch),
        instruction: task.instruction?.trim() || parsed.instruction
      };
    } catch {
      return task;
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private readString(value: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const direct = this.unwrapScalar(value[key]);
      if (direct) {
        return direct;
      }
    }

    for (const containerKey of ["fields", "field_values", "fieldValues", "custom_fields", "customFields"]) {
      const container = value[containerKey];
      if (!this.isRecord(container)) {
        continue;
      }
      for (const key of keys) {
        const nested = this.unwrapScalar(container[key]);
        if (nested) {
          return nested;
        }
      }
    }

    return null;
  }

  private unwrapScalar(value: unknown): string | null {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      const items = value
        .map((item) => this.unwrapScalar(item))
        .filter((item): item is string => Boolean(item));
      return items.length > 0 ? items.join(", ") : null;
    }
    if (!this.isRecord(value)) {
      return null;
    }

    for (const key of [
      "value",
      "text",
      "label",
      "name",
      "display_value",
      "displayValue",
      "string_value",
      "long_value",
      "double_value",
      "float_value",
      "bool_value",
      "key_label_value_list"
    ]) {
      const nested = value[key];
      const result = this.unwrapScalar(nested);
      if (result) {
        return result;
      }
    }

    return null;
  }

  private shouldFallbackToWorkitemCli(error: MeegleCliError): boolean {
    const stderr = error.stderr ?? "";
    return error.args[0] === "task" && /unknown command|command not found/i.test(stderr || error.message);
  }

  private getRequiredConfig(key: string): string {
    const value = this.configService.get<string>(key, "").trim();
    if (!value) {
      throw new Error(`${key} is required when using the modern Meegle CLI`);
    }
    return value;
  }

  private getDetailFields(): string[] {
    const configured = this.configService.get<string>(
      "MEEGLE_DETAIL_FIELDS",
      "repo,branch,instruction,priority,description,title"
    );
    return configured
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
  }

  private getLatestSprintDetailFields(): string[] {
    const configured = this.configService.get<string>("MEEGLE_LATEST_SPRINT_DETAIL_FIELDS", "description");
    return configured
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
  }

  private shouldUseLatestSprintFlow(): boolean {
    const explicitMode = this.configService.get<string>("MEEGLE_SOURCE_MODE", "").trim().toLowerCase();
    if (explicitMode === "latest_sprint") {
      return true;
    }
    return !this.configService.get<string>("MEEGLE_QUERY_MQL", "").trim();
  }

  private getMeegleHost(): string {
    return this.configService.get<string>("MEEGLE_HOST", "project.feishu.cn");
  }

  private parseDescriptionBlock(description: string): {
    repo: string;
    branch?: string;
    localPath?: string;
    instruction: string;
  } {
    const normalized = description.replace(/\r\n/g, "\n").trim();
    const separator = normalized.match(/\n\s*---\s*\n/);
    if (!separator || separator.index === undefined) {
      throw new Error("description missing metadata separator");
    }
    const header = normalized.slice(0, separator.index).split("\n");
    const instruction = normalized.slice(separator.index + separator[0].length).trim();
    if (!instruction) {
      throw new Error("description missing instruction");
    }

    let repo: string | undefined;
    let branch: string | undefined;
    let localPath: string | undefined;

    for (const rawLine of header) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (line.startsWith("Repo:")) {
        repo = this.normalizeMetadataValue(line.slice("Repo:".length));
        continue;
      }
      if (line.startsWith("Branch:")) {
        branch = this.normalizeMetadataValue(line.slice("Branch:".length)) || undefined;
        continue;
      }
      if (line.startsWith("LocalPath:")) {
        localPath = this.normalizeMetadataValue(line.slice("LocalPath:".length)) || undefined;
        continue;
      }
      if (line === "Constraints:" || line.startsWith("- ")) {
        continue;
      }
    }

    if (!repo) {
      throw new Error("description missing repo");
    }

    return {
      repo,
      branch,
      localPath: localPath ? path.resolve(localPath) : undefined,
      instruction
    };
  }

  private normalizeMetadataValue(value: string): string {
    const trimmed = value.trim();
    const markdownLink = trimmed.match(/^\[(.+?)\]\((.+?)\)$/);
    if (markdownLink) {
      return markdownLink[2].trim();
    }
    return trimmed;
  }

  private readNestedStatusName(value: unknown): string | null {
    if (!this.isRecord(value)) {
      return null;
    }
    return this.unwrapScalar(value.name) ?? this.unwrapScalar(value.label);
  }
}
