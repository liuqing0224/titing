import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CodexExecutionPlugin,
  CursorExecutionPlugin,
  DefaultObservabilityGovernancePlugin,
  DefaultQualityPlugin,
  EnvironmentPreparationError,
  MeegleTaskIntegrationPlugin,
  LocalWorktreeEnvironmentPlugin,
  RootLogsPlugin
} from "./plugins";
import { ServerConfig } from "./config";
import { mapMeegleTask, normalizeRepoUrl } from "./plugins/shared";
import { TitingTask } from "@titing/plugin-api";

const execFileAsync = promisify(execFile);

describe("normalizeRepoUrl", () => {
  it("unwraps markdown mailto-wrapped ssh repo with trailing path", () => {
    expect(
      normalizeRepoUrl("[git@gitlab.yc345.tv](mailto:git@gitlab.yc345.tv):frontend/yanxue-main.git")
    ).toBe("git@gitlab.yc345.tv:frontend/yanxue-main.git");
  });

  it("passes through plain ssh and https urls", () => {
    expect(normalizeRepoUrl("git@example.com:grp/repo.git")).toBe("git@example.com:grp/repo.git");
    expect(normalizeRepoUrl("https://example.com/a/b.git")).toBe("https://example.com/a/b.git");
  });

  it("uses https href from markdown link", () => {
    expect(normalizeRepoUrl("[repo](https://gitlab.com/foo/bar.git)")).toBe("https://gitlab.com/foo/bar.git");
  });
});

describe("mapMeegleTask", () => {
  it("normalizes markdown ssh repo field", () => {
    const task = mapMeegleTask({
      id: "6983788716",
      title: "Test",
      instruction: "Do work",
      repo: "[git@gitlab.yc345.tv](mailto:git@gitlab.yc345.tv):frontend/yanxue-main.git",
      branch: "main"
    }, 0);
    expect(task.repo).toBe("git@gitlab.yc345.tv:frontend/yanxue-main.git");
  });

  it("uses the configured default executor when the task payload omits executor", () => {
    const task = mapMeegleTask({
      id: "6983788716",
      title: "Test",
      instruction: "Do work",
      repo: "https://example.com/repo.git",
      branch: "main"
    }, 0, "cursor");

    expect(task.executor).toBe("cursor");
  });

  it("does not fall back to main when the payload omits branch", () => {
    const task = mapMeegleTask({
      id: "6983788716",
      title: "Test",
      instruction: "Do work",
      repo: "https://example.com/repo.git"
    }, 0, "cursor");

    expect(task.branch).toBe("");
  });
});

describe("LocalWorktreeEnvironmentPlugin", () => {
  it("clones a repo into cache, prepares a worktree, and preserves failed workspace by default", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-env-"));
    try {
      const sourceRepo = join(sandbox, "source");
      await createGitRepo(sourceRepo, {
        "README.md": "# demo\n"
      });

      const plugin = new LocalWorktreeEnvironmentPlugin(createConfig(sandbox));
      const task = createTask(sourceRepo);

      const workspace = await plugin.prepareWorkspace(task);
      const readme = await readFile(join(workspace.repoPath, "README.md"), "utf8");

      expect(readme).toContain("demo");
      expect(workspace.cachePath).toContain(".titing-repos");
      expect(await exists(join(workspace.artifactsPath, "workspace.json"))).toBe(true);

      await plugin.cleanupWorkspace({ ...task, status: "failed" }, workspace);

      expect(await exists(workspace.workspacePath)).toBe(true);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("removes successful workspaces when cleanup-on-success is enabled", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-env-"));
    try {
      const sourceRepo = join(sandbox, "source");
      await createGitRepo(sourceRepo, {
        "README.md": "# demo\n"
      });

      const plugin = new LocalWorktreeEnvironmentPlugin(createConfig(sandbox));
      const task = createTask(sourceRepo);
      const workspace = await plugin.prepareWorkspace(task);

      await plugin.cleanupWorkspace({ ...task, status: "done" }, workspace);

      expect(await exists(workspace.workspacePath)).toBe(false);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("classifies missing branches as non-retryable environment failures", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-env-"));
    try {
      const sourceRepo = join(sandbox, "source");
      await createGitRepo(sourceRepo, {
        "README.md": "# demo\n"
      });

      const plugin = new LocalWorktreeEnvironmentPlugin(createConfig(sandbox));
      const task = { ...createTask(sourceRepo), branch: "missing-branch" };

      await expect(plugin.prepareWorkspace(task)).rejects.toMatchObject({
        name: "EnvironmentPreparationError",
        stage: "checkout",
        retryable: false
      } satisfies Partial<EnvironmentPreparationError>);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("creates auto-generated task branches from origin/main", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-env-"));
    try {
      const sourceRepo = join(sandbox, "source");
      await createGitRepo(sourceRepo, {
        "README.md": "# demo\n"
      });

      const plugin = new LocalWorktreeEnvironmentPlugin(createConfig(sandbox));
      const task = {
        ...createTask(sourceRepo),
        branch: "feature/20260511010203-task1234",
        metadata: {
          titing: {
            branch: {
              autoGenerated: true
            }
          }
        }
      };

      const workspace = await plugin.prepareWorkspace(task);
      const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: workspace.repoPath });
      const readme = await readFile(join(workspace.repoPath, "README.md"), "utf8");

      expect(stdout.trim()).toBe(task.branch);
      expect(readme).toContain("demo");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("DefaultQualityPlugin", () => {
  it("runs available scripts, skips missing scripts, and reports low risk for small diffs", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-quality-"));
    try {
      const repoPath = join(sandbox, "repo");
      await mkdir(repoPath, { recursive: true });
      await writeFile(
        join(repoPath, "package.json"),
        JSON.stringify(
          {
            name: "quality-repo",
            private: true,
            scripts: {
              test: "node -e \"process.exit(0)\"",
              build: "node -e \"process.exit(0)\""
            }
          },
          null,
          2
        )
      );
      await writeFile(join(repoPath, "README.md"), "one\n");
      await git(["init"], repoPath);
      await git(["config", "user.email", "test@example.com"], repoPath);
      await git(["config", "user.name", "Test User"], repoPath);
      await git(["add", "."], repoPath);
      await git(["commit", "-m", "init"], repoPath);
      await writeFile(join(repoPath, "README.md"), "one\ntwo\n");

      const plugin = new DefaultQualityPlugin(60_000);
      const result = await plugin.evaluate({
        task: createTask(repoPath),
        execution: {
          exitCode: 0,
          stdout: "",
          stderr: "",
          summary: "ok",
          sessionId: "session-1",
          timedOut: false,
          errorCategory: "none",
          timeoutCategory: "none",
          metadata: {}
        },
        workspace: {
          workspacePath: sandbox,
          repoPath,
          branch: "main",
          cachePath: join(sandbox, ".cache"),
          artifactsPath: join(sandbox, "artifacts"),
          env: {}
        }
      });

      expect(result.passed).toBe(true);
      expect(result.riskLevel).toBe("low");
      expect(result.checks.find((check) => check.name === "lint")?.detail).toContain("Skipped");
      expect(result.checks.find((check) => check.name === "unit-test")?.passed).toBe(true);
      expect(result.checks.find((check) => check.name === "build")?.passed).toBe(true);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("Execution plugins", () => {
  it("captures structured Codex execution results and supports resume", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-codex-"));
    try {
      const repoPath = join(sandbox, "repo");
      await mkdir(repoPath, { recursive: true });
      await writeWorkflowPrompts(repoPath, {
        root: false,
        content: buildWorkflowPrompts(["Implement"])
      });
      const bin = join(sandbox, "fake-codex");
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], args.includes("resume") ? "resumed summary" : "first summary");
console.log(JSON.stringify({ session_id: "11111111-1111-4111-8111-111111111111" }));
`
      );
      await execFileAsync("chmod", ["+x", bin]);

      const plugin = new CodexExecutionPlugin(bin, 60_000);
      await mkdir(join(sandbox, "artifacts"), { recursive: true });
      const workspace = createWorkspace(sandbox, repoPath);
      const first = await plugin.execute(createTask(repoPath), workspace, null);
      const resumed = await plugin.continueSession?.(first.sessionId ?? "", createTask(repoPath), workspace, {
        id: "goal-1",
        taskId: "task-1",
        objective: "repair",
        constraints: [],
        doneWhen: ["pass build"],
        status: "repairing",
        currentIteration: 1,
        maxIterations: 3,
        lastFailureHash: null,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      expect(first.sessionId).toBe("codex:11111111-1111-4111-8111-111111111111");
      expect(first.errorCategory).toBe("none");
      expect(first.summary).toBe("first summary");
      expect(resumed?.summary).toBe("resumed summary");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("reads workflow prompts from the repo root fallback and executes all workflow nodes", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-codex-"));
    try {
      const repoPath = join(sandbox, "repo");
      await mkdir(repoPath, { recursive: true });
      await writeWorkflowPrompts(repoPath, {
        root: true,
        content: buildWorkflowPrompts(["Plan", "Implement"])
      });
      const bin = join(sandbox, "fake-codex");
      await writeFile(
        bin,
        `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
const prompt = args.at(-1) || "";
const node = prompt.includes("Implement") ? "implement" : "plan";
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], node + " summary");
console.log(JSON.stringify({ session_id: "11111111-1111-4111-8111-111111111111" }));
`
      );
      await execFileAsync("chmod", ["+x", bin]);

      const plugin = new CodexExecutionPlugin(bin, 60_000);
      await mkdir(join(sandbox, "artifacts"), { recursive: true });
      const workspace = createWorkspace(sandbox, repoPath);
      const result = await plugin.execute(createTask(repoPath), workspace, null);

      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("Plan: plan summary");
      expect(result.summary).toContain("Implement: implement summary");
      expect(result.metadata).toEqual(expect.objectContaining({
        workflowPromptsPath: join(repoPath, "WORKFLOW_PROMPTS.md"),
        workflowNodeNames: ["Plan", "Implement"]
      }));
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("fails with a workflow-prompts error when the repo has no WORKFLOW_PROMPTS.md", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-codex-"));
    try {
      const repoPath = join(sandbox, "repo");
      await mkdir(repoPath, { recursive: true });
      const bin = join(sandbox, "fake-codex");
      await writeFile(bin, "#!/usr/bin/env node\nprocess.exit(0);\n");
      await execFileAsync("chmod", ["+x", bin]);

      const plugin = new CodexExecutionPlugin(bin, 60_000);
      await mkdir(join(sandbox, "artifacts"), { recursive: true });
      const workspace = createWorkspace(sandbox, repoPath);
      const result = await plugin.execute(createTask(repoPath), workspace, null);

      expect(result.exitCode).toBe(1);
      expect(result.summary).toBe("Project WORKFLOW_PROMPTS.md is missing or invalid");
      expect(result.metadata).toEqual(expect.objectContaining({
        workflowStage: "workflow-prompts"
      }));
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("creates and reuses Cursor chat sessions", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-cursor-"));
    try {
      const repoPath = join(sandbox, "repo");
      await mkdir(repoPath, { recursive: true });
      await writeWorkflowPrompts(repoPath, {
        root: false,
        content: buildWorkflowPrompts(["Implement"])
      });
      const bin = join(sandbox, "fake-cursor");
      await writeFile(
        bin,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "create-chat") {
  console.log("chat-123");
  process.exit(0);
}
if (args[0] === "agent") {
  console.log(JSON.stringify({ text: args.includes("--resume") ? "cursor resumed" : "cursor fresh" }));
  process.exit(0);
}
process.exit(1);
`
      );
      await execFileAsync("chmod", ["+x", bin]);

      const plugin = new CursorExecutionPlugin(bin, 60_000);
      await mkdir(join(sandbox, "artifacts"), { recursive: true });
      const workspace = createWorkspace(sandbox, repoPath);
      const first = await plugin.execute(createTask(repoPath), workspace, null);
      const resumed = await plugin.continueSession?.(first.sessionId ?? "", createTask(repoPath), workspace, {
        id: "goal-1",
        taskId: "task-1",
        objective: "repair",
        constraints: [],
        doneWhen: ["pass build"],
        status: "repairing",
        currentIteration: 1,
        maxIterations: 3,
        lastFailureHash: null,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      expect(first.sessionId).toBe("cursor:chat-123");
      expect(first.summary).toBe("cursor resumed");
      expect(resumed?.summary).toBe("cursor resumed");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("applies workflow node loops within a single Cursor execution", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-cursor-"));
    try {
      const repoPath = join(sandbox, "repo");
      await mkdir(repoPath, { recursive: true });
      await writeWorkflowPrompts(repoPath, {
        root: false,
        content: buildWorkflowPrompts(["Implement"], {
          Implement: { loopEnabled: true, maxLoops: 2 }
        })
      });
      const bin = join(sandbox, "fake-cursor");
      await writeFile(
        bin,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "create-chat") {
  console.log("chat-123");
  process.exit(0);
}
if (args[0] === "agent") {
  console.log(JSON.stringify({ text: "cursor resumed" }));
  process.exit(0);
}
process.exit(1);
`
      );
      await execFileAsync("chmod", ["+x", bin]);

      const plugin = new CursorExecutionPlugin(bin, 60_000);
      await mkdir(join(sandbox, "artifacts"), { recursive: true });
      const workspace = createWorkspace(sandbox, repoPath);
      const result = await plugin.execute(createTask(repoPath), workspace, null);

      expect(result.exitCode).toBe(0);
      expect(result.metadata).toEqual(expect.objectContaining({
        workflowNodeNames: ["Implement"],
        nodeExecutions: [
          expect.objectContaining({ node: "Implement", iteration: 1, loopCount: 2 }),
          expect.objectContaining({ node: "Implement", iteration: 2, loopCount: 2 })
        ]
      }));
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("DefaultObservabilityGovernancePlugin", () => {
  it("blocks commands that violate configured policy before execution", async () => {
    const plugin = new DefaultObservabilityGovernancePlugin();
    await plugin.init({
      id: "cfg-gov",
      pluginId: plugin.id,
      kind: "observability-governance",
      enabled: true,
      priority: 100,
      config: {
        allowCommandPrefixes: ["codex"],
        blockCommandPatterns: ["git\\s+push"],
        maxPromptChars: 20
      },
      updatedAt: new Date("2026-05-11T00:00:00.000Z")
    });

    await expect(plugin.beforeCommand?.(["bash", "-lc", "git push origin main"])).rejects.toThrow(
      /allowlist|blocked policy|maxPromptChars/i
    );
    expect(plugin.getRecords?.()[0]).toEqual(expect.objectContaining({
      phase: "before_command",
      outcome: "blocked"
    }));
  });

  it("sanitizes command output, records governance metadata, and escalates risky eval results", async () => {
    const plugin = new DefaultObservabilityGovernancePlugin();
    await plugin.init({
      id: "cfg-gov",
      pluginId: plugin.id,
      kind: "observability-governance",
      enabled: true,
      priority: 100,
      config: {
        maxOutputChars: 40,
        maxFilesChanged: 2,
        maxDiffLines: 5
      },
      updatedAt: new Date("2026-05-11T00:00:00.000Z")
    });

    const execution = {
      exitCode: 0,
      stdout: "token sk-12345678901234567890 and more output that should definitely be truncated by governance",
      stderr: "",
      summary: "authorization: bearer demo",
      sessionId: "codex:s1",
      timedOut: false,
      errorCategory: "none" as const,
      timeoutCategory: "none" as const,
      metadata: {}
    };
    await plugin.afterCommand?.(["codex", "exec", "do work"], execution);

    expect(execution.stdout).toContain("[redacted");
    expect(execution.stdout).toContain("[truncated-output]");
    expect((execution.metadata as Record<string, unknown>).governance).toEqual([
      expect.objectContaining({
        phase: "after_command",
        outcome: "flagged"
      })
    ]);

    const evalResult = {
      id: "eval-1",
      taskId: "task-1",
      executionId: "exec-1",
      passed: true,
      score: 100,
      riskLevel: "low" as const,
      report: {
        diff: {
          filesChanged: 3,
          insertions: 4,
          deletions: 3
        },
        note: "api_key=secret-value"
      },
      createdAt: new Date("2026-05-11T00:00:00.000Z")
    };
    await plugin.afterEval?.(evalResult);

    expect(evalResult.passed).toBe(false);
    expect(evalResult.riskLevel).toBe("high");
    expect(evalResult.report.note).toBe("api_key=[redacted-secret]");
    expect((evalResult.report as Record<string, unknown>).governance).toEqual([
      expect.objectContaining({
        phase: "after_eval",
        outcome: "blocked"
      })
    ]);
  });
});

describe("RootLogsPlugin", () => {
  it("writes task, trace, and executor logs into the root logs directory", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-logs-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(sandbox);
      const plugin = new RootLogsPlugin();
      await plugin.init();

      await plugin.append({
        id: "log-1",
        createdAt: new Date("2026-05-11T00:00:00.000Z"),
        level: "info",
        channel: "execution_log",
        eventType: "executor.completed",
        message: "Execution completed",
        taskId: "task-1",
        traceId: "trace-1",
        executionId: "execution-1",
        data: {
          correlation: { traceId: "trace-1" },
          stdout: "hello stdout",
          stderr: "hello stderr",
          summary: "hello summary"
        }
      });

      const taskLog = await readFile(join(sandbox, "logs", "tasks", "task-1", "task.log"), "utf8");
      const traceLog = await readFile(join(sandbox, "logs", "traces", "trace-1", "trace.log"), "utf8");
      const executionLog = await readFile(join(sandbox, "logs", "tasks", "task-1", "execution-execution-1.log"), "utf8");

      expect(taskLog).toContain("\"eventType\":\"executor.completed\"");
      expect(traceLog).toContain("\"traceId\":\"trace-1\"");
      expect(executionLog).toContain("\"executionId\":\"execution-1\"");
    } finally {
      process.chdir(previousCwd);
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("MeegleTaskIntegrationPlugin", () => {
  it("pulls tasks from a configured JSON file and reports results to an output file", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-meegle-"));
    try {
      const tasksFile = join(sandbox, "tasks.json");
      const resultsFile = join(sandbox, "results.json");
      await writeFile(tasksFile, JSON.stringify({
        tasks: [
          {
            id: "MEEGLE-1",
            title: "Fix build",
            instruction: "Run build and fix errors",
            repo: "https://example.com/repo.git",
            branch: "main",
            executor: "codex",
            acceptanceCriteria: ["Build passes"]
          }
        ]
      }, null, 2));

      const plugin = new MeegleTaskIntegrationPlugin({
        ...createConfig(sandbox),
        plugins: {
          ...createConfig(sandbox).plugins,
          meegle: {
            mode: "polling",
            tasksFile,
            resultsFile,
            webhookSecret: null
          }
        }
      });

      const pulled = await plugin.pullTasks();
      expect(pulled).toHaveLength(1);
      expect(pulled[0]).toEqual(expect.objectContaining({
        source: "meegle",
        externalId: "MEEGLE-1",
        title: "Fix build"
      }));

      await plugin.reportResult(pulled[0], "Completed successfully");
      const results = JSON.parse(await readFile(resultsFile, "utf8")) as Array<Record<string, unknown>>;
      expect(results[0]).toEqual(expect.objectContaining({
        externalId: "MEEGLE-1",
        summary: "Completed successfully"
      }));
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("uses the legacy Meegle task CLI flow when available", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-meegle-cli-"));
    const previousLegacy = process.env.MEEGLE_TEST_LEGACY;
    const previousLog = process.env.MEEGLE_TEST_LOG;
    try {
      const bin = join(sandbox, "fake-meegle");
      const logPath = join(sandbox, "cli-log.jsonl");
      await writeFakeMeegleCli(bin);
      process.env.MEEGLE_TEST_LEGACY = "1";
      process.env.MEEGLE_TEST_LOG = logPath;

      const plugin = new MeegleTaskIntegrationPlugin({
        ...createConfig(sandbox),
        plugins: {
          ...createConfig(sandbox).plugins,
          meegle: {
            ...createConfig(sandbox).plugins.meegle,
            mode: "polling",
            cliBin: bin,
            tasksFile: null,
            resultsFile: null,
            webhookSecret: null,
            projectKey: "PROJ",
            queryMql: "SELECT * FROM backlog"
          }
        }
      });

      const pulled = await plugin.pullTasks();
      expect(pulled).toEqual([
        expect.objectContaining({
          source: "meegle",
          externalId: "MEEGLE-LEGACY-1",
          repo: "https://example.com/legacy.git",
          branch: "main",
          instruction: "Legacy fix",
          priority: "high"
        })
      ]);
    } finally {
      process.env.MEEGLE_TEST_LEGACY = previousLegacy;
      process.env.MEEGLE_TEST_LOG = previousLog;
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("falls back to workitem CLI queries and reports results back to Meegle comments", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-meegle-cli-"));
    const previousLegacy = process.env.MEEGLE_TEST_LEGACY;
    const previousLog = process.env.MEEGLE_TEST_LOG;
    try {
      const bin = join(sandbox, "fake-meegle");
      const logPath = join(sandbox, "cli-log.jsonl");
      await writeFakeMeegleCli(bin);
      delete process.env.MEEGLE_TEST_LEGACY;
      process.env.MEEGLE_TEST_LOG = logPath;

      const plugin = new MeegleTaskIntegrationPlugin({
        ...createConfig(sandbox),
        plugins: {
          ...createConfig(sandbox).plugins,
          meegle: {
            ...createConfig(sandbox).plugins.meegle,
            mode: "polling",
            cliBin: bin,
            tasksFile: null,
            resultsFile: null,
            webhookSecret: null,
            projectKey: "PROJ",
            queryMql: "SELECT * FROM backlog",
            detailFields: ["repo", "branch", "instruction", "priority"]
          }
        }
      });

      const pulled = await plugin.pullTasks();
      expect(pulled).toEqual([
        expect.objectContaining({
          externalId: "MEEGLE-MQL-1",
          title: "Query task",
          repo: "https://example.com/query.git",
          branch: "feature/query",
          instruction: "Implement query flow",
          priority: "high"
        })
      ]);

      await plugin.reportResult({ ...pulled[0], status: "done" }, "Completed successfully");
      const logLines = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(logLines).toContainEqual(expect.arrayContaining(["comment", "add", "--work-item-id", "MEEGLE-MQL-1"]));
    } finally {
      process.env.MEEGLE_TEST_LEGACY = previousLegacy;
      process.env.MEEGLE_TEST_LOG = previousLog;
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("reports needs_human comments and reads human replies from Meegle comments", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-meegle-cli-"));
    const previousLegacy = process.env.MEEGLE_TEST_LEGACY;
    const previousLog = process.env.MEEGLE_TEST_LOG;
    try {
      const bin = join(sandbox, "fake-meegle");
      const logPath = join(sandbox, "cli-log.jsonl");
      await writeFakeMeegleCli(bin);
      delete process.env.MEEGLE_TEST_LEGACY;
      process.env.MEEGLE_TEST_LOG = logPath;

      const plugin = new MeegleTaskIntegrationPlugin({
        ...createConfig(sandbox),
        plugins: {
          ...createConfig(sandbox).plugins,
          meegle: {
            ...createConfig(sandbox).plugins.meegle,
            mode: "polling",
            cliBin: bin,
            tasksFile: null,
            resultsFile: null,
            webhookSecret: null,
            projectKey: "PROJ",
            queryMql: "SELECT * FROM backlog"
          }
        }
      });

      const task = {
        ...createTask("https://example.com/query.git"),
        id: "task-human-1",
        source: "meegle",
        externalId: "MEEGLE-MQL-1",
        traceId: "trace-human-1",
        metadata: {
          humanLoop: {
            requestId: "request-1",
            requestedAt: "2026-05-11T00:00:00.000Z",
            seenReplyIds: []
          }
        }
      };

      await plugin.reportNeedsHuman?.(task, {
        reason: "High-risk modification detected",
        stopReason: "high_risk",
        summary: "The diff touches too many files",
        requestId: "request-1",
        requestedAt: "2026-05-11T00:00:00.000Z"
      });
      const replies = await plugin.pullHumanReplies?.([task]);
      const logLines = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);

      expect(logLines).toContainEqual(expect.arrayContaining(["comment", "add", "--work-item-id", "MEEGLE-MQL-1"]));
      expect(logLines).toContainEqual(expect.arrayContaining(["comment", "list", "--work-item-id", "MEEGLE-MQL-1"]));
      expect(replies).toEqual([
        expect.objectContaining({
          taskId: "task-human-1",
          externalId: "MEEGLE-MQL-1",
          replyId: "comment-user-1",
          body: "Please retry with the latest requirements",
          author: "alice"
        })
      ]);
    } finally {
      process.env.MEEGLE_TEST_LEGACY = previousLegacy;
      process.env.MEEGLE_TEST_LOG = previousLog;
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("uses latest sprint CLI detail fallback from description blocks", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-meegle-cli-"));
    const previousLegacy = process.env.MEEGLE_TEST_LEGACY;
    const previousLog = process.env.MEEGLE_TEST_LOG;
    try {
      const bin = join(sandbox, "fake-meegle");
      const logPath = join(sandbox, "cli-log.jsonl");
      await writeFakeMeegleCli(bin);
      delete process.env.MEEGLE_TEST_LEGACY;
      process.env.MEEGLE_TEST_LOG = logPath;

      const plugin = new MeegleTaskIntegrationPlugin({
        ...createConfig(sandbox),
        plugins: {
          ...createConfig(sandbox).plugins,
          meegle: {
            ...createConfig(sandbox).plugins.meegle,
            mode: "polling",
            sourceMode: "latest_sprint",
            cliBin: bin,
            tasksFile: null,
            resultsFile: null,
            webhookSecret: null,
            projectKey: "PROJ",
            projectScopeName: "scope",
            sprintTypeName: "Sprint",
            demandTypeName: "Demand",
            sprintLinkField: "规划迭代",
            nodeName: "开发",
            latestSprintDetailFields: ["description"]
          }
        }
      });

      const pulled = await plugin.pullTasks();
      expect(pulled).toEqual([
        expect.objectContaining({
          externalId: "MEEGLE-LS-1",
          repo: "https://example.com/latest.git",
          branch: "release/1.2",
          instruction: "Finish latest sprint work",
          metadata: expect.objectContaining({
            latestSprint: expect.objectContaining({
              id: "321"
            })
          })
        })
      ]);
    } finally {
      process.env.MEEGLE_TEST_LEGACY = previousLegacy;
      process.env.MEEGLE_TEST_LOG = previousLog;
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("supports webhook mode health, secret verification, and webhook payload parsing", async () => {
    const plugin = new MeegleTaskIntegrationPlugin({
      ...createConfig("/tmp"),
      plugins: {
        ...createConfig("/tmp").plugins,
        meegle: {
          mode: "webhook",
          tasksFile: null,
          resultsFile: null,
          webhookSecret: "secret-1"
        }
      }
    });

    await expect(plugin.health()).resolves.toEqual({
      healthy: true,
      message: "Meegle webhook integration ready"
    });
    expect(plugin.verifyWebhookSecret("secret-1")).toBe(true);
    expect(plugin.verifyWebhookSecret("wrong")).toBe(false);
    expect(plugin.webhookHealth()).toEqual({
      mode: "webhook",
      healthy: true,
      authMode: "shared-secret",
      tasksFileConfigured: false,
      resultsFileConfigured: false,
      webhookSecretConfigured: true
    });
    expect(plugin.parseWebhookTasks({
      task: {
        id: "MEEGLE-99",
        title: "Webhook issue",
        instruction: "Do webhook work",
        repo: "https://example.com/repo.git",
        branch: "main"
      }
    })).toEqual([
      expect.objectContaining({
        source: "meegle",
        externalId: "MEEGLE-99",
        title: "Webhook issue"
      })
    ]);
  });

  it("starts and polls Meegle browser authorization via the CLI device-code flow", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-meegle-auth-"));
    const previousAuthState = process.env.MEEGLE_TEST_AUTH_STATE;
    const previousLog = process.env.MEEGLE_TEST_LOG;
    try {
      const bin = join(sandbox, "fake-meegle");
      const logPath = join(sandbox, "cli-log.jsonl");
      await writeFakeMeegleCli(bin);
      process.env.MEEGLE_TEST_AUTH_STATE = "unauthenticated";
      process.env.MEEGLE_TEST_LOG = logPath;

      const plugin = new MeegleTaskIntegrationPlugin({
        ...createConfig(sandbox),
        plugins: {
          ...createConfig(sandbox).plugins,
          meegle: {
            ...createConfig(sandbox).plugins.meegle,
            mode: "polling",
            cliBin: bin,
            tasksFile: null,
            resultsFile: null,
            webhookSecret: null
          }
        }
      });

      await expect(plugin.getAuthStatus()).resolves.toEqual(expect.objectContaining({
        status: "unauthenticated",
        authenticated: false,
        message: "Meegle authorization required"
      }));

      const started = await plugin.startAuth();
      expect(started).toEqual(expect.objectContaining({
        status: "pending",
        authorizationUrl: "https://project.feishu.cn/auth/device",
        deviceCode: "device-123",
        clientId: "client-123",
        intervalSeconds: 2,
        expiresInSeconds: 600
      }));

      await expect(plugin.pollAuth({
        deviceCode: started.deviceCode,
        clientId: started.clientId,
        intervalSeconds: started.intervalSeconds,
        expiresInSeconds: started.expiresInSeconds
      })).resolves.toEqual(expect.objectContaining({
        status: "pending",
        authenticated: false
      }));

      process.env.MEEGLE_TEST_AUTH_STATE = "authenticated";
      await expect(plugin.pollAuth({
        deviceCode: started.deviceCode,
        clientId: started.clientId,
        intervalSeconds: started.intervalSeconds,
        expiresInSeconds: started.expiresInSeconds
      })).resolves.toEqual(expect.objectContaining({
        status: "authenticated",
        authenticated: true
      }));

      await plugin.logoutAuth();
      const logLines = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(logLines).toContainEqual(expect.arrayContaining(["auth", "login", "--device-code", "--phase", "init"]));
      expect(logLines).toContainEqual(expect.arrayContaining(["auth", "login", "--device-code", "--phase", "poll", "--once"]));
      expect(logLines).toContainEqual(["auth", "logout", "--format", "json"]);
    } finally {
      process.env.MEEGLE_TEST_AUTH_STATE = previousAuthState;
      process.env.MEEGLE_TEST_LOG = previousLog;
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

function createConfig(root: string): ServerConfig {
  return {
    port: 3000,
    scheduler: {
      intervalMs: 30_000,
      agentCount: 1,
      agentOfflineTimeoutMs: 300_000
    },
    workspace: {
      root: join(root, ".titing-workspaces"),
      repoCacheRoot: join(root, ".titing-repos"),
      cleanupOnSuccess: true,
      cleanupOnFailure: false
    },
    goalRecovery: {
      executionTimeoutMs: 60_000,
      qualityTimeoutMs: 60_000,
      environmentRetryLimit: 2,
      executionRetryLimit: 2,
      maxRepairIterations: 3,
      enableNeedsHumanLoop: false
    },
    plugins: {
      execution: {
        defaultExecutor: "codex",
        codexBin: "codex",
        cursorBin: "agent"
      },
      meegle: {
        mode: "polling",
        tasksFile: null,
        resultsFile: null,
        webhookSecret: null
      }
    },
    governance: {
      allowCommandPrefixes: [],
      blockCommandPatterns: [
        "\\bgit\\s+push\\b",
        "\\brm\\s+-rf\\s+/",
        "\\bterraform\\s+destroy\\b",
        "\\baws\\s+iam\\b",
        "\\bssh\\b",
        "\\bscp\\b"
      ],
      maxPromptChars: 16_000,
      maxOutputChars: 12_000,
      maxFilesChanged: 20,
      maxDiffLines: 400
    }
  };
}

function createTask(repo: string): TitingTask {
  const now = new Date("2026-05-11T00:00:00.000Z");
  return {
    id: "task-1",
    source: "manual",
    externalId: null,
    title: "demo",
    instruction: "do work",
    repo,
    branch: "main",
    priority: "medium",
    status: "running",
    executor: "codex",
    traceId: "trace-1",
    constraints: [],
    acceptanceCriteria: [],
    metadata: {},
    retryCount: 0,
    repairCount: 0,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

async function writeWorkflowPrompts(
  repoPath: string,
  input: { root: boolean; content: string }
): Promise<void> {
  const target = input.root
    ? join(repoPath, "WORKFLOW_PROMPTS.md")
    : join(repoPath, "knowledge", "WORKFLOW_PROMPTS.md");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, input.content);
}

function buildWorkflowPrompts(
  nodeNames: string[],
  config: Record<string, { loopEnabled?: boolean; maxLoops?: number }> = {}
): string {
  const workflow = nodeNames.map((nodeName) => `- \`${nodeName}\``).join("\n");
  const sections = nodeNames.map((nodeName) => {
    const nodeConfig = config[nodeName] ?? {};
    return `### ${nodeName}

\`\`\`text
${nodeName} for {{taskTitle}}
\`\`\`

- \`loopEnabled: ${nodeConfig.loopEnabled ? "true" : "false"}\`
- \`maxLoops: ${nodeConfig.maxLoops ?? 1}\``;
  }).join("\n\n");
  return `## Agents 默认执行流程

${workflow}

## 节点 Prompt 模板

${sections}
`;
}

async function createGitRepo(path: string, files: Record<string, string>): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(["init"], path);
  await git(["config", "user.email", "test@example.com"], path);
  await git(["config", "user.name", "Test User"], path);
  for (const [filePath, content] of Object.entries(files)) {
    await writeFile(join(path, filePath), content);
  }
  await git(["add", "."], path);
  await git(["commit", "-m", "init"], path);
  await git(["branch", "-M", "main"], path);
}

async function writeFakeMeegleCli(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const logPath = process.env.MEEGLE_TEST_LOG;
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
}
const print = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "project" && args[1] === "search") {
  print({ items: [{ key: "PROJ" }] });
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  if (process.env.MEEGLE_TEST_AUTH_STATE === "unauthenticated") {
    process.stderr.write("Meegle authorization required");
    process.exit(1);
  }
  print({ authenticated: true, host: "project.feishu.cn" });
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login" && args.includes("--device-code") && args.includes("--phase") && args.includes("init")) {
  print({
    authorization_url: "https://project.feishu.cn/auth/device",
    device_code: "device-123",
    client_id: "client-123",
    interval: 2,
    expires_in: 600,
    user_code: "ABCD-EFGH"
  });
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login" && args.includes("--device-code") && args.includes("--phase") && args.includes("poll")) {
  if (process.env.MEEGLE_TEST_AUTH_STATE === "authenticated") {
    print({ authenticated: true, host: "project.feishu.cn" });
    process.exit(0);
  }
  print({ status: "pending", authenticated: false });
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "logout") {
  print({ ok: true });
  process.exit(0);
}
if (args[0] === "task" && args[1] === "list") {
  if (process.env.MEEGLE_TEST_LEGACY === "1") {
    print([{ id: "MEEGLE-LEGACY-1", title: "Legacy task" }]);
    process.exit(0);
  }
  process.stderr.write("unknown command");
  process.exit(1);
}
if (args[0] === "task" && args[1] === "get") {
  print({
    id: args[2],
    repo: "https://example.com/legacy.git",
    branch: "main",
    instruction: "Legacy fix",
    priority: "high"
  });
  process.exit(0);
}
if (args[0] === "workitem" && args[1] === "query") {
  const mql = args[args.indexOf("--mql") + 1] || "";
  if (mql.includes("FROM \`scope\`.\`Sprint\`")) {
    print({
      data: {
        data: {
          "1": [
            {
              moql_field_list: [
                { key: "work_item_id", name: "工作项id", value: { long_value: 321 } },
                { key: "name", name: "名称", value: { string_value: "Sprint 321" } }
              ]
            }
          ]
        },
        list: [{ count: 1 }]
      }
    });
    process.exit(0);
  }
  if (mql.includes("any_relation_match")) {
    print([{ "工作项id": "MEEGLE-LS-1", "名称": "Latest sprint task" }]);
    process.exit(0);
  }
  print([{ work_item_id: "MEEGLE-MQL-1", name: "Query task" }]);
  process.exit(0);
}
if (args[0] === "workitem" && args[1] === "get") {
  const taskId = args[args.indexOf("--work-item-id") + 1];
  if (taskId === "MEEGLE-MQL-1") {
    print({
      data: {
        work_item_attribute: {
          work_item_id: taskId,
          work_item_name: "Query task",
          work_item_status: { name: "P1" },
          owned_project: { key: "PROJ" }
        },
        work_item_fields: [
          { key: "repo", value: "https://example.com/query.git" },
          { key: "branch", value: "feature/query" },
          { key: "instruction", value: "Implement query flow" }
        ]
      }
    });
    process.exit(0);
  }
  if (taskId === "MEEGLE-LS-1") {
    print({
      data: {
        work_item_attribute: {
          work_item_id: taskId,
          work_item_name: "Latest sprint task",
          work_item_status: { name: "P2" },
          owned_project: { key: "PROJ" }
        },
        work_item_fields: [
          { key: "description", value: "Repo: https://example.com/latest.git\\nBranch: release/1.2\\n---\\nFinish latest sprint work" }
        ]
      }
    });
    process.exit(0);
  }
}
if (args[0] === "comment" && args[1] === "add") {
  print({ ok: true });
  process.exit(0);
}
if (args[0] === "comment" && args[1] === "list") {
  print({
    comments: [
      {
        id: "comment-system-1",
        content: "[TITING_NEEDS_HUMAN requestId=id-1 taskId=task-1 traceId=trace-task-1]"
      },
      {
        id: "comment-user-1",
        content: "Please retry with the latest requirements",
        author: "alice",
        createdAt: "2026-05-11T00:10:00.000Z"
      }
    ]
  });
  process.exit(0);
}
process.exit(1);
`
  );
  await execFileAsync("chmod", ["+x", path]);
}

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function createWorkspace(root: string, repoPath: string) {
  return {
    workspacePath: root,
    repoPath,
    branch: "main",
    cachePath: join(root, ".cache"),
    artifactsPath: join(root, "artifacts"),
    env: {}
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
