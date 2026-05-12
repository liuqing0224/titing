import { CONFIG_DEFAULTS, readConfig } from "./config";

describe("readConfig", () => {
  it("reads structured config groups from env", () => {
    const config = readConfig({
      BACKEND_PORT: "4100",
      TITING_SCHEDULER_INTERVAL_MS: "45000",
      TITING_SCHEDULER_AGENT_COUNT: "4",
      TITING_SCHEDULER_AGENT_OFFLINE_TIMEOUT_MS: "610000",
      TITING_WORKSPACE_ROOT: "./tmp/workspaces",
      TITING_WORKSPACE_REPO_CACHE_ROOT: "./tmp/repos",
      TITING_WORKSPACE_CLEANUP_ON_SUCCESS: "false",
      TITING_WORKSPACE_CLEANUP_ON_FAILURE: "true",
      TITING_GOAL_EXECUTION_TIMEOUT_MS: "120000",
      TITING_GOAL_QUALITY_TIMEOUT_MS: "240000",
      TITING_GOAL_ENVIRONMENT_RETRY_LIMIT: "5",
      TITING_GOAL_EXECUTION_RETRY_LIMIT: "4",
      TITING_GOAL_MAX_REPAIR_ITERATIONS: "7",
      TITING_PLUGIN_EXECUTION_CODEX_BIN: "codex-dev",
      TITING_PLUGIN_EXECUTION_CURSOR_BIN: "cursor-dev",
      TITING_PLUGIN_MEEGLE_MODE: "polling",
      TITING_PLUGIN_MEEGLE_TASKS_FILE: "./tasks.json",
      TITING_PLUGIN_MEEGLE_RESULTS_FILE: "./results.json",
      TITING_GOVERNANCE_ALLOW_COMMAND_PREFIXES: "codex,agent",
      TITING_GOVERNANCE_BLOCK_COMMAND_PATTERNS: "git\\s+push,rm\\s+-rf",
      TITING_GOVERNANCE_MAX_PROMPT_CHARS: "8000",
      TITING_GOVERNANCE_MAX_OUTPUT_CHARS: "9000",
      TITING_GOVERNANCE_MAX_FILES_CHANGED: "11",
      TITING_GOVERNANCE_MAX_DIFF_LINES: "222"
    });

    expect(config).toEqual(expect.objectContaining({
      port: 4100,
      scheduler: expect.objectContaining({
        intervalMs: 45_000,
        agentCount: 4,
        agentOfflineTimeoutMs: 610_000
      }),
      workspace: expect.objectContaining({
        root: expect.stringContaining("tmp/workspaces"),
        repoCacheRoot: expect.stringContaining("tmp/repos"),
        cleanupOnSuccess: false,
        cleanupOnFailure: true
      }),
      goalRecovery: expect.objectContaining({
        executionTimeoutMs: 120_000,
        qualityTimeoutMs: 240_000,
        environmentRetryLimit: 5,
        executionRetryLimit: 4,
        maxRepairIterations: 7
      }),
      plugins: expect.objectContaining({
        execution: {
          codexBin: "codex-dev",
          cursorBin: "cursor-dev"
        },
        meegle: expect.objectContaining({
          mode: "polling",
          tasksFile: "./tasks.json",
          resultsFile: "./results.json",
          webhookSecret: null,
          sourceMode: null,
          cliBin: "meegle"
        })
      }),
      governance: expect.objectContaining({
        allowCommandPrefixes: ["codex", "agent"],
        blockCommandPatterns: ["git\\s+push", "rm\\s+-rf"],
        maxPromptChars: 8000,
        maxOutputChars: 9000,
        maxFilesChanged: 11,
        maxDiffLines: 222
      })
    }));
  });

  it("supports legacy env names as fallback", () => {
    const config = readConfig({
      TITING_AGENT_COUNT: "3",
      TITING_AGENT_OFFLINE_TIMEOUT_MS: "123000",
      TITING_REPO_CACHE_ROOT: "./legacy-repos",
      TITING_CLEANUP_ON_SUCCESS: "0",
      TITING_CLEANUP_ON_FAILURE: "1",
      TITING_EXECUTION_TIMEOUT_MS: "99000",
      TITING_QUALITY_TIMEOUT_MS: "88000",
      TITING_MEEGLE_TASKS_FILE: "./legacy-tasks.json",
      TITING_MEEGLE_RESULTS_FILE: "./legacy-results.json",
      CODEX_CLI_BIN: "codex-legacy",
      CURSOR_CLI_BIN: "agent-legacy"
    });

    expect(config.scheduler.agentCount).toBe(3);
    expect(config.scheduler.agentOfflineTimeoutMs).toBe(123_000);
    expect(config.workspace.repoCacheRoot).toContain("legacy-repos");
    expect(config.workspace.cleanupOnSuccess).toBe(false);
    expect(config.workspace.cleanupOnFailure).toBe(true);
    expect(config.goalRecovery.executionTimeoutMs).toBe(99_000);
    expect(config.goalRecovery.qualityTimeoutMs).toBe(88_000);
    expect(config.plugins.meegle.tasksFile).toBe("./legacy-tasks.json");
    expect(config.plugins.execution.codexBin).toBe("codex-legacy");
    expect(config.plugins.execution.cursorBin).toBe("agent-legacy");
  });

  it("throws on invalid values and invalid webhook config", () => {
    expect(() => readConfig({
      TITING_SCHEDULER_AGENT_COUNT: "0"
    })).toThrow("Invalid positive number for TITING_SCHEDULER_AGENT_COUNT: 0");

    expect(() => readConfig({
      TITING_PLUGIN_MEEGLE_MODE: "webhook"
    })).toThrow("Webhook Meegle mode requires TITING_PLUGIN_MEEGLE_WEBHOOK_SECRET");
  });

  it("returns defaults when no env overrides are provided", () => {
    const config = readConfig({});

    expect(config.scheduler.intervalMs).toBe(CONFIG_DEFAULTS.scheduler.intervalMs);
    expect(config.goalRecovery.maxRepairIterations).toBe(CONFIG_DEFAULTS.goalRecovery.maxRepairIterations);
    expect(config.governance.maxDiffLines).toBe(CONFIG_DEFAULTS.governance.maxDiffLines);
  });
});
