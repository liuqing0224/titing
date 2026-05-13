import { AgentRecord, TitingTask } from "@titing/plugin-api";

/**
 * 对外可选的**执行编排**薄层：当前实现将 `runTask` 简化为触发一次 `runSchedulerTick`，
 * 将 `handleRetryableExecutionFailure` 映射为 `retryTask`。
 *
 * 与真正在 Agent 上跑 `ServiceExecution.runTask` 的路径不同；若嵌入自定义 Runner，可在此替换策略。
 */
type ExecutionHost = {
  runSchedulerTick(): Promise<void>;
  retryTask(id: string, operator?: string): Promise<TitingTask>;
};

export class ExecutionOrchestrator {
  constructor(private readonly host: ExecutionHost) {}

  async runTask(_task: TitingTask, _agent: AgentRecord): Promise<void> {
    await this.host.runSchedulerTick();
  }

  async handleRetryableExecutionFailure(task: TitingTask, operator = "scheduler"): Promise<TitingTask> {
    return this.host.retryTask(task.id, operator);
  }
}
