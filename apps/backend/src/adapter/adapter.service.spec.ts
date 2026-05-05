import { Task } from "../tasks/task.entity";
import { AdapterService } from "./adapter.service";
import { RawMeegleTask } from "./task-mapper";

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "auto-existing",
    source: "meegle",
    externalId: "MEEGLE-1",
    title: "Existing task",
    description: "old",
    repo: "demo/repo",
    branch: "main",
    taskType: "feature",
    priority: "medium",
    status: "pending",
    instruction: "Old instruction",
    constraints: [],
    retryCount: 0,
    claimedAt: null,
    startedAt: null,
    completedAt: null,
    agentId: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides
  }) as Task;

const createRepository = (initialTasks: Task[] = []) => {
  const store = new Map<string, Task>();
  for (const task of initialTasks) {
    store.set(task.id, task);
  }

  return {
    findOne: jest.fn(async ({ where }: { where: { externalId?: string; id?: string } }) => {
      const tasks = Array.from(store.values());
      if (where.externalId) {
        return tasks.find((task) => task.externalId === where.externalId) ?? null;
      }
      if (where.id) {
        return store.get(where.id) ?? null;
      }
      return null;
    }),
    create: jest.fn((input: Partial<Task>) => input as Task),
    save: jest.fn(async (task: Task) => {
      store.set(task.id, task);
      return task;
    }),
    store
  };
};

const createLogService = () => ({
  append: jest.fn(async () => undefined)
});

const createMeegleAdapter = (tasks: RawMeegleTask[], authenticated = true) => ({
  listOpenTasks: jest.fn(async () => tasks),
  getAuthStatus: jest.fn(async () => ({ authenticated, host: "project.feishu.cn" })),
  beginLogin: jest.fn(async () => ({
    clientId: "client",
    deviceCode: "device",
    expiresIn: 1800,
    interval: 5,
    userCode: "ABC-123",
    verificationUri: "https://project.feishu.cn/b/auth/mcp",
    verificationUriComplete: "https://project.feishu.cn/b/auth/mcp?usercode=ABC-123"
  }))
});

describe("AdapterService", () => {
  it("creates failed task and log when synced task lacks execution fields", async () => {
    const repository = createRepository();
    const logService = createLogService();
    const service = new AdapterService(
      repository as never,
      logService as never,
      createMeegleAdapter([
        {
          id: "MEEGLE-1",
          title: "Missing instruction",
          description: "No instruction",
          repo: "demo/repo",
          branch: "main"
        }
      ]) as never
    );

    const result = await service.sync();

    expect(result.summary.failed).toBe(1);
    expect(result.items[0].action).toBe("failed");
    expect(logService.append).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        message: "Task execution fields are invalid"
      })
    );
  });

  it("recovers failed task to pending when sync supplies valid execution fields", async () => {
    const repository = createRepository([
      createTask({
        status: "failed",
        repo: "",
        branch: "main",
        instruction: null,
        agentId: "agent-1",
        claimedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date()
      })
    ]);
    const service = new AdapterService(
      repository as never,
      createLogService() as never,
      createMeegleAdapter([
        {
          id: "MEEGLE-1",
          title: "Recovered task",
          repo: "demo/repo",
          branch: "main",
          instruction: "Run again"
        }
      ]) as never
    );

    const result = await service.sync();
    const saved = repository.store.get("auto-existing");

    expect(result.summary.recovered).toBe(1);
    expect(saved?.status).toBe("pending");
    expect(saved?.agentId).toBeNull();
    expect(saved?.claimedAt).toBeNull();
    expect(saved?.startedAt).toBeNull();
    expect(saved?.completedAt).toBeNull();
  });

  it("resets done task to pending when repo branch or instruction changes", async () => {
    const repository = createRepository([createTask({ status: "done" })]);
    const service = new AdapterService(
      repository as never,
      createLogService() as never,
      createMeegleAdapter([
        {
          id: "MEEGLE-1",
          title: "Changed instruction",
          repo: "demo/repo",
          branch: "main",
          instruction: "New instruction"
        }
      ]) as never
    );

    const result = await service.sync();
    const saved = repository.store.get("auto-existing");

    expect(result.summary.resetToPending).toBe(1);
    expect(saved?.status).toBe("pending");
  });

  it("throws unauthorized when Meegle login is required", async () => {
    const service = new AdapterService(
      createRepository() as never,
      createLogService() as never,
      createMeegleAdapter([], false) as never
    );

    await expect(service.sync()).rejects.toThrow("Meegle login required");
  });

  it("generates a feature branch when synced task has no branch", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-05T21:01:02.000Z"));
    const repository = createRepository();
    const service = new AdapterService(
      repository as never,
      createLogService() as never,
      createMeegleAdapter([
        {
          id: "MEEGLE-1",
          title: "Missing branch",
          repo: "demo/repo",
          branch: "",
          instruction: "Implement it"
        }
      ]) as never
    );

    await service.sync();

    expect(Array.from(repository.store.values())[0]?.branch).toBe("feature/20260506050102");
    jest.useRealTimers();
  });
});
