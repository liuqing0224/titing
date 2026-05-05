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
      "Implement the feature"
    ], {
      cwd: "/tmp/workspace/demo/repo",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 12345
    });
    expect(result).toEqual({
      exitCode: 0,
      stdout: "created files",
      stderr: ""
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
      exitCode: 7,
      stdout: "partial output",
      stderr: "fatal error"
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

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
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
      "Do work"
    ], {
      cwd: "/tmp/autodev-agent/workspaces/frontend/yanxue-main",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 1800000
    });

    existsSpy.mockRestore();
    mkdirSpy.mockRestore();
  });
});
