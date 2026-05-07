import { Task } from "../../../packages/core/src/tasks/task.entity";
import { DashboardService } from "./dashboard.service";

describe("DashboardService", () => {
  it("returns aggregate task counts grouped by status", async () => {
    const tasks = [
      { status: "pending" },
      { status: "queued" },
      { status: "queued" },
      { status: "running" },
      { status: "done" },
      { status: "failed" }
    ] as Task[];
    const repository = {
      listTasks: jest.fn(async () => tasks)
    };
    const service = new DashboardService(repository as never);

    const stats = await service.getStats();

    expect(stats).toEqual({
      total: 6,
      pending: 1,
      queued: 2,
      running: 1,
      done: 1,
      failed: 1
    });
    expect(repository.listTasks).toHaveBeenCalledWith();
  });
});
