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
        CODEX_WORKDIR: "/workspace",
        CODEX_TIMEOUT_MS: "12345"
      }) as never,
      processRunner
    );

    const result = await runner.run(createTask(), createAgent());

    expect(processRunner.run).toHaveBeenCalledWith("codex-dev", [
      "exec",
      "--cwd",
      "/workspace/demo/repo",
      "--branch",
      "feature/demo",
      "Implement the feature"
    ], {
      cwd: "/workspace/demo/repo",
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
      run: jest.fn(async () => {
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
      run: jest.fn(async () => {
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
});
