import fs from "node:fs";
import { Agent } from "../agents/agent.entity";
import { Task } from "../tasks/task.entity";
import { CodexRunner } from "./codex-runner";

const createConfigService = (values: Record<string, string>) => ({
  get: jest.fn((key: string, fallback: string) => values[key] ?? fallback)
});

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "auto-1",
    repo: "demo/repo",
    branch: "feature/demo",
    instruction: "Implement the feature",
    ...overrides
  }) as Task;

const createAgent = (): Agent =>
  ({
    id: "agent-1",
    containerName: "agent-1"
  }) as Agent;

describe("CodexRunner", () => {
  it("runs Codex with configured binary, working directory, task context and timeout", async () => {
    const processRunner = {
      run: jest.fn(async () => ({
        stdout: "created files",
        stderr: ""
      }))
    };
    const runner = new CodexRunner(
      createConfigService({
        CODEX_CLI_BIN: "codex-dev",
        CODEX_WORKDIR: "/tmp/workspace",
        CODEX_TIMEOUT_MS: "12345"
      }) as never,
      processRunner
    );

    const result = await runner.run(createTask(), createAgent());

    expect(processRunner.run).toHaveBeenNthCalledWith(1, "/usr/bin/docker", [
      "exec",
      "-w",
      "/workspace/demo/repo",
      "agent-1",
      "git",
      "checkout",
      "feature/demo"
    ], {
      cwd: "/tmp/workspace/demo/repo",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 12345
    });
    expect(processRunner.run).toHaveBeenNthCalledWith(2, "/usr/bin/docker", [
      "exec",
      "-w",
      "/workspace/demo/repo",
      "agent-1",
      "codex-dev",
      "exec",
      "-C",
      "/workspace/demo/repo",
      "--dangerously-bypass-approvals-and-sandbox",
      buildExpectedInstruction("Implement the feature")
    ], {
      cwd: "/tmp/workspace/demo/repo",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 12345
    });
    expect(result).toEqual({
      stage: "codex",
      exitCode: 0,
      stdout: "created files",
      stderr: "",
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: true,
      repo: "demo/repo",
      branch: "feature/demo",
      hostCwd: "/tmp/workspace/demo/repo",
      containerCwd: "/workspace/demo/repo"
    });
  });

  it("returns non-zero result with stdout and stderr when Codex exits with an error", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error("command failed"), {
            code: 7,
            stdout: "partial output",
            stderr: "fatal error"
          });
        })
    };
    const runner = new CodexRunner(createConfigService({}) as never, processRunner);

    const result = await runner.run(createTask(), createAgent());

    expect(result).toEqual({
      stage: "codex",
      exitCode: 7,
      stdout: "partial output",
      stderr: "fatal error",
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: true,
      repo: "demo/repo",
      branch: "feature/demo",
      hostCwd: `${process.cwd()}/demo/repo`,
      containerCwd: "/workspace/demo/repo"
    });
  });

  it("maps timeout errors to exitCode 124", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error("timed out"), {
            killed: true,
            signal: "SIGTERM",
            stdout: "",
            stderr: ""
          });
        })
    };
    const runner = new CodexRunner(createConfigService({}) as never, processRunner);

    const result = await runner.run(createTask(), createAgent());

    expect(result.stage).toBe("codex");
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
    expect(result.timedOut).toBe(true);
  });

  it("uses absolute repo paths directly when the task points at a host checkout", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "ok", stderr: "" })
    };
    const runner = new CodexRunner(createConfigService({}) as never, processRunner);

    await runner.run(
      createTask({
        repo: "/Users/l/Documents/work/code/demo/AutoFlow/project-a",
        branch: "main",
        instruction: "Do work"
      }),
      createAgent()
    );

    expect(processRunner.run).toHaveBeenNthCalledWith(1, "/usr/bin/docker", [
      "exec",
      "-w",
      "/Users/l/Documents/work/code/demo/AutoFlow/project-a",
      "agent-1",
      "git",
      "checkout",
      "main"
    ], {
      cwd: "/Users/l/Documents/work/code/demo/AutoFlow/project-a",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 1800000
    });
    expect(processRunner.run).toHaveBeenNthCalledWith(2, "/usr/bin/docker", [
      "exec",
      "-w",
      "/Users/l/Documents/work/code/demo/AutoFlow/project-a",
      "agent-1",
      "codex",
      "exec",
      "-C",
      "/Users/l/Documents/work/code/demo/AutoFlow/project-a",
      "--dangerously-bypass-approvals-and-sandbox",
      buildExpectedInstruction("Do work")
    ], {
      cwd: "/Users/l/Documents/work/code/demo/AutoFlow/project-a",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 1800000
    });
  });

  it("clones remote repositories into the workspace before checkout and execution", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "cloned", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "ok", stderr: "" })
    };
    const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
    const mkdirSpy = jest.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as never);
    const runner = new CodexRunner(
      createConfigService({
        CODEX_WORKDIR: "/tmp/autodev-agent/workspaces"
      }) as never,
      processRunner
    );

    await runner.run(
      createTask({
        repo: "[git@gitlab.yc345.tv](mailto:git@gitlab.yc345.tv):frontend/yanxue-main.git",
        branch: "main",
        instruction: "Do work"
      }),
      createAgent()
    );

    expect(processRunner.run).toHaveBeenNthCalledWith(1, "/usr/bin/docker", [
      "exec",
      "-w",
      "/workspace/frontend",
      "agent-1",
      "git",
      "clone",
      "git@gitlab.yc345.tv:frontend/yanxue-main.git",
      "yanxue-main"
    ], {
      cwd: "/tmp/autodev-agent/workspaces",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 1800000
    });
    expect(processRunner.run).toHaveBeenNthCalledWith(2, "/usr/bin/docker", [
      "exec",
      "-w",
      "/workspace/frontend/yanxue-main",
      "agent-1",
      "git",
      "checkout",
      "main"
    ], {
      cwd: "/tmp/autodev-agent/workspaces/frontend/yanxue-main",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 1800000
    });
    expect(processRunner.run).toHaveBeenNthCalledWith(3, "/usr/bin/docker", [
      "exec",
      "-w",
      "/workspace/frontend/yanxue-main",
      "agent-1",
      "codex",
      "exec",
      "-C",
      "/workspace/frontend/yanxue-main",
      "--dangerously-bypass-approvals-and-sandbox",
      buildExpectedInstruction("Do work")
    ], {
      cwd: "/tmp/autodev-agent/workspaces/frontend/yanxue-main",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 1800000
    });

    existsSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it("exposes resolved execution context for remote repositories", () => {
    const runner = new CodexRunner(
      createConfigService({
        CODEX_WORKDIR: "/tmp/autodev-agent/workspaces"
      }) as never
    );

    expect(
      runner.getExecutionContext(
        createTask({
          repo: "git@gitlab.yc345.tv:frontend/yanxue-main.git",
          branch: "release/1.0"
        })
      )
    ).toEqual({
      repo: "git@gitlab.yc345.tv:frontend/yanxue-main.git",
      branch: "release/1.0",
      hostCwd: "/tmp/autodev-agent/workspaces/frontend/yanxue-main",
      containerCwd: "/workspace/frontend/yanxue-main",
      cloneUrl: "git@gitlab.yc345.tv:frontend/yanxue-main.git",
      isAbsolutePath: false
    });
  });

  it("creates the branch when checkout fails because it does not exist yet", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error("pathspec not found"), {
            code: 1,
            stderr: "pathspec not found"
          });
        })
        .mockResolvedValueOnce({ stdout: "Switched to a new branch", stderr: "" })
        .mockResolvedValueOnce({ stdout: "ok", stderr: "" })
    };
    const runner = new CodexRunner(createConfigService({}) as never, processRunner);

    const result = await runner.run(createTask({ branch: "feature/20260505210101" }), createAgent());

    expect(processRunner.run).toHaveBeenNthCalledWith(2, "/usr/bin/docker", [
      "exec",
      "-w",
      "/workspace/demo/repo",
      "agent-1",
      "git",
      "checkout",
      "-b",
      "feature/20260505210101"
    ], {
      cwd: `${process.cwd()}/demo/repo`,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 1800000
    });
    expect(result.exitCode).toBe(0);
  });

  it("generates a feature branch name when the task branch is empty", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-05T21:01:02.000Z"));
    const runner = new CodexRunner(createConfigService({}) as never);

    expect(runner.getExecutionContext(createTask({ branch: "   " }))).toEqual(
      expect.objectContaining({
        branch: "feature/20260506050102"
      })
    );

    jest.useRealTimers();
  });
});

function buildExpectedInstruction(instruction: string): string {
  return [
    "YOLO execution mode.",
    "First produce a concise internal execution checklist based on the task, then immediately execute every checklist item end-to-end.",
    "Do not ask the user any clarifying questions.",
    "Do not pause for approval, design review, or confirmation.",
    "Do not use brainstorming or approval-gated workflows from the repository.",
    "If details are missing, make reasonable assumptions, keep public APIs stable where possible, and continue.",
    "You must modify code and tests directly when needed, verify your work, and then return a brief final summary.",
    "",
    "Task:",
    instruction
  ].join("\n");
}
