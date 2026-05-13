/**
 * 对 `TitingServices` 暴露的**调度操作**薄封装（tick、即时同步、即时派发）。
 *
 * ### 方法名与行为对照
 * - `recoverOfflineAgentsAndTasks` → 实际委托 `syncTaskIntegrations`（内部即 **集成拉单同步** `runTaskSyncNow`），
 *   **并非**单独触发「离线 Agent 恢复」；后者在完整 `runSchedulerTick` 流程里与 dispatch 一起执行。
 *   保留该命名主要为历史兼容；新代码请优先用 `runSchedulerTick` 或明确调用 `syncTaskIntegrations`。
 */
type SchedulerHost = {
  runSchedulerTick(): Promise<void>;
  runTaskSyncNow(): Promise<{ integrations: number; pulledTasks: number }>;
  runSchedulerDispatchNow(): Promise<{ queuedBefore: number }>;
  syncTaskIntegrations(): Promise<void>;
};

export class SchedulerService {
  constructor(private readonly host: SchedulerHost) {}

  /** 周期性入口：拉单 → 离线恢复 → 派发队列（见 `ServiceScheduler`）。 */
  runSchedulerTick(): Promise<void> {
    return this.host.runSchedulerTick();
  }

  /** 立即执行与各 integration 的 `pullTasks` 等同步逻辑。 */
  runTaskSyncNow(): Promise<{ integrations: number; pulledTasks: number }> {
    return this.host.runTaskSyncNow();
  }

  /** 仅派发阶段：统计派发前 `queued` 数量后执行 `dispatchQueuedTasks`。 */
  dispatchQueuedTasks(): Promise<{ queuedBefore: number }> {
    return this.host.runSchedulerDispatchNow();
  }

  /** @deprecated 见文件头：行为等同于 `syncTaskIntegrations`（集成同步），非字面意义的 recover。 */
  recoverOfflineAgentsAndTasks(): Promise<void> {
    return this.host.syncTaskIntegrations();
  }
}
