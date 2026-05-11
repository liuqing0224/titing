import { resolve } from "node:path";

export type ServerConfig = {
  port: number;
  scheduler: {
    intervalMs: number;
    agentCount: number;
    agentOfflineTimeoutMs: number;
  };
  workspace: {
    root: string;
    repoCacheRoot: string;
    cleanupOnSuccess: boolean;
    cleanupOnFailure: boolean;
  };
  goalRecovery: {
    executionTimeoutMs: number;
    qualityTimeoutMs: number;
    environmentRetryLimit: number;
    executionRetryLimit: number;
    maxRepairIterations: number;
  };
  plugins: {
    execution: {
      codexBin: string;
      cursorBin: string;
    };
    meegle: {
      mode: "polling" | "webhook";
      sourceMode?: "latest_sprint" | null;
      cliBin?: string;
      projectKey?: string | null;
      projectScopeName?: string | null;
      sprintTypeName?: string | null;
      demandTypeName?: string | null;
      sprintLinkField?: string | null;
      nodeName?: string | null;
      queryMql?: string | null;
      detailFields?: string[];
      latestSprintDetailFields?: string[];
      tasksFile: string | null;
      resultsFile: string | null;
      webhookSecret: string | null;
    };
  };
  governance: {
    allowCommandPrefixes: string[];
    blockCommandPatterns: string[];
    maxPromptChars: number;
    maxOutputChars: number;
    maxFilesChanged: number;
    maxDiffLines: number;
  };
};

export const CONFIG_DEFAULTS = {
  port: 3000,
  scheduler: {
    intervalMs: 30_000,
    agentCount: 2,
    agentOfflineTimeoutMs: 300_000
  },
  workspace: {
    root: ".titing/workspaces",
    repoCacheRoot: ".titing/repos",
    cleanupOnSuccess: true,
    cleanupOnFailure: false
  },
  goalRecovery: {
    executionTimeoutMs: 1_800_000,
    qualityTimeoutMs: 600_000,
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
      mode: "polling" as const,
      sourceMode: null as "latest_sprint" | null,
      cliBin: "meegle",
      projectKey: null,
      projectScopeName: null,
      sprintTypeName: null,
      demandTypeName: null,
      sprintLinkField: null,
      nodeName: null,
      queryMql: null,
      detailFields: [] as string[],
      latestSprintDetailFields: [] as string[],
      tasksFile: null,
      resultsFile: null,
      webhookSecret: null
    }
  },
  governance: {
    allowCommandPrefixes: [] as string[],
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

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = readPositiveNumber(env, ["BACKEND_PORT"], CONFIG_DEFAULTS.port);
  const meegleMode = readEnum(env, ["TITING_PLUGIN_MEEGLE_MODE"], ["polling", "webhook"], CONFIG_DEFAULTS.plugins.meegle.mode);
  const config: ServerConfig = {
    port,
    scheduler: {
      intervalMs: readPositiveNumber(
        env,
        ["TITING_SCHEDULER_INTERVAL_MS"],
        CONFIG_DEFAULTS.scheduler.intervalMs
      ),
      agentCount: readPositiveNumber(
        env,
        ["TITING_SCHEDULER_AGENT_COUNT", "TITING_AGENT_COUNT"],
        CONFIG_DEFAULTS.scheduler.agentCount
      ),
      agentOfflineTimeoutMs: readPositiveNumber(
        env,
        ["TITING_SCHEDULER_AGENT_OFFLINE_TIMEOUT_MS", "TITING_AGENT_OFFLINE_TIMEOUT_MS"],
        CONFIG_DEFAULTS.scheduler.agentOfflineTimeoutMs
      )
    },
    workspace: {
      root: resolve(readString(env, ["TITING_WORKSPACE_ROOT"], CONFIG_DEFAULTS.workspace.root)),
      repoCacheRoot: resolve(
        readString(
          env,
          ["TITING_WORKSPACE_REPO_CACHE_ROOT", "TITING_REPO_CACHE_ROOT"],
          CONFIG_DEFAULTS.workspace.repoCacheRoot
        )
      ),
      cleanupOnSuccess: readBoolean(
        env,
        ["TITING_WORKSPACE_CLEANUP_ON_SUCCESS", "TITING_CLEANUP_ON_SUCCESS"],
        CONFIG_DEFAULTS.workspace.cleanupOnSuccess
      ),
      cleanupOnFailure: readBoolean(
        env,
        ["TITING_WORKSPACE_CLEANUP_ON_FAILURE", "TITING_CLEANUP_ON_FAILURE"],
        CONFIG_DEFAULTS.workspace.cleanupOnFailure
      )
    },
    goalRecovery: {
      executionTimeoutMs: readPositiveNumber(
        env,
        ["TITING_GOAL_EXECUTION_TIMEOUT_MS", "TITING_EXECUTION_TIMEOUT_MS"],
        CONFIG_DEFAULTS.goalRecovery.executionTimeoutMs
      ),
      qualityTimeoutMs: readPositiveNumber(
        env,
        ["TITING_GOAL_QUALITY_TIMEOUT_MS", "TITING_QUALITY_TIMEOUT_MS"],
        CONFIG_DEFAULTS.goalRecovery.qualityTimeoutMs
      ),
      environmentRetryLimit: readPositiveNumber(
        env,
        ["TITING_GOAL_ENVIRONMENT_RETRY_LIMIT"],
        CONFIG_DEFAULTS.goalRecovery.environmentRetryLimit
      ),
      executionRetryLimit: readPositiveNumber(
        env,
        ["TITING_GOAL_EXECUTION_RETRY_LIMIT"],
        CONFIG_DEFAULTS.goalRecovery.executionRetryLimit
      ),
      maxRepairIterations: readPositiveNumber(
        env,
        ["TITING_GOAL_MAX_REPAIR_ITERATIONS"],
        CONFIG_DEFAULTS.goalRecovery.maxRepairIterations
      )
    },
    plugins: {
      execution: {
        codexBin: readString(
          env,
          ["TITING_PLUGIN_EXECUTION_CODEX_BIN", "CODEX_CLI_BIN"],
          CONFIG_DEFAULTS.plugins.execution.codexBin
        ),
        cursorBin: readString(
          env,
          ["TITING_PLUGIN_EXECUTION_CURSOR_BIN", "CURSOR_CLI_BIN"],
          CONFIG_DEFAULTS.plugins.execution.cursorBin
        )
      },
      meegle: {
        mode: meegleMode,
        sourceMode: (() => {
          const value = readOptionalString(
            env,
            ["MEEGLE_SOURCE_MODE", "TITING_PLUGIN_MEEGLE_SOURCE_MODE"],
            CONFIG_DEFAULTS.plugins.meegle.sourceMode
          );
          return value === "latest_sprint" ? "latest_sprint" : null;
        })(),
        cliBin: readString(
          env,
          ["MEEGLE_CLI_BIN", "TITING_PLUGIN_MEEGLE_CLI_BIN"],
          CONFIG_DEFAULTS.plugins.meegle.cliBin ?? "meegle"
        ),
        projectKey: readOptionalString(
          env,
          ["MEEGLE_PROJECT_KEY", "TITING_PLUGIN_MEEGLE_PROJECT_KEY"],
          CONFIG_DEFAULTS.plugins.meegle.projectKey
        ),
        projectScopeName: readOptionalString(
          env,
          ["MEEGLE_PROJECT_SCOPE_NAME", "TITING_PLUGIN_MEEGLE_PROJECT_SCOPE_NAME"],
          CONFIG_DEFAULTS.plugins.meegle.projectScopeName
        ),
        sprintTypeName: readOptionalString(
          env,
          ["MEEGLE_SPRINT_TYPE_NAME", "TITING_PLUGIN_MEEGLE_SPRINT_TYPE_NAME"],
          CONFIG_DEFAULTS.plugins.meegle.sprintTypeName
        ),
        demandTypeName: readOptionalString(
          env,
          ["MEEGLE_DEMAND_TYPE_NAME", "TITING_PLUGIN_MEEGLE_DEMAND_TYPE_NAME"],
          CONFIG_DEFAULTS.plugins.meegle.demandTypeName
        ),
        sprintLinkField: readOptionalString(
          env,
          ["MEEGLE_SPRINT_LINK_FIELD", "TITING_PLUGIN_MEEGLE_SPRINT_LINK_FIELD"],
          CONFIG_DEFAULTS.plugins.meegle.sprintLinkField
        ),
        nodeName: readOptionalString(
          env,
          ["MEEGLE_NODE_NAME", "TITING_PLUGIN_MEEGLE_NODE_NAME"],
          CONFIG_DEFAULTS.plugins.meegle.nodeName
        ),
        queryMql: readOptionalString(
          env,
          ["MEEGLE_QUERY_MQL", "TITING_PLUGIN_MEEGLE_QUERY_MQL"],
          CONFIG_DEFAULTS.plugins.meegle.queryMql
        ),
        detailFields: readStringArray(
          env,
          ["MEEGLE_DETAIL_FIELDS", "TITING_PLUGIN_MEEGLE_DETAIL_FIELDS"],
          CONFIG_DEFAULTS.plugins.meegle.detailFields ?? []
        ),
        latestSprintDetailFields: readStringArray(
          env,
          ["MEEGLE_LATEST_SPRINT_DETAIL_FIELDS", "TITING_PLUGIN_MEEGLE_LATEST_SPRINT_DETAIL_FIELDS"],
          CONFIG_DEFAULTS.plugins.meegle.latestSprintDetailFields ?? []
        ),
        tasksFile: readOptionalString(
          env,
          ["TITING_PLUGIN_MEEGLE_TASKS_FILE", "TITING_MEEGLE_TASKS_FILE"],
          CONFIG_DEFAULTS.plugins.meegle.tasksFile
        ),
        resultsFile: readOptionalString(
          env,
          ["TITING_PLUGIN_MEEGLE_RESULTS_FILE", "TITING_MEEGLE_RESULTS_FILE"],
          CONFIG_DEFAULTS.plugins.meegle.resultsFile
        ),
        webhookSecret: readOptionalString(
          env,
          ["TITING_PLUGIN_MEEGLE_WEBHOOK_SECRET"],
          CONFIG_DEFAULTS.plugins.meegle.webhookSecret
        )
      }
    },
    governance: {
      allowCommandPrefixes: readStringArray(
        env,
        ["TITING_GOVERNANCE_ALLOW_COMMAND_PREFIXES"],
        CONFIG_DEFAULTS.governance.allowCommandPrefixes
      ),
      blockCommandPatterns: readStringArray(
        env,
        ["TITING_GOVERNANCE_BLOCK_COMMAND_PATTERNS"],
        CONFIG_DEFAULTS.governance.blockCommandPatterns
      ),
      maxPromptChars: readPositiveNumber(
        env,
        ["TITING_GOVERNANCE_MAX_PROMPT_CHARS"],
        CONFIG_DEFAULTS.governance.maxPromptChars
      ),
      maxOutputChars: readPositiveNumber(
        env,
        ["TITING_GOVERNANCE_MAX_OUTPUT_CHARS"],
        CONFIG_DEFAULTS.governance.maxOutputChars
      ),
      maxFilesChanged: readPositiveNumber(
        env,
        ["TITING_GOVERNANCE_MAX_FILES_CHANGED"],
        CONFIG_DEFAULTS.governance.maxFilesChanged
      ),
      maxDiffLines: readPositiveNumber(
        env,
        ["TITING_GOVERNANCE_MAX_DIFF_LINES"],
        CONFIG_DEFAULTS.governance.maxDiffLines
      )
    }
  };

  validateConfig(config);
  return config;
}

export function validateConfig(config: ServerConfig): void {
  const meegle = config.plugins.meegle;
  if (meegle.sourceMode === "latest_sprint") {
    if (!meegle.cliBin) {
      throw new Error("Latest sprint Meegle mode requires MEEGLE_CLI_BIN");
    }
    if (!meegle.projectKey || !meegle.projectScopeName || !meegle.sprintTypeName || !meegle.demandTypeName || !meegle.sprintLinkField) {
      throw new Error("Latest sprint Meegle mode requires project, sprint, demand, and link field configuration");
    }
  }
  if (meegle.mode === "polling" && meegle.resultsFile && !meegle.tasksFile) {
    throw new Error("Polling Meegle mode requires tasksFile when resultsFile is configured");
  }
  if (meegle.mode === "webhook" && !meegle.webhookSecret) {
    throw new Error("Webhook Meegle mode requires TITING_PLUGIN_MEEGLE_WEBHOOK_SECRET");
  }
  if (config.workspace.repoCacheRoot === config.workspace.root) {
    throw new Error("workspace.root and workspace.repoCacheRoot must be different paths");
  }
}

function readString(env: NodeJS.ProcessEnv, names: string[], fallback: string): string {
  const value = readEnv(env, names);
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function readOptionalString(env: NodeJS.ProcessEnv, names: string[], fallback: string | null): string | null {
  const value = readEnv(env, names);
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  return value.trim();
}

function readBoolean(env: NodeJS.ProcessEnv, names: string[], fallback: boolean): boolean {
  const value = readEnv(env, names);
  if (value === undefined) {
    return fallback;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  throw new Error(`Invalid boolean for ${names[0]}: ${value}`);
}

function readPositiveNumber(env: NodeJS.ProcessEnv, names: string[], fallback: number): number {
  const value = readEnv(env, names);
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive number for ${names[0]}: ${value}`);
  }
  return parsed;
}

function readEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  names: string[],
  allowed: T[],
  fallback: T
): T {
  const value = readEnv(env, names);
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  if (allowed.includes(value as T)) {
    return value as T;
  }
  throw new Error(`Invalid value for ${names[0]}: ${value}. Allowed: ${allowed.join(", ")}`);
}

function readStringArray(env: NodeJS.ProcessEnv, names: string[], fallback: string[]): string[] {
  const value = readEnv(env, names);
  if (value === undefined || value.trim().length === 0) {
    return [...fallback];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
