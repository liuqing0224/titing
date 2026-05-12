# Titing Configuration

更新日期：2026-05-12

Titing 服务端配置现已按运行职责收敛为结构化模型：

```ts
type ServerConfig = {
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
    enableNeedsHumanLoop: boolean;
  };
  plugins: {
    execution: {
      defaultExecutor: "codex" | "cursor";
      codexBin: string;
      cursorBin: string;
    };
    meegle: {
      mode: "polling" | "webhook";
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
```

## Environment Variables

### Port

| Env | Default | Notes |
| --- | --- | --- |
| `BACKEND_PORT` | `3000` | Fastify listen 端口 |

### Scheduler

| Env | Default | Legacy Fallback | Notes |
| --- | --- | --- | --- |
| `TITING_SCHEDULER_INTERVAL_MS` | `30000` | - | scheduler tick 间隔 |
| `TITING_SCHEDULER_AGENT_COUNT` | `2` | `TITING_AGENT_COUNT` | 启动时 seed agent 数量 |
| `TITING_SCHEDULER_AGENT_OFFLINE_TIMEOUT_MS` | `300000` | `TITING_AGENT_OFFLINE_TIMEOUT_MS` | agent heartbeat 超时阈值 |

### Workspace

| Env | Default | Legacy Fallback | Notes |
| --- | --- | --- | --- |
| `TITING_WORKSPACE_ROOT` | `.titing/workspaces` | - | task worktree 根目录 |
| `TITING_WORKSPACE_REPO_CACHE_ROOT` | `.titing/repos` | `TITING_REPO_CACHE_ROOT` | bare mirror cache 根目录 |
| `TITING_WORKSPACE_CLEANUP_ON_SUCCESS` | `true` | `TITING_CLEANUP_ON_SUCCESS` | 成功后是否删除 workspace |
| `TITING_WORKSPACE_CLEANUP_ON_FAILURE` | `false` | `TITING_CLEANUP_ON_FAILURE` | 失败后是否删除 workspace |

### Goal Recovery

| Env | Default | Legacy Fallback | Notes |
| --- | --- | --- | --- |
| `TITING_GOAL_EXECUTION_TIMEOUT_MS` | `1800000` | `TITING_EXECUTION_TIMEOUT_MS` | executor / workspace 命令超时 |
| `TITING_GOAL_QUALITY_TIMEOUT_MS` | `600000` | `TITING_QUALITY_TIMEOUT_MS` | quality scripts 超时 |
| `TITING_GOAL_ENVIRONMENT_RETRY_LIMIT` | `2` | - | 环境失败自动重试次数 |
| `TITING_GOAL_EXECUTION_RETRY_LIMIT` | `2` | - | 执行阶段瞬时失败自动重试次数 |
| `TITING_GOAL_MAX_REPAIR_ITERATIONS` | `3` | - | Goal Loop 最大 repair 轮次 |
| `TITING_GOAL_ENABLE_NEEDS_HUMAN_LOOP` | `false` | - | 是否启用 stop signal 自动转 `needs_human` 以及评论恢复闭环 |

### Plugins

| Env | Default | Legacy Fallback | Notes |
| --- | --- | --- | --- |
| `TITING_DEFAULT_EXECUTOR` | `codex` | `TITING_PLUGIN_EXECUTION_DEFAULT_EXECUTOR` | 未显式传 `executor` 的任务默认执行器，可选 `codex` 或 `cursor` |
| `TITING_PLUGIN_EXECUTION_CODEX_BIN` | `codex` | `CODEX_CLI_BIN` | Codex CLI binary |
| `TITING_PLUGIN_EXECUTION_CURSOR_BIN` | `agent` | `CURSOR_CLI_BIN` | Cursor CLI binary |
| `TITING_PLUGIN_MEEGLE_MODE` | `polling` | - | `polling` 或 `webhook` |
| `TITING_PLUGIN_MEEGLE_TASKS_FILE` | `null` | `TITING_MEEGLE_TASKS_FILE` | 文件型任务源 |
| `TITING_PLUGIN_MEEGLE_RESULTS_FILE` | `null` | `TITING_MEEGLE_RESULTS_FILE` | 文件型结果回写 |
| `TITING_PLUGIN_MEEGLE_WEBHOOK_SECRET` | `null` | - | webhook 模式必填 |

Webhook API:

- `POST /api/integrations/meegle/webhook`
- Header: `x-titing-webhook-secret: <secret>`
- Payload: `{ "task": {...} }` or `{ "tasks": [...] }`
- `GET /api/integrations/meegle/health` 可查看当前 mode 与 secret readiness

### Governance

| Env | Default | Notes |
| --- | --- | --- |
| `TITING_GOVERNANCE_ALLOW_COMMAND_PREFIXES` | empty | 逗号分隔 allowlist |
| `TITING_GOVERNANCE_BLOCK_COMMAND_PATTERNS` | built-in defaults | 逗号分隔 regex 列表 |
| `TITING_GOVERNANCE_MAX_PROMPT_CHARS` | `16000` | 最大命令载荷长度 |
| `TITING_GOVERNANCE_MAX_OUTPUT_CHARS` | `12000` | stdout/stderr 单段最大保留长度 |
| `TITING_GOVERNANCE_MAX_FILES_CHANGED` | `20` | diff 文件数阈值 |
| `TITING_GOVERNANCE_MAX_DIFF_LINES` | `400` | diff 行数阈值 |

## Validation Rules

- 所有 `*_MS`、retry limit、repair iterations 都必须是正数。
- `workspace.root` 与 `workspace.repoCacheRoot` 不能相同。
- `plugins.meegle.mode=webhook` 时必须提供 `TITING_PLUGIN_MEEGLE_WEBHOOK_SECRET`。
- `plugins.meegle.mode=polling` 且配置了 results file 时，必须同时配置 tasks file。

## Compatibility

- 新配置名优先，旧 env 名作为 fallback 继续兼容。
- 推荐后续新增配置一律使用结构化前缀，不再扩散扁平命名。
