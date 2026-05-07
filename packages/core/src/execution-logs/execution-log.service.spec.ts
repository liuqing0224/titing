import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FileExecutionLogStoreService } from "../../../../plugins/file-log-store/src/file-execution-log-store.service";
import { SseEventBusService } from "../../../../plugins/sse-event-bus/src/sse-event-bus.service";
import { ExecutionLogService } from "./execution-log.service";

describe("ExecutionLogService", () => {
  const originalExecutionLogDir = process.env.EXECUTION_LOG_DIR;
  let executionLogDir: string;

  beforeEach(async () => {
    executionLogDir = await mkdtemp(join(tmpdir(), "execution-logs-"));
    process.env.EXECUTION_LOG_DIR = executionLogDir;
  });

  afterEach(async () => {
    if (originalExecutionLogDir === undefined) {
      delete process.env.EXECUTION_LOG_DIR;
    } else {
      process.env.EXECUTION_LOG_DIR = originalExecutionLogDir;
    }

    await rm(executionLogDir, { recursive: true, force: true });
  });

  it("appends logs with complete stdout and stderr metadata", async () => {
    const eventBus = new SseEventBusService();
    jest.spyOn(eventBus, "publishExecutionLog");
    const service = new ExecutionLogService(new FileExecutionLogStoreService(eventBus));

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
    expect(eventBus.publishExecutionLog).toHaveBeenCalledWith(
      log.id,
      "auto-1",
      "failed",
      "agent-1"
    );
    await expect(readFile(join(executionLogDir, "auto-1.jsonl"), "utf8")).resolves.toContain(
      "\"message\":\"Codex command failed\""
    );
  });

  it("lists logs by task in createdAt ascending order", async () => {
    const service = new ExecutionLogService(new FileExecutionLogStoreService());

    const second = await service.append({
      taskId: "auto-1",
      status: "done",
      message: "second"
    });
    const first = await service.append({
      taskId: "auto-1",
      status: "running",
      message: "first"
    });

    const logs = await service.listByTask("auto-1");

    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.id)).toEqual([second.id, first.id]);
    expect(logs[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("returns an empty list when the task log file does not exist", async () => {
    const service = new ExecutionLogService(new FileExecutionLogStoreService());

    await expect(service.listByTask("missing-task")).resolves.toEqual([]);
  });

  it("defaults to the repository root logs directory when EXECUTION_LOG_DIR is unset", async () => {
    delete process.env.EXECUTION_LOG_DIR;
    const service = new ExecutionLogService(new FileExecutionLogStoreService());

    await service.append({
      taskId: "default-path-task",
      status: "running",
      message: "written to repo root logs"
    });

    await expect(
      readFile(resolve(process.cwd(), "../../logs/default-path-task.jsonl"), "utf8")
    ).resolves.toContain("\"message\":\"written to repo root logs\"");

    await rm(resolve(process.cwd(), "../../logs/default-path-task.jsonl"), { force: true });
  });
});
