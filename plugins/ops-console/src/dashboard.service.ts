import { Inject, Injectable } from "@nestjs/common";
import { TASK_STORE_PLUGIN } from "../../../packages/core/src/plugins/plugin.tokens";
import { TaskStorePlugin } from "../../../packages/core/src/plugins/task-store.plugin";
import { Task, TaskStatus } from "../../../packages/core/src/tasks/task.entity";

export type DashboardStats = Record<"total" | TaskStatus, number>;

@Injectable()
export class DashboardService {
  constructor(
    @Inject(TASK_STORE_PLUGIN)
    private readonly taskStore: TaskStorePlugin
  ) {}

  async getStats(): Promise<DashboardStats> {
    const tasks = await this.taskStore.listTasks();
    const counts = tasks.reduce(
      (result, task) => {
        result[task.status] += 1;
        return result;
      },
      {
        pending: 0,
        queued: 0,
        running: 0,
        done: 0,
        failed: 0
      } satisfies Record<TaskStatus, number>
    );

    return {
      total: tasks.length,
      pending: counts.pending,
      queued: counts.queued,
      running: counts.running,
      done: counts.done,
      failed: counts.failed
    };
  }
}
