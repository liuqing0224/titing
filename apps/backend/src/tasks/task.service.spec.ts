import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Task } from "./task.entity";
import { TaskService } from "./task.service";

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "auto-1",
    source: "meegle",
    externalId: "MEEGLE-1",
    title: "Implement lifecycle",
    description: null,
    repo: "demo/repo",
    branch: "main",
    taskType: "feature",
    priority: "medium",
    status: "pending",
    instruction: "Implement it",
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

const createRepository = (initialTask?: Task) => {
  const store = new Map<string, Task>();
  if (initialTask) {
    store.set(initialTask.id, initialTask);
  }

  return {
    find: jest.fn(async () => Array.from(store.values())),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null),
    save: jest.fn(async (task: Task) => {
      store.set(task.id, task);
      return task;
    }),
    create: jest.fn((input: Partial<Task>) => input as Task),
    store
  };
};

const createLogService = () => ({
  append: jest.fn(async () => undefined)
});

const createEventsService = () => ({
  publishTaskLifecycle: jest.fn()
});

describe("TaskService", () => {
  it("enqueues a pending task", async () => {
    const repository = createRepository(createTask());
    const eventsService = createEventsService();
    const service = new TaskService(repository as never, createLogService() as never, eventsService as never);

    const task = await service.enqueue("auto-1");

    expect(task.status).toBe("queued");
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ status: "queued" }));
    expect(eventsService.publishTaskLifecycle).toHaveBeenCalledWith("auto-1", "queued", null);
  });

  it("claims a queued task and records runtime fields", async () => {
    const repository = createRepository(createTask({ status: "queued" }));
    const eventsService = createEventsService();
    const service = new TaskService(repository as never, createLogService() as never, eventsService as never);

    const task = await service.claim("auto-1", "agent-1");

    expect(task.status).toBe("running");
    expect(task.agentId).toBe("agent-1");
    expect(task.claimedAt).toBeInstanceOf(Date);
    expect(task.startedAt).toBeInstanceOf(Date);
    expect(eventsService.publishTaskLifecycle).toHaveBeenCalledWith("auto-1", "running", "agent-1");
  });

  it("rejects invalid lifecycle transitions", async () => {
    const repository = createRepository(createTask({ status: "done" }));
    const service = new TaskService(repository as never, createLogService() as never);

    await expect(service.enqueue("auto-1")).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.claim("auto-1", "agent-1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("updates execution fields on pending queued and failed tasks then resets to pending when valid", async () => {
    const repository = createRepository(createTask({ status: "queued" }));
    const service = new TaskService(repository as never, createLogService() as never);

    const task = await service.updateExecutionFields("auto-1", {
      repo: "demo/updated",
      branch: "feature/demo",
      instruction: "Run the updated instruction"
    });

    expect(task.status).toBe("pending");
    expect(task.repo).toBe("demo/updated");
    expect(task.branch).toBe("feature/demo");
    expect(task.instruction).toBe("Run the updated instruction");
  });

  it("marks task failed when edited execution fields are invalid", async () => {
    const repository = createRepository(createTask({ status: "failed" }));
    const logService = createLogService();
    const service = new TaskService(repository as never, logService as never);

    const task = await service.updateExecutionFields("auto-1", {
      instruction: ""
    });

    expect(task.status).toBe("failed");
    expect(logService.append).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "auto-1",
        status: "failed"
      })
    );
  });

  it("throws not found for missing tasks", async () => {
    const repository = createRepository();
    const service = new TaskService(repository as never, createLogService() as never);

    await expect(service.getTask("missing")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("retries only failed tasks by moving them to queued while preserving runtime fields", async () => {
    const claimedAt = new Date("2026-05-01T00:00:00.000Z");
    const startedAt = new Date("2026-05-01T00:01:00.000Z");
    const completedAt = new Date("2026-05-01T00:02:00.000Z");
    const repository = createRepository(
      createTask({
        status: "failed",
        retryCount: 1,
        agentId: "agent-1",
        claimedAt,
        startedAt,
        completedAt
      })
    );
    const service = new TaskService(repository as never, createLogService() as never, createEventsService() as never);

    const task = await service.retryFailed("auto-1");

    expect(task.status).toBe("queued");
    expect(task.retryCount).toBe(1);
    expect(task.agentId).toBe("agent-1");
    expect(task.claimedAt).toBe(claimedAt);
    expect(task.startedAt).toBe(startedAt);
    expect(task.completedAt).toBe(completedAt);
  });

  it("rejects retry for non-failed tasks", async () => {
    const repository = createRepository(createTask({ status: "done" }));
    const service = new TaskService(repository as never, createLogService() as never, createEventsService() as never);

    await expect(service.retryFailed("auto-1")).rejects.toBeInstanceOf(BadRequestException);
  });
});
