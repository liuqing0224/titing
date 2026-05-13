import { CreateTaskInput, TitingTask } from "@titing/plugin-api";

/**
 * `TitingServices` 上**写路径**子集的稳定外观：创建/校验/入队/重试/阻塞/人工/恢复/取消。
 * 用于 UI 或 API 层按「仅允许变更」维度拆分包（与 `TaskQueryService` 对称）。
 */
type CommandHost = {
  createTask(input: CreateTaskInput): Promise<TitingTask>;
  validateTask(id: string, operator?: string): Promise<TitingTask>;
  queueTask(id: string, operator?: string): Promise<TitingTask>;
  retryTask(id: string, operator?: string): Promise<TitingTask>;
  blockTask(id: string, reason?: string, operator?: string): Promise<TitingTask>;
  markNeedsHuman(id: string, reason?: string, operator?: string): Promise<TitingTask>;
  recoverTask(id: string, operator?: string, reason?: string): Promise<TitingTask>;
  cancelTask(id: string, operator?: string): Promise<TitingTask>;
};

export class TaskCommandService {
  constructor(private readonly host: CommandHost) {}

  createTask(input: CreateTaskInput): Promise<TitingTask> {
    return this.host.createTask(input);
  }

  validateTask(id: string, operator?: string): Promise<TitingTask> {
    return this.host.validateTask(id, operator);
  }

  queueTask(id: string, operator?: string): Promise<TitingTask> {
    return this.host.queueTask(id, operator);
  }

  retryTask(id: string, operator?: string): Promise<TitingTask> {
    return this.host.retryTask(id, operator);
  }

  blockTask(id: string, reason?: string, operator?: string): Promise<TitingTask> {
    return this.host.blockTask(id, reason, operator);
  }

  markNeedsHuman(id: string, reason?: string, operator?: string): Promise<TitingTask> {
    return this.host.markNeedsHuman(id, reason, operator);
  }

  recoverTask(id: string, operator?: string, reason?: string): Promise<TitingTask> {
    return this.host.recoverTask(id, operator, reason);
  }

  cancelTask(id: string, operator?: string): Promise<TitingTask> {
    return this.host.cancelTask(id, operator);
  }
}
