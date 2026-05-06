import { Task } from "../tasks/task.entity";
import { CodexRunResult } from "./codex-runner";
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

    await reporter.reportSuccess(createTask(), createResult({ stdout: "created PR", stderr: "", exitCode: 0 }));

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

    await reporter.reportFailure(createTask(), createResult({ stdout: "partial", stderr: "boom", exitCode: 1 }));

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

    await reporter.reportSuccess(createTask({ externalId: null }), createResult({ stdout: "ok", stderr: "", exitCode: 0 }));

    expect(meegleAdapter.addComment).not.toHaveBeenCalled();
  });
});

function createResult(
  overrides: Pick<CodexRunResult, "stdout" | "stderr" | "exitCode">
): CodexRunResult {
  return {
    ...overrides,
    stage: "execute",
    timedOut: false,
    branchCheckedOut: true,
    codexStarted: true,
    repo: "demo/repo",
    branch: "main",
    hostCwd: "/tmp/demo/repo",
    containerCwd: "/workspace/demo/repo",
    agentsMdPath: "/workspace/demo/repo/AGENTS.md",
    workflowPromptsPath: "/workspace/demo/repo/knowledge/WORKFLOW_PROMPTS.md"
  };
}
