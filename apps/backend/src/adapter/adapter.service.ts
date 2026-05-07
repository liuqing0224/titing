import { Injectable, Logger, Optional, UnauthorizedException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EventsService } from "../events/events.service";
import { ExecutionLogService } from "../execution-logs/execution-log.service";
import { SettingsService } from "../settings/settings.service";
import { normalizeStoredBranch } from "../tasks/task-branch";
import { Task } from "../tasks/task.entity";
import { hasValidExecutionFields } from "../tasks/task-status";
import { BrowserLauncherService } from "./browser-launcher.service";
import { MeegleLoginPollInput } from "./meegle.adapter";
import { MeegleTaskSourcePlugin } from "./meegle-task-source.plugin";
import { mapRawTaskToTaskInput, RawMeegleTask } from "./task-mapper";

export type SyncItemAction = "created" | "updated" | "failed" | "recovered" | "resetToPending";

export type SyncResult = {
  summary: {
    created: number;
    updated: number;
    failed: number;
    recovered: number;
    resetToPending: number;
  };
  items: Array<{
    externalId: string;
    taskId?: string;
    action: SyncItemAction;
    reason: string;
  }>;
};

@Injectable()
export class AdapterService {
  private readonly logger = new Logger(AdapterService.name);
  private syncPromise: Promise<SyncResult> | null = null;
  private loginRecoveryPromise: Promise<void> | null = null;

  constructor(
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>,
    private readonly executionLogService: ExecutionLogService,
    private readonly taskSource: MeegleTaskSourcePlugin,
    private readonly browserLauncher: BrowserLauncherService,
    private readonly settingsService: SettingsService,
    @Optional()
    private readonly eventsService?: EventsService
  ) {}

  async sync(): Promise<SyncResult> {
    if (!this.syncPromise) {
      this.syncPromise = this.runSync().finally(() => {
        this.syncPromise = null;
      });
    }

    return this.syncPromise;
  }

  async listRawTasks(): Promise<RawMeegleTask[]> {
    await this.ensureMeegleAuthenticated();
    return this.taskSource.listOpenTasks();
  }

  async beginLogin() {
    const login = await this.taskSource.beginLogin();
    const verificationUri = login.verificationUriComplete || login.verificationUri;
    const openedViaSse = Boolean(this.eventsService?.hasSubscribers());
    await this.settingsService.setMeegleLoginState({
      browserPending: true,
      verificationUri,
      userCode: login.userCode
    });
    if (openedViaSse) {
      this.eventsService?.publishMeegleLoginRequired(verificationUri, login.userCode);
    } else {
      await this.browserLauncher.open(verificationUri);
    }
    return login;
  }

  async pollLogin(input: MeegleLoginPollInput) {
    return this.taskSource.pollLogin(input);
  }

  private async upsertRawTask(rawTask: RawMeegleTask): Promise<SyncResult["items"][number]> {
    const input = mapRawTaskToTaskInput(rawTask);
    const existing = await this.taskRepository.findOne({ where: { externalId: rawTask.id } });
    const task = existing ?? this.taskRepository.create(input);
    const previousExecutionKey = this.getExecutionKey(task);

    Object.assign(task, {
      title: input.title,
      description: input.description,
      repo: input.repo,
      branch: normalizeStoredBranch(input.branch),
      instruction: input.instruction,
      priority: input.priority,
      taskType: input.taskType
    });

    if (!existing) {
      task.status = hasValidExecutionFields(task) ? "pending" : "failed";
      const saved = await this.taskRepository.save(task);
      if (saved.status === "failed") {
        await this.appendInvalidLog(saved);
        this.publishTask(saved);
        return {
          externalId: rawTask.id,
          taskId: saved.id,
          action: "failed",
          reason: "missing execution fields"
        };
      }
      this.publishTask(saved);
      return {
        externalId: rawTask.id,
        taskId: saved.id,
        action: "created",
        reason: "new task imported"
      };
    }

    const nextExecutionKey = this.getExecutionKey(task);
    if (!hasValidExecutionFields(task)) {
      task.status = "failed";
      const saved = await this.taskRepository.save(task);
      await this.appendInvalidLog(saved);
      this.publishTask(saved);
      return {
        externalId: rawTask.id,
        taskId: saved.id,
        action: "failed",
        reason: "missing execution fields"
      };
    }

    if (existing.status === "failed") {
      this.clearRuntimeFields(task);
      task.status = "pending";
      const saved = await this.taskRepository.save(task);
      this.publishTask(saved);
      return {
        externalId: rawTask.id,
        taskId: saved.id,
        action: "recovered",
        reason: "failed task became valid"
      };
    }

    if (existing.status === "done" && previousExecutionKey !== nextExecutionKey) {
      this.clearRuntimeFields(task);
      task.status = "pending";
      const saved = await this.taskRepository.save(task);
      this.publishTask(saved);
      return {
        externalId: rawTask.id,
        taskId: saved.id,
        action: "resetToPending",
        reason: "execution fields changed after done"
      };
    }

    const saved = await this.taskRepository.save(task);
    this.publishTask(saved);
    return {
      externalId: rawTask.id,
      taskId: saved.id,
      action: "updated",
      reason: "existing task updated"
    };
  }

  private createEmptyResult(): SyncResult {
    return {
      summary: {
        created: 0,
        updated: 0,
        failed: 0,
        recovered: 0,
        resetToPending: 0
      },
      items: []
    };
  }

  private getExecutionKey(task: Pick<Task, "repo" | "branch" | "instruction">): string {
    return JSON.stringify({
      repo: task.repo,
      branch: task.branch,
      instruction: task.instruction
    });
  }

  private clearRuntimeFields(task: Task): void {
    task.agentId = null;
    task.claimedAt = null;
    task.startedAt = null;
    task.completedAt = null;
  }

  private async appendInvalidLog(task: Task): Promise<void> {
    await this.executionLogService.append({
      taskId: task.id,
      agentId: task.agentId,
      status: "failed",
      message: "Task execution fields are invalid",
        metadata: {
          missingFields: [
            task.repo?.trim() ? null : "repo",
            task.instruction?.trim() ? null : "instruction"
          ].filter(Boolean)
        }
    });
  }

  private publishTask(task: Task): void {
    this.eventsService?.publishTaskLifecycle(task.id, task.status, task.agentId);
  }

  private async runSync(): Promise<SyncResult> {
    this.logger.log("Starting Meegle sync");
    await this.ensureMeegleAuthenticated();
    const rawTasks = await this.taskSource.listOpenTasks();
    this.logger.log(`Fetched ${rawTasks.length} raw task(s) from Meegle`);
    const result = this.createEmptyResult();

    for (const rawTask of rawTasks) {
      this.logger.log(`Upserting task externalId=${rawTask.id} title=${JSON.stringify(rawTask.title)}`);
      const item = await this.upsertRawTask(rawTask);
      result.items.push(item);
      result.summary[item.action] += 1;
    }

    this.logger.log(`Finished Meegle sync: ${JSON.stringify(result.summary)}`);
    return result;
  }

  private async ensureMeegleAuthenticated(): Promise<void> {
    const authStatus = await this.taskSource.getAuthStatus();
    if (authStatus.authenticated) {
      await this.settingsService.setMeegleLoginState({
        browserPending: false,
        verificationUri: null,
        userCode: null
      });
      return;
    }

    await this.recoverAuthentication();
  }

  private async recoverAuthentication(): Promise<void> {
    if (!this.loginRecoveryPromise) {
      this.loginRecoveryPromise = this.runLoginRecovery().finally(() => {
        this.loginRecoveryPromise = null;
      });
    }

    await this.loginRecoveryPromise;
  }

  private async runLoginRecovery(): Promise<void> {
    await this.settingsService.setMeegleLoginState({
      browserPending: false,
      verificationUri: null,
      userCode: null
    });
    const login = await this.beginLogin();
    this.logger.warn(`Meegle login required; opened browser for deviceCode=${login.deviceCode}`);
    const deadline = Date.now() + login.expiresIn * 1000;

    while (Date.now() < deadline) {
      await this.sleep(Math.max(login.interval, 1) * 1000);
      const status = await this.taskSource.pollLogin({
        clientId: login.clientId,
        deviceCode: login.deviceCode,
        interval: login.interval,
        expiresIn: login.expiresIn
      });
      if (!status.authenticated) {
        continue;
      }

      await this.settingsService.setMeegleLoginState({
        browserPending: false,
        verificationUri: null,
        userCode: null
      });
      return;
    }

    await this.settingsService.setMeegleLoginState({
      browserPending: false,
      verificationUri: null,
      userCode: null
    });
    throw new UnauthorizedException("Meegle login timed out");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
