# Titing 配置说明（Titing Configuration）

更新日期：2026-05-12

Titing 服务端配置为结构化模型：对外端口与调度、工作区路径、Goal 恢复参数、插件（含外置包名与 Meegle）、治理策略等分组；由配置读取函数从环境变量装载，并通过校验函数在启动前检查必备项与互斥关系。

配置分组概览：端口；调度器（周期间隔、Agent 数量、离线超时）；工作区根目录与镜像缓存、成功/失败是否清理；执行与质量超时、各类重试与 repair 上限、是否启用人工介入闭环；各插件 kind 的外置 npm 包或文件路径、默认执行器与 CLI 路径、Meegle 轮询或 Webhook 及 CLI 拉数参数；治理侧允许命令前缀、拦截正则、提示与输出长度与 diff 规模阈值。

## 环境变量 (Environment variables)

### 数据库 (Database)

| 环境变量 (Env) | 默认值 (Default) | 说明 (Notes) |
| --- | --- | --- |
| DATABASE_FILE | （解析为 .titing/sqlite/titing.sqlite） | SQLite 数据库文件绝对或相对路径；父目录会自动创建 |

### 端口 (Port)

| 环境变量 (Env) | 默认值 (Default) | 说明 (Notes) |
| --- | --- | --- |
| BACKEND_PORT | 3000 | Fastify listen 端口 |

### 调度器 (Scheduler)

| 环境变量 (Env) | 默认值 (Default) | 兼容旧名 (Legacy fallback) | 说明 (Notes) |
| --- | --- | --- | --- |
| TITING_SCHEDULER_INTERVAL_MS | 30000 | - | scheduler tick 间隔 |
| TITING_SCHEDULER_AGENT_COUNT | 2 | TITING_AGENT_COUNT | 启动时 seed agent 数量 |
| TITING_SCHEDULER_AGENT_OFFLINE_TIMEOUT_MS | 300000 | TITING_AGENT_OFFLINE_TIMEOUT_MS | agent heartbeat 超时阈值 |

### 工作区 (Workspace)

| 环境变量 (Env) | 默认值 (Default) | 兼容旧名 (Legacy fallback) | 说明 (Notes) |
| --- | --- | --- | --- |
| TITING_WORKSPACE_ROOT | .titing/workspaces | - | task worktree 根目录 |
| TITING_WORKSPACE_REPO_CACHE_ROOT | .titing/repos | TITING_REPO_CACHE_ROOT | bare mirror cache 根目录 |
| TITING_WORKSPACE_CLEANUP_ON_SUCCESS | false | TITING_CLEANUP_ON_SUCCESS | 成功后是否删除 workspace；为 false 时保留完整 worktree 与 artifacts |
| TITING_WORKSPACE_CLEANUP_ON_FAILURE | false | TITING_CLEANUP_ON_FAILURE | 失败后是否删除 workspace；为 false 时保留完整 worktree 与 artifacts |

### Goal 恢复 (Goal recovery)

| 环境变量 (Env) | 默认值 (Default) | 兼容旧名 (Legacy fallback) | 说明 (Notes) |
| --- | --- | --- | --- |
| TITING_GOAL_EXECUTION_TIMEOUT_MS | 1800000 | TITING_EXECUTION_TIMEOUT_MS | executor / workspace 命令超时 |
| TITING_GOAL_QUALITY_TIMEOUT_MS | 600000 | TITING_QUALITY_TIMEOUT_MS | quality scripts 超时 |
| TITING_GOAL_ENVIRONMENT_RETRY_LIMIT | 2 | - | 环境失败自动重试次数 |
| TITING_GOAL_EXECUTION_RETRY_LIMIT | 2 | - | 执行阶段瞬时失败自动重试次数 |
| TITING_GOAL_MAX_REPAIR_ITERATIONS | 3 | - | Goal Loop 最大 repair 轮次 |
| TITING_GOAL_ENABLE_NEEDS_HUMAN_LOOP | false | - | 是否启用 stop signal 自动转 needs_human 以及评论恢复闭环 |

### 插件与其它 (Plugins)

各 TITING_PLUGIN_*_PACKAGE 环境变量非空时，宿主在启动时对该插件种类 kind 执行整类替换：仅加载外置模块返回的那一个插件实例，该 kind 下原有内置插件均不再注册。execution 一旦被外置替换，内置 Codex 与 Cursor 两个执行器会同时被一个外置插件替代，需在实现中自行支持多执行器能力或收窄能力与任务 executor 对齐。

#### 外置插件模块契约

- 启动时对该插件种类通过动态 import 加载：npm 包名，或以点号、斜线等形式给出的文件路径。
- 模块必须导出 createPlugin 工厂；也支持默认导出函数或默认导出对象上的同名工厂字段。
- 上下文携带整条配置快照与宿主期望的种类名；工厂的返回值种类字段必须与之匹配。
- 若需挂载 HTTP，在同一对象上按宿主约定的路由扩展实现 registerRoutes。

行文级示例思路见 [titing-plugin-development.md](./titing-plugin-development.md)。

| 环境变量 (Env) | 默认值 (Default) | 兼容旧名 (Legacy fallback) | 说明 (Notes) |
| --- | --- | --- | --- |
| TITING_PLUGIN_TASK_INTEGRATION_PACKAGE | null | - | 外部 task integration 插件包名或模块路径；配置后替换内置 Meegle |
| TITING_PLUGIN_EXECUTION_PACKAGE | null | - | 外部 execution 插件包名或模块路径；配置后替换内置 Codex/Cursor 执行器 |
| TITING_PLUGIN_ENVIRONMENT_PACKAGE | null | - | 外部 environment 插件包名或模块路径 |
| TITING_PLUGIN_QUALITY_PACKAGE | null | - | 外部 quality 插件包名或模块路径 |
| TITING_PLUGIN_OBSERVABILITY_GOVERNANCE_PACKAGE | null | - | 外部 governance 插件包名或模块路径 |
| TITING_PLUGIN_LOG_PACKAGE | null | - | 外部 log 插件包名或模块路径 |
| TITING_DEFAULT_EXECUTOR | codex | TITING_PLUGIN_EXECUTION_DEFAULT_EXECUTOR | 未显式传 executor 的任务默认执行器；使用外部 execution 插件时可设为该插件支持的 capability 名称 |
| TITING_PLUGIN_EXECUTION_CODEX_BIN | codex | CODEX_CLI_BIN | Codex CLI binary |
| TITING_PLUGIN_EXECUTION_CURSOR_BIN | agent | CURSOR_CLI_BIN | Cursor CLI binary |
| TITING_PLUGIN_MEEGLE_MODE | polling | - | polling 或 webhook |
| TITING_PLUGIN_MEEGLE_TASKS_FILE | null | TITING_MEEGLE_TASKS_FILE | 文件型任务源 |
| TITING_PLUGIN_MEEGLE_RESULTS_FILE | null | TITING_MEEGLE_RESULTS_FILE | 文件型结果回写 |
| TITING_PLUGIN_MEEGLE_WEBHOOK_SECRET | null | - | webhook 模式必填 |

#### Meegle CLI／最新迭代（sourceMode = latest_sprint）

以下变量在启用「通过 Meegle CLI 拉取最新迭代」时需要（校验逻辑同上）：

| 环境变量 (Env) | 说明 (Notes) |
| --- | --- |
| MEEGLE_CLI_BIN / TITING_PLUGIN_MEEGLE_CLI_BIN | Meegle CLI 可执行文件名，默认 meegle |
| MEEGLE_AUTH_HOST / TITING_PLUGIN_MEEGLE_AUTH_HOST | 认证 host |
| MEEGLE_AUTH_PROFILE / TITING_PLUGIN_MEEGLE_AUTH_PROFILE | 认证 profile |
| MEEGLE_PROJECT_KEY / TITING_PLUGIN_MEEGLE_PROJECT_KEY | 项目 key |
| MEEGLE_PROJECT_SCOPE_NAME / TITING_PLUGIN_MEEGLE_PROJECT_SCOPE_NAME | 项目范围名 |
| MEEGLE_SPRINT_TYPE_NAME / TITING_PLUGIN_MEEGLE_SPRINT_TYPE_NAME | 迭代类型名 |
| MEEGLE_DEMAND_TYPE_NAME / TITING_PLUGIN_MEEGLE_DEMAND_TYPE_NAME | 需求类型名 |
| MEEGLE_SPRINT_LINK_FIELD / TITING_PLUGIN_MEEGLE_SPRINT_LINK_FIELD | 迭代关联字段 |
| MEEGLE_NODE_NAME / TITING_PLUGIN_MEEGLE_NODE_NAME | 工作流节点名 |
| MEEGLE_QUERY_MQL / TITING_PLUGIN_MEEGLE_QUERY_MQL | 查询 MQL |
| MEEGLE_DETAIL_FIELDS / TITING_PLUGIN_MEEGLE_DETAIL_FIELDS | 逗号分隔详情字段列表 |
| MEEGLE_LATEST_SPRINT_DETAIL_FIELDS / TITING_PLUGIN_MEEGLE_LATEST_SPRINT_DETAIL_FIELDS | 最新迭代详情字段列表 |

将 MEEGLE_SOURCE_MODE 或 TITING_PLUGIN_MEEGLE_SOURCE_MODE 设为 latest_sprint 可开启「CLI 最新迭代」模式。

Webhook 模式下相关 HTTP 路径与头部约定详见接口文档中的 Integrations 章节（Meegle 小节）。

### 治理 (Governance)

| 环境变量 (Env) | 默认值 (Default) | 说明 (Notes) |
| --- | --- | --- |
| TITING_GOVERNANCE_ALLOW_COMMAND_PREFIXES | 留空 (empty) | 逗号分隔的允许前缀列表 (allowlist) |
| TITING_GOVERNANCE_BLOCK_COMMAND_PATTERNS | 内置默认 (built-in defaults) | 逗号分隔的正则拦截列表 (regex list) |
| TITING_GOVERNANCE_MAX_PROMPT_CHARS | 16000 | 最大命令载荷长度 |
| TITING_GOVERNANCE_MAX_OUTPUT_CHARS | 12000 | stdout/stderr 单段最大保留长度 |
| TITING_GOVERNANCE_MAX_FILES_CHANGED | 20 | diff 文件数阈值 |
| TITING_GOVERNANCE_MAX_DIFF_LINES | 400 | diff 行数阈值 |

## 校验规则 (Validation rules)

- 所有以毫秒结尾的超时、重试次数、repair 轮次等必须为正数。
- 工作区根目录与镜像缓存根目录不得为同一路径。
- Meegle 为 webhook 时必须提供 TITING_PLUGIN_MEEGLE_WEBHOOK_SECRET。
- Meegle 为 polling 且配置了结果文件时，必须同时配置任务文件。
- Meegle 选择 latest_sprint 源模式时，须补齐 CLI 与项目、迭代、需求字段等约束（见上表）。

## 兼容性 (Compatibility)

- 新配置名优先，旧 env 名作为 fallback 继续兼容。
- 推荐后续新增配置一律使用结构化前缀，不再扩散扁平命名。

## 日志落盘

当前服务端已内置根目录文件日志插件，默认把日志写入：

```text
logs/
  system/system.log
  tasks/<taskId>/task.log
  tasks/<taskId>/execution-<executionId>.log
  tasks/<taskId>/executor/<executionId>-stdout.log
  tasks/<taskId>/executor/<executionId>-stderr.log
  tasks/<taskId>/executor/<executionId>-summary.log
  traces/<traceId>/trace.log
```

说明：

- 当前没有额外的 env 用于切换日志目标目录，默认固定为仓库根目录 logs/
- 业务日志查询接口读取的是上述文件，而不是数据库 execution_logs 表
