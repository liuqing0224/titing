import { Task } from "../tasks/task.entity";
import { ExecutionRunResult } from "../plugins/execution-engine.plugin";
import { ResultReporterService } from "./result-reporter.service";

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "auto-1",
    source: "meegle",
    externalId: "MEEGLE-1",
    title: "Task",
    ...overrides
  }) as Task;

describe("ResultReporterService", () => {
  it("routes success reports to the reporter matching the task source", async () => {
    const meegleReporter = {
      source: "meegle",
      reportSuccess: jest.fn(async () => undefined),
      reportFailure: jest.fn(async () => undefined)
    };
    const reporter = new ResultReporterService([meegleReporter]);

    await reporter.reportSuccess(createTask(), createResult({ stdout: "created PR", stderr: "", exitCode: 0 }));

    expect(meegleReporter.reportSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ source: "meegle", externalId: "MEEGLE-1" }),
      expect.objectContaining({ exitCode: 0 })
    );
  });

  it("routes failure reports to the reporter matching the task source", async () => {
    const meegleReporter = {
      source: "meegle",
      reportSuccess: jest.fn(async () => undefined),
      reportFailure: jest.fn(async () => undefined)
    };
    const reporter = new ResultReporterService([meegleReporter]);

    await reporter.reportFailure(createTask(), createResult({ stdout: "partial", stderr: "boom", exitCode: 1 }));

    expect(meegleReporter.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ source: "meegle", externalId: "MEEGLE-1" }),
      expect.objectContaining({ exitCode: 1 })
    );
  });

  it("skips report for manual tasks without a matching reporter", async () => {
    const meegleReporter = {
      source: "meegle",
      reportSuccess: jest.fn(async () => undefined),
      reportFailure: jest.fn(async () => undefined)
    };
    const reporter = new ResultReporterService([meegleReporter]);

    await reporter.reportSuccess(
      createTask({ source: "manual", externalId: null }),
      createResult({ stdout: "ok", stderr: "", exitCode: 0 })
    );

    expect(meegleReporter.reportSuccess).not.toHaveBeenCalled();
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
    hostCwd: "/tmp/demo/repo",
    containerCwd: "/workspace/demo/repo",
    agentsMdPath: "/workspace/demo/repo/AGENTS.md",
    workflowPromptsPath: "/workspace/demo/repo/knowledge/WORKFLOW_PROMPTS.md"
  };
}
