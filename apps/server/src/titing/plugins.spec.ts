import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  LocalWorktreeEnvironmentPlugin
} from "./plugins";
import { ServerConfig } from "./config";
import { TitingTask } from "@titing/plugin-api";

const execFileAsync = promisify(execFile);

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

  it("creates and reuses Cursor chat sessions", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-cursor-"));
    try {
      const repoPath = join(sandbox, "repo");
      await mkdir(repoPath, { recursive: true });
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
      maxRepairIterations: 3
    },
    plugins: {
      execution: {
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
