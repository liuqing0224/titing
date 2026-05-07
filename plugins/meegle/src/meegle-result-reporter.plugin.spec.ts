import { Task } from "../../../packages/core/src/tasks/task.entity";
import { ExecutionRunResult } from "../../../packages/core/src/plugins/execution-engine.plugin";
import { MeegleResultReporterPlugin } from "./meegle-result-reporter.plugin";

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "auto-1",
    source: "meegle",
    externalId: "MEEGLE-1",
    title: "Task",
    ...overrides
  }) as Task;

describe("MeegleResultReporterPlugin", () => {
  it("writes success summary back to Meegle when task has externalId", async () => {
    const meegleAdapter = {
      addComment: jest.fn(async () => undefined)
    };
    const reporter = new MeegleResultReporterPlugin(meegleAdapter as never);

    await reporter.reportSuccess(createTask(), createResult({ stdout: "created PR", stderr: "", exitCode: 0 }));

    expect(meegleAdapter.addComment).toHaveBeenCalledWith(
      "MEEGLE-1",
      expect.stringContaining("AutoDev Agent completed task auto-1")
    );
  });

  it("writes failure summary back to Meegle when execution fails", async () => {
    const meegleAdapter = {
      addComment: jest.fn(async () => undefined)
    };
    const reporter = new MeegleResultReporterPlugin(meegleAdapter as never);

    await reporter.reportFailure(createTask(), createResult({ stdout: "partial", stderr: "boom", exitCode: 1 }));

    expect(meegleAdapter.addComment).toHaveBeenCalledWith(
      "MEEGLE-1",
      expect.stringContaining("AutoDev Agent failed task auto-1")
    );
  });

  it("skips comment back when Meegle task has no externalId", async () => {
    const meegleAdapter = {
      addComment: jest.fn(async () => undefined)
    };
    const reporter = new MeegleResultReporterPlugin(meegleAdapter as never);

    await reporter.reportSuccess(createTask({ externalId: null }), createResult({ stdout: "ok", stderr: "", exitCode: 0 }));

    expect(meegleAdapter.addComment).not.toHaveBeenCalled();
  });
});

function createResult(
  overrides: Pick<ExecutionRunResult, "stdout" | "stderr" | "exitCode">
): ExecutionRunResult {
  return {
    ...overrides,
    stage: "execute",
    timedOut: false,
    branchCheckedOut: true,
    codexStarted: true,
    repo: "demo/repo",
    branch: "main",
    repoRoot: "/tmp/demo/repo",
    worktreePath: "/tmp/demo/.worktrees/auto-1",
    agentsMdPath: "/workspace/demo/repo/AGENTS.md",
    workflowPromptsPath: "/workspace/demo/repo/knowledge/WORKFLOW_PROMPTS.md"
  };
}
