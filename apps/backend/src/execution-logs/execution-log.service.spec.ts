import { ExecutionLogService } from "./execution-log.service";

describe("ExecutionLogService", () => {
  const createRepository = () => {
    const rows: unknown[] = [];

    return {
      rows,
      create: jest.fn((input: unknown) => input),
      save: jest.fn(async (input: unknown) => {
        rows.push(input);
        return input;
      }),
      find: jest.fn(async () => rows)
    };
  };

  it("appends logs with complete stdout and stderr metadata", async () => {
    const repository = createRepository();
    const eventsService = {
      publishExecutionLog: jest.fn()
    };
    const service = new ExecutionLogService(repository as never, eventsService as never);

    const log = await service.append({
      taskId: "auto-1",
      agentId: "agent-1",
      status: "failed",
      message: "Codex command failed",
      metadata: {
        stdout: "full stdout",
        stderr: "full stderr",
        exitCode: 1
      }
    });

    expect(log.id).toMatch(/^log-/);
    expect(log.metadata).toEqual({
      stdout: "full stdout",
      stderr: "full stderr",
      exitCode: 1
    });
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(eventsService.publishExecutionLog).toHaveBeenCalledWith(
      log.id,
      "auto-1",
      "failed",
      "agent-1"
    );
  });

  it("lists logs by task in createdAt ascending order", async () => {
    const repository = createRepository();
    const service = new ExecutionLogService(repository as never);

    await service.listByTask("auto-1");

    expect(repository.find).toHaveBeenCalledWith({
      where: { taskId: "auto-1" },
      order: { createdAt: "ASC" }
    });
  });
});
