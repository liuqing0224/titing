import { Task } from "../tasks/task.entity";
import { ResultReporterService } from "./result-reporter.service";

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "auto-1",
    externalId: "MEEGLE-1",
    title: "Task",
    ...overrides
  }) as Task;

describe("ResultReporterService", () => {
  it("writes success summary back to Meegle when task has externalId", async () => {
    const meegleAdapter = {
      addComment: jest.fn(async () => undefined)
    };
    const reporter = new ResultReporterService(meegleAdapter as never);

    await reporter.reportSuccess(createTask(), {
      stdout: "created PR",
      stderr: "",
      exitCode: 0
    });

    expect(meegleAdapter.addComment).toHaveBeenCalledWith(
      "MEEGLE-1",
      expect.stringContaining("AutoDev Agent completed task auto-1")
    );
  });

  it("writes failure summary back to Meegle when Codex fails", async () => {
    const meegleAdapter = {
      addComment: jest.fn(async () => undefined)
    };
    const reporter = new ResultReporterService(meegleAdapter as never);

    await reporter.reportFailure(createTask(), {
      stdout: "partial",
      stderr: "boom",
      exitCode: 1
    });

    expect(meegleAdapter.addComment).toHaveBeenCalledWith(
      "MEEGLE-1",
      expect.stringContaining("AutoDev Agent failed task auto-1")
    );
  });

  it("skips comment back for manual tasks without externalId", async () => {
    const meegleAdapter = {
      addComment: jest.fn(async () => undefined)
    };
    const reporter = new ResultReporterService(meegleAdapter as never);

    await reporter.reportSuccess(createTask({ externalId: null }), {
      stdout: "ok",
      stderr: "",
      exitCode: 0
    });

    expect(meegleAdapter.addComment).not.toHaveBeenCalled();
  });
});
