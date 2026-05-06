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
    title: "Implement trip config",
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
  const workflowPromptsContent = [
    "# Workflow",
    "",
    "## Agents 默认执行流程",
    "",
    "按照如下流程执行，并且必须保证顺序：",
    "",
    "1. 轻量理解层",
    "   - `Brainstorm`",
    "   - `WriteMRD`",
    "",
    "### Brainstorm",
    "",
      "```text",
      "使用 `brainstorm` 技能，根据以下需求生成需求澄清文档：",
      "{{taskPrompt}}",
      "",
      "输出文件保存到 `docs/{{gitBranch}}/brainstorm.md`。",
      "```",
      "",
      "推荐配置：",
      "",
      "- `loopEnabled: false`",
      "- `maxLoops: 1`",
      "",
      "### WriteMRD",
      "",
      "```text",
      "使用 `mrd` 技能，优先基于 `docs/{{gitBranch}}/brainstorm.md`，并结合以下需求生成 MRD：",
      "{{taskPrompt}}",
      "",
      "项目信息：{{projectName}} @ {{gitWorktreePath}}",
      "```",
      "",
      "推荐配置：",
      "",
      "- `loopEnabled: false`",
      "- `maxLoops: 1`"
    ].join("\n");

  beforeEach(() => {
    jest.spyOn(fs, "existsSync").mockImplementation((filePath: fs.PathLike) => {
      const pathValue = String(filePath);
      return pathValue.endsWith("/knowledge/WORKFLOW_PROMPTS.md") || pathValue.endsWith("/WORKFLOW_PROMPTS.md");
    });
    jest.spyOn(fs, "readFileSync").mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const pathValue = String(filePath);
      if (pathValue.endsWith("/knowledge/WORKFLOW_PROMPTS.md") || pathValue.endsWith("/WORKFLOW_PROMPTS.md")) {
        return workflowPromptsContent;
      }
      throw new Error(`Unexpected file read: ${pathValue}`);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("executes workflow prompts step by step in AGENTS order", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "brainstormed", stderr: "" })
        .mockResolvedValueOnce({ stdout: "mrd written", stderr: "" })
    };
    const runner = new CodexRunner(
      createConfigService({
        CODEX_CLI_BIN: "codex-dev",
        CODEX_WORKDIR: "/tmp/workspace",
        CODEX_TIMEOUT_MS: "12345",
        CODEX_MODEL: "gpt-5.4-medium",
        CODEX_MODEL_REASONING_EFFORT: "medium"
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
    ], expect.any(Object));
    expect(processRunner.run).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/docker",
      [
        "exec",
        "-w",
        "/workspace/demo/repo",
        "agent-1",
        "sh",
        "-lc",
        "test -s 'knowledge/WORKFLOW_PROMPTS.md' || test -s 'WORKFLOW_PROMPTS.md'"
      ],
      expect.any(Object)
    );
    expect(processRunner.run).toHaveBeenNthCalledWith(3, "/usr/bin/docker", [
      "exec",
      "-w",
      "/workspace/demo/repo",
      "agent-1",
      "codex-dev",
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "danger-full-access",
      "-C",
      "/workspace/demo/repo",
      "-m",
      "gpt-5.4-medium",
      "-c",
      "model_reasoning_effort=\"medium\"",
      [
        "使用 `brainstorm` 技能，根据以下需求生成需求澄清文档：",
        "Implement the feature",
        "",
        "输出文件保存到 `docs/feature/demo/brainstorm.md`。"
      ].join("\n")
    ], expect.any(Object));
    expect(processRunner.run).toHaveBeenNthCalledWith(4, "/usr/bin/docker", [
      "exec",
      "-w",
      "/workspace/demo/repo",
      "agent-1",
      "codex-dev",
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "danger-full-access",
      "-C",
      "/workspace/demo/repo",
      "-m",
      "gpt-5.4-medium",
      "-c",
      "model_reasoning_effort=\"medium\"",
      [
        "使用 `mrd` 技能，优先基于 `docs/feature/demo/brainstorm.md`，并结合以下需求生成 MRD：",
        "Implement the feature",
        "",
        "项目信息：repo @ /workspace/demo/repo"
      ].join("\n")
    ], expect.any(Object));
    expect(result).toEqual({
      stage: "execute",
      exitCode: 0,
      stdout: "Brainstorm stdout:\nbrainstormed\n\nWriteMRD stdout:\nmrd written",
      stderr: "",
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: true,
      repo: "demo/repo",
      branch: "feature/demo",
      hostCwd: "/tmp/workspace/demo/repo",
      containerCwd: "/workspace/demo/repo",
      agentsMdPath: "/workspace/demo/repo/AGENTS.md",
      workflowPromptsPath: "/workspace/demo/repo/knowledge/WORKFLOW_PROMPTS.md"
    });
  });

  it("returns non-zero result when one workflow node fails", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "brainstormed", stderr: "" })
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
      stage: "execute",
      exitCode: 7,
      stdout: "Brainstorm stdout:\nbrainstormed\n\nexecute stdout:\npartial output",
      stderr: "execute stderr:\nfatal error",
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: true,
      repo: "demo/repo",
      branch: "feature/demo",
      hostCwd: `${process.cwd()}/demo/repo`,
      containerCwd: "/workspace/demo/repo",
      agentsMdPath: "/workspace/demo/repo/AGENTS.md",
      workflowPromptsPath: "/workspace/demo/repo/knowledge/WORKFLOW_PROMPTS.md"
    });
  });

  it("injects custom provider config when explicitly configured", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "brainstormed", stderr: "" })
        .mockResolvedValueOnce({ stdout: "mrd written", stderr: "" })
    };
    const runner = new CodexRunner(
      createConfigService({
        CODEX_CLI_BIN: "codex-dev",
        CODEX_MODEL: "gpt-5.4-medium",
        CODEX_MODEL_REASONING_EFFORT: "medium",
        CODEX_MODEL_PROVIDER: "rightcode",
        CODEX_MODEL_BASE_URL: "https://right.codes/codex/v1",
        CODEX_MODEL_WIRE_API: "responses",
        CODEX_MODEL_REQUIRES_OPENAI_AUTH: "true"
      }) as never,
      processRunner
    );

    await runner.run(createTask(), createAgent());

    const brainstormArgs = processRunner.run.mock.calls[2][1] as string[];
    expect(brainstormArgs).toContain("model_provider=\"rightcode\"");
    expect(brainstormArgs).toContain("model_providers.rightcode.name=\"rightcode\"");
    expect(brainstormArgs).toContain("model_providers.rightcode.base_url=\"https://right.codes/codex/v1\"");
    expect(brainstormArgs).toContain("model_providers.rightcode.wire_api=\"responses\"");
    expect(brainstormArgs).toContain("model_providers.rightcode.requires_openai_auth=true");
    expect(brainstormArgs).toContain("gpt-5.4-medium");
    expect(brainstormArgs).toContain("model_reasoning_effort=\"medium\"");
  });

  it("re-runs loop-enabled nodes in place before continuing to the next node", async () => {
    const loopWorkflowPromptsContent = [
      "# Workflow",
      "",
      "## Agents 默认执行流程",
      "",
      "按照如下流程执行，并且必须保证顺序：",
      "",
      "1. 主执行层",
      "   - `WriteCode`",
      "   - `ImproveCode`",
      "",
      "### WriteCode",
      "",
      "```text",
      "WRITE_CODE_PROMPT",
      "```",
      "",
      "推荐配置：",
      "",
      "- `loopEnabled: true`",
      "- `maxLoops: 3`",
      "",
      "### ImproveCode",
      "",
      "```text",
      "IMPROVE_CODE_PROMPT",
      "```",
      "",
      "推荐配置：",
      "",
      "- `loopEnabled: true`",
      "- `maxLoops: 2`"
    ].join("\n");
    const taskResultPath = `${process.cwd()}/demo/repo/docs/feature/demo/taskResult.md`;
    const openSpecTasksPath = `${process.cwd()}/demo/repo/openspec/changes/change-a/tasks.md`;
    let taskResultContent = "未完成\n仍有未完成任务";
    let openSpecTasksContent = "- [ ] 1.1 pending";

    jest.spyOn(fs, "existsSync").mockImplementation((filePath: fs.PathLike) => {
      const pathValue = String(filePath);
      return [
        pathValue.endsWith("/knowledge/WORKFLOW_PROMPTS.md"),
        pathValue === taskResultPath,
        pathValue === `${process.cwd()}/demo/repo/openspec/changes`,
        pathValue === openSpecTasksPath
      ].some(Boolean);
    });
    jest.spyOn(fs, "readdirSync").mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath) === `${process.cwd()}/demo/repo/openspec/changes`) {
        return [{ name: "change-a", isDirectory: () => true }] as never;
      }
      return [] as never;
    });
    jest.spyOn(fs, "statSync").mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath) === openSpecTasksPath) {
        return { mtimeMs: 100 } as never;
      }
      throw new Error(`Unexpected stat: ${String(filePath)}`);
    });
    jest.spyOn(fs, "readFileSync").mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const pathValue = String(filePath);
      if (pathValue.endsWith("/knowledge/WORKFLOW_PROMPTS.md")) {
        return loopWorkflowPromptsContent;
      }
      if (pathValue === taskResultPath) {
        return taskResultContent;
      }
      if (pathValue === openSpecTasksPath) {
        return openSpecTasksContent;
      }
      throw new Error(`Unexpected file read: ${pathValue}`);
    });

    let codexExecCount = 0;
    const processRunner = {
      run: jest.fn().mockImplementation(async (_command: string, args: string[]) => {
        if (args[0] === "exec" && args[4] === "codex") {
          codexExecCount += 1;
          const prompt = args[args.length - 1];
          if (codexExecCount === 5 && prompt === "IMPROVE_CODE_PROMPT") {
            taskResultContent = "已完成\n所有任务已完成";
            openSpecTasksContent = "- [x] 1.1 done";
          }

          return {
            stdout: prompt === "WRITE_CODE_PROMPT" ? `write pass ${codexExecCount}` : `improve pass ${codexExecCount}`,
            stderr: ""
          };
        }

        return { stdout: "", stderr: "" };
      })
    };
    const runner = new CodexRunner(
      createConfigService({
        CODEX_CLI_BIN: "codex"
      }) as never,
      processRunner
    );

    const result = await runner.run(createTask(), createAgent());

    expect(codexExecCount).toBe(5);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WriteCode iteration 1/3 stdout:\nwrite pass 1");
    expect(result.stdout).toContain("WriteCode iteration 3/3 stdout:\nwrite pass 3");
    expect(result.stdout).toContain("ImproveCode iteration 2/2 stdout:\nimprove pass 5");
  });

  it("fails when tasks remain incomplete after node-local loops are exhausted", async () => {
    const loopWorkflowPromptsContent = [
      "# Workflow",
      "",
      "## Agents 默认执行流程",
      "",
      "按照如下流程执行，并且必须保证顺序：",
      "",
      "1. 主执行层",
      "   - `WriteCode`",
      "",
      "### WriteCode",
      "",
      "```text",
      "WRITE_CODE_PROMPT",
      "```",
      "",
      "推荐配置：",
      "",
      "- `loopEnabled: true`",
      "- `maxLoops: 2`"
    ].join("\n");
    const taskResultPath = `${process.cwd()}/demo/repo/docs/feature/demo/taskResult.md`;
    const openSpecTasksPath = `${process.cwd()}/demo/repo/openspec/changes/change-a/tasks.md`;

    jest.spyOn(fs, "existsSync").mockImplementation((filePath: fs.PathLike) => {
      const pathValue = String(filePath);
      return [
        pathValue.endsWith("/knowledge/WORKFLOW_PROMPTS.md"),
        pathValue === taskResultPath,
        pathValue === `${process.cwd()}/demo/repo/openspec/changes`,
        pathValue === openSpecTasksPath
      ].some(Boolean);
    });
    jest.spyOn(fs, "readdirSync").mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath) === `${process.cwd()}/demo/repo/openspec/changes`) {
        return [{ name: "change-a", isDirectory: () => true }] as never;
      }
      return [] as never;
    });
    jest.spyOn(fs, "statSync").mockImplementation(() => ({ mtimeMs: 100 } as never));
    jest.spyOn(fs, "readFileSync").mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const pathValue = String(filePath);
      if (pathValue.endsWith("/knowledge/WORKFLOW_PROMPTS.md")) {
        return loopWorkflowPromptsContent;
      }
      if (pathValue === taskResultPath) {
        return "未完成\n仍有未完成任务";
      }
      if (pathValue === openSpecTasksPath) {
        return "- [ ] 1.1 pending";
      }
      throw new Error(`Unexpected file read: ${pathValue}`);
    });

    const processRunner = {
      run: jest.fn().mockImplementation(async (_command: string, args: string[]) => {
        if (args[0] === "exec" && args[4] === "codex") {
          return { stdout: "write pass", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      })
    };
    const runner = new CodexRunner(
      createConfigService({
        CODEX_CLI_BIN: "codex"
      }) as never,
      processRunner
    );

    const result = await runner.run(createTask(), createAgent());

    expect(result.stage).toBe("execute");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Workflow completion check");
    expect(result.stderr).toContain("Workflow incomplete after node-local loops");
  });

  it("fails when WORKFLOW_PROMPTS.md is missing or empty", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error("missing WORKFLOW_PROMPTS.md"), {
            code: 1,
            stderr: ""
          });
        })
    };
    const runner = new CodexRunner(createConfigService({}) as never, processRunner);

    const result = await runner.run(createTask(), createAgent());

    expect(result).toEqual({
      stage: "workflow-prompts",
      exitCode: 1,
      stdout: "",
      stderr: "workflow-prompts stderr:\nmissing WORKFLOW_PROMPTS.md",
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: false,
      repo: "demo/repo",
      branch: "feature/demo",
      hostCwd: `${process.cwd()}/demo/repo`,
      containerCwd: "/workspace/demo/repo",
      agentsMdPath: "/workspace/demo/repo/AGENTS.md",
      workflowPromptsPath: "/workspace/demo/repo/knowledge/WORKFLOW_PROMPTS.md"
    });
  });

  it("fails when WORKFLOW_PROMPTS.md does not contain the default workflow section", async () => {
    jest.spyOn(fs, "readFileSync").mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const pathValue = String(filePath);
      if (pathValue.endsWith("/knowledge/WORKFLOW_PROMPTS.md") || pathValue.endsWith("/WORKFLOW_PROMPTS.md")) {
        return "# Workflow\n\nNo default workflow here.";
      }
      throw new Error(`Unexpected file read: ${pathValue}`);
    });
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
    };
    const runner = new CodexRunner(createConfigService({}) as never, processRunner);

    const result = await runner.run(createTask(), createAgent());

    expect(result).toEqual({
      stage: "workflow-prompts",
      exitCode: 1,
      stdout: "",
      stderr: "workflow-prompts stderr:\nNo workflow nodes found in WORKFLOW_PROMPTS.md default workflow section",
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: false,
      repo: "demo/repo",
      branch: "feature/demo",
      hostCwd: `${process.cwd()}/demo/repo`,
      containerCwd: "/workspace/demo/repo",
      agentsMdPath: "/workspace/demo/repo/AGENTS.md",
      workflowPromptsPath: "/workspace/demo/repo/knowledge/WORKFLOW_PROMPTS.md"
    });
  });

  it("fails when workflow prompts are missing for a node", async () => {
    jest.spyOn(fs, "readFileSync").mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const pathValue = String(filePath);
      if (pathValue.endsWith("/knowledge/WORKFLOW_PROMPTS.md") || pathValue.endsWith("/WORKFLOW_PROMPTS.md")) {
        return [
          "# Workflow",
          "",
          "## Agents 默认执行流程",
          "",
          "按照如下流程执行，并且必须保证顺序：",
          "",
          "1. 轻量理解层",
          "   - `Brainstorm`",
          "   - `WriteMRD`",
          "",
          "### Brainstorm",
          "",
          "```text",
          "Only brainstorm",
          "```"
        ].join("\n");
      }
      throw new Error(`Unexpected file read: ${pathValue}`);
    });
    jest.spyOn(fs, "existsSync").mockImplementation((filePath: fs.PathLike) => {
      const pathValue = String(filePath);
      return pathValue.endsWith("/knowledge/WORKFLOW_PROMPTS.md");
    });
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
    };
    const runner = new CodexRunner(createConfigService({}) as never, processRunner);

    const result = await runner.run(createTask(), createAgent());

    expect(result).toEqual({
      stage: "workflow-prompts",
      exitCode: 1,
      stdout: "",
      stderr: "workflow-prompts stderr:\nMissing ### WriteMRD section in WORKFLOW_PROMPTS.md",
      timedOut: false,
      branchCheckedOut: true,
      codexStarted: false,
      repo: "demo/repo",
      branch: "feature/demo",
      hostCwd: `${process.cwd()}/demo/repo`,
      containerCwd: "/workspace/demo/repo",
      agentsMdPath: "/workspace/demo/repo/AGENTS.md",
      workflowPromptsPath: "/workspace/demo/repo/knowledge/WORKFLOW_PROMPTS.md"
    });
  });

  it("uses absolute repo paths directly when the task points at a host checkout", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "brainstormed", stderr: "" })
        .mockResolvedValueOnce({ stdout: "mrd written", stderr: "" })
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
    ], expect.any(Object));
    expect(processRunner.run).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/docker",
      [
        "exec",
        "-w",
        "/Users/l/Documents/work/code/demo/AutoFlow/project-a",
        "agent-1",
        "sh",
        "-lc",
        "test -s 'knowledge/WORKFLOW_PROMPTS.md' || test -s 'WORKFLOW_PROMPTS.md'"
      ],
      expect.any(Object)
    );
    expect(processRunner.run).toHaveBeenCalledTimes(4);
  });

  it("clones remote repositories into the workspace before running workflow nodes", async () => {
    const processRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "cloned", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "brainstormed", stderr: "" })
        .mockResolvedValueOnce({ stdout: "mrd written", stderr: "" })
    };
    const existsSpy = jest.spyOn(fs, "existsSync").mockImplementation((filePath: fs.PathLike) => {
      const pathValue = String(filePath);
      if (pathValue.endsWith("/knowledge/WORKFLOW_PROMPTS.md") || pathValue.endsWith("/WORKFLOW_PROMPTS.md")) {
        return true;
      }
      return false;
    });
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
    ], expect.any(Object));
    expect(processRunner.run).toHaveBeenCalledTimes(5);

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
      isAbsolutePath: false,
      agentsMdPath: "/workspace/frontend/yanxue-main/AGENTS.md",
      workflowPromptsPath: "/workspace/frontend/yanxue-main/knowledge/WORKFLOW_PROMPTS.md"
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
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "brainstormed", stderr: "" })
        .mockResolvedValueOnce({ stdout: "mrd written", stderr: "" })
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
    ], expect.any(Object));
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
