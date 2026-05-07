# AutoDev Agent

AutoDev Agent 是一个 local-first 的 AI engineering orchestration system。它把 Meegle 中的产品任务同步到本地，交给固定规模的 Agent 池调度执行，再通过 **execution engine 插件**（默认可选用 Codex CLI 或 Cursor CLI）在目标仓库的独立 `git worktree` 中跑完整的研发工作流。

这个项目的重点不是做一个大而全的托管平台，而是先把一条实用链路跑通：任务接入、状态校验、Agent 调度、AI 执行、日志追踪和结果回写。

## 功能亮点

- 从 Meegle CLI 同步 open tasks，并将任务字段标准化为本地 `Task`。
- 支持自动同步和手动同步，同步间隔可在 Ops Console 中调整并持久化。
- 通过 `pending -> queued -> running -> done/failed` 状态机管理任务生命周期。
- 根据 `repo`、`branch`、`instruction` 校验任务是否可执行，失败原因会写入 execution logs。
- 每个任务在独立 `git worktree` 中执行，减少多个任务共享工作区带来的干扰。
- 使用目标仓库的 `knowledge/WORKFLOW_PROMPTS.md` 定义节点化执行流程。
- 内置 execution engine 插件：可按 workflow node 调用 `codex exec`（`codex-executor`）或 Cursor CLI 非交互 `agent -p`（`cursor-executor`，见下方插件优先级说明）。
- 提供 Ops Console，查看任务、Agent、Dashboard stats、Meegle sync 设置和执行日志。
- 通过 Server-Sent Events 推送 `task.lifecycle`、`agent.status` 等事件。
- 执行结束后将成功或失败摘要回写到 Meegle work item。

## 系统架构

```text
Meegle CLI
    |
    v
Task Source Plugin -> Task Store -> Orchestrator Core -> Execution Engine Plugin
      ^                                 |                         |
      |                                 v                         v
Result Reporter Plugin <- Execution Result <- Agent Runtime Plugin
      |
      v
Ops Console / SSE / Execution Logs
```

核心系统只负责通用编排能力：任务状态机、Agent 管理、调度、事件、日志和插件注册。具体的外部系统和运行方式都通过插件接入，目前仓库内置了 Meegle、Codex executor、Cursor executor、local runtime、TypeORM store、file log store、SSE event bus 和 Ops Console。

## 技术栈

- Backend：`NestJS`、`TypeORM`、`PostgreSQL`、`@nestjs/schedule`
- Frontend：`React`、`Vite`、`TypeScript`
- Runtime：`Codex CLI` 或 **Cursor CLI**（`agent` / `cursor agent`）、`git worktree`、local host command runner
- Monorepo：`npm workspaces`

## 内置插件


| 插件                | 类型                 | 作用                                                                                             |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| `meegle`          | `composite`        | 同步 Meegle 任务，并将执行结果回写为 Meegle comment                                                          |
| `codex-executor`  | `execution-engine` | 解析 `WORKFLOW_PROMPTS.md`，编排 `codex exec` 执行节点（默认 priority `100`）                               |
| `cursor-executor` | `execution-engine` | 同上编排，节点执行改为 Cursor CLI：`agent -p --workspace <worktree>`（默认 priority `110`，高于 codex 时会覆盖为当前引擎） |
| `local-runtime`   | `agent-runtime`    | 在宿主机本地运行命令                                                                                     |
| `typeorm-store`   | `composite`        | 提供 `taskStore`、`agentStore`、`settingsStore`                                                    |
| `file-log-store`  | `composite`        | 将 execution logs 写入本地文件                                                                        |
| `sse-event-bus`   | `composite`        | 通过 SSE 广播系统事件                                                                                  |
| `ops-console`     | `ui-backend`       | 提供运维控制台后端和前端入口                                                                                 |


插件由 `apps/server/src/plugin-loader.ts` 自动发现。只要在 `plugins/<plugin>/src/plugin.manifest.ts` 中导出符合 `ServerPluginManifest` 的 manifest，服务启动时就会加载。

**Execution engine 二选一**：`PluginHostModule` 按各 manifest 的 `priority` 选取 **唯一** 的 `execution-engine` 实现。仓库中 `cursor-executor`（`110`）高于 `codex-executor`（`100`），因此默认启用 Cursor 引擎；若要改回 Codex，可将 `codex-executor` 的 `priority` 调高，或暂时移除/不导出另一插件的 manifest。

## 目录结构

```text
apps/
  server/                    NestJS host shell
  web/                       React host shell
packages/
  core/                      任务、Agent、调度、事件、日志和插件协议
plugins/
  codex-executor/            Codex workflow execution engine
  cursor-executor/           Cursor CLI workflow execution engine
  file-log-store/            文件日志存储
  local-runtime/             本地命令运行时
  meegle/                    Meegle task source、settings 和 result reporter
  ops-console/               Ops Console UI plugin
  sse-event-bus/             SSE event bus
  typeorm-store/             PostgreSQL / TypeORM store
docs/
  pm/prd.md                  产品需求文档
  templates/                 Workflow prompt 模板
logs/                        本地 execution log 输出目录
```

## 快速开始

### 环境准备

本地需要先准备：

- `Node.js` 和 `npm`
- `PostgreSQL`
- `git`
- `codex` CLI（使用 `codex-executor` 且其为当前引擎时）
- Cursor CLI：`agent` 或 `cursor`（使用 `cursor-executor` 且其为当前引擎时；非交互需配置 `CURSOR_API_KEY` 或先 `cursor agent login`）
- `meegle` CLI

如果需要让 AutoDev Agent 执行真实仓库任务，目标仓库还应提供 `AGENTS.md`，并在 `knowledge/WORKFLOW_PROMPTS.md` 中声明 workflow。仓库根目录的 `WORKFLOW_PROMPTS.md` 也可作为兼容位置使用。

### 安装依赖

```bash
npm install
cp .env.example .env
```

根据你的本地环境修改 `.env`，尤其是数据库、Meegle、当前选用的 execution engine（Codex / Cursor）和 workspace 相关配置。

### 准备数据库

`.env.example` 默认连接到：

```text
postgresql://autodev:autodev@localhost:55432/autodev
```

确认数据库可连接后，执行 migration：

```bash
npm run migration:run -w apps/server
```

### 启动开发服务

后端和前端需要分别启动：

```bash
npm run dev:backend
npm run dev:frontend
```

默认地址：

- Frontend：`http://localhost:5173`
- Backend API：`http://localhost:3000/api`
- PostgreSQL：`localhost:55432`

## 常用命令

```bash
npm run dev:backend
npm run dev:frontend
npm test
npm run build
npm run migration:run -w apps/server
npm run migration:revert -w apps/server
```

## 配置

配置通过 `.env` 注入，完整示例见 `.env.example`。

### 基础服务


| 变量                  | 默认值                         | 说明                          |
| ------------------- | --------------------------- | --------------------------- |
| `BACKEND_PORT`      | `3000`                      | Backend API 端口              |
| `VITE_API_BASE_URL` | `http://localhost:3000/api` | Frontend 请求后端的 API base URL |
| `DATABASE_HOST`     | `localhost`                 | PostgreSQL host             |
| `DATABASE_PORT`     | `55432`                     | PostgreSQL port             |
| `DATABASE_USER`     | `autodev`                   | PostgreSQL user             |
| `DATABASE_PASSWORD` | `autodev`                   | PostgreSQL password         |
| `DATABASE_NAME`     | `autodev`                   | PostgreSQL database         |


### Agent 与执行


| 变量                                | 默认值                             | 说明                                                        |
| --------------------------------- | ------------------------------- | --------------------------------------------------------- |
| `AGENT_POOL_SIZE`                 | `2`                             | 固定 Agent 池大小                                              |
| `AGENT_HEARTBEAT_TIMEOUT_SECONDS` | `60`                            | Agent heartbeat 超时时间                                      |
| `CODEX_CLI_BIN`                   | `codex`                         | Codex CLI 可执行文件                                           |
| `CODEX_WORKDIR`                   | `/tmp/autodev-agent/workspaces` | 目标仓库和 worktree 的工作目录                                      |
| `CODEX_TIMEOUT_MS`                | `1800000`                       | 单次 Codex 执行超时时间                                           |
| `CODEX_IGNORE_USER_CONFIG`        | `false`                         | 是否忽略用户 Codex 配置                                           |
| `CURSOR_CLI_BIN`                  | `agent`                         | Cursor CLI：通常为 `agent`；若为 `cursor` 可执行文件会自动插入 `agent` 子命令 |
| `CURSOR_WORKDIR`                  | 未设置则同 `CODEX_WORKDIR`           | Cursor 引擎使用的 worktree 根目录                                 |
| `CURSOR_TIMEOUT_MS`               | `1800000`                       | 单次 Cursor CLI 节点执行超时                                      |
| `CURSOR_API_KEY`                  | 空                               | 非交互鉴权（也可用 `cursor agent login`）                           |
| `CURSOR_MODEL`                    | 空                               | 传给 `--model`                                              |
| `CURSOR_AGENT_MODE`               | 空                               | `plan` 或 `ask`（默认 agent 模式不传）                             |
| `CURSOR_OUTPUT_FORMAT`            | `text`                          | `--output-format`                                         |
| `CURSOR_SANDBOX`                  | 空                               | `enabled` 或 `disabled`                                    |
| `CURSOR_TRUST_WORKSPACE`          | `true`                          | 非交互时是否加 `--trust`                                         |
| `CURSOR_FORCE_COMMANDS`           | `true`                          | 是否加 `--force`（自动批准命令）                                     |
| `CURSOR_APPROVE_MCPS`             | `false`                         | 是否加 `--approve-mcps`                                      |


### Meegle


| 变量                                   | 默认值                                                  | 说明                   |
| ------------------------------------ | ---------------------------------------------------- | -------------------- |
| `MEEGLE_CLI_BIN`                     | `meegle`                                             | Meegle CLI 可执行文件     |
| `MEEGLE_SYNC_ENABLED`                | `true`                                               | 是否启用自动同步             |
| `MEEGLE_SYNC_INTERVAL_MINUTES`       | `5`                                                  | 自动同步间隔               |
| `MEEGLE_SOURCE_MODE`                 | 空                                                    | Meegle 任务来源模式        |
| `MEEGLE_PROJECT_KEY`                 | 空                                                    | Meegle 项目 key        |
| `MEEGLE_QUERY_MQL`                   | 空                                                    | 自定义 MQL 查询           |
| `MEEGLE_DETAIL_FIELDS`               | `repo,branch,instruction,priority,description,title` | 同步任务详情时读取的字段         |
| `MEEGLE_LATEST_SPRINT_DETAIL_FIELDS` | `description`                                        | 拉取最新 sprint 任务时读取的字段 |


当 Meegle 需要认证时，后端会触发 login 流程，前端收到 SSE event 后会在 host browser 中打开登录页。

## Workflow Prompt System

AutoDev Agent 不把研发流程写死在代码里。每个目标仓库可以通过 `WORKFLOW_PROMPTS.md` 定义自己的节点顺序、节点 prompt、循环规则和产物约束。

Execution engine（`codex-executor` 与 `cursor-executor`）默认查找：

```text
knowledge/WORKFLOW_PROMPTS.md
```

可以从模板开始改：

- `[docs/templates/WORKFLOW_PROMPTS.example.md](docs/templates/WORKFLOW_PROMPTS.example.md)`

一个实际 workflow 通常会把任务拆成 planning、documentation、implementation、review、verification 等节点。每个节点会生成独立 prompt，并由当前选用的 CLI 在对应 worktree 中执行（Codex：`codex exec`；Cursor：`agent -p --workspace <worktree>`）。

## 任务生命周期

```text
pending -> queued -> running -> done
                         |
                         v
                       failed
```

- `pending` 任务会先校验 `repo` 和 `instruction`，字段无效会进入 `failed`。
- `queued` 任务等待空闲 Agent 认领。
- `running` 任务由 Orchestrator 调用 execution engine 执行。
- Agent offline 时，运行中的任务会尝试恢复或重试。
- `failed` 任务在后续同步中如果 execution fields 恢复有效，可重新回到 `pending`。
- `done` 任务在 `repo`、`branch`、`instruction` 等执行关键字段变化时会重新回到 `pending`。

## API 与可观测性

当前 UI 以 Ops Console 为主，后端提供任务、Agent、ExecutionLog、Dashboard 和 Meegle adapter 相关 API。状态变化通过 SSE 推送，前端在收到事件后重新拉取任务、Agent 和 Dashboard 快照，避免长连接日志流带来的复杂度。

Execution logs 会记录 stage、stdout、stderr、exit code、timeout、worktree path、`AGENTS.md` 路径和 `WORKFLOW_PROMPTS.md` 路径。调试一次任务失败时，通常先从对应任务的 execution logs 开始看。

Nest 框架日志（如 `MeegleAdapter`、`OrchestratorService`、`CursorRunner` 等）在默认配置下会**追加写入**项目下的 `logs/server.log`（与按任务分文件的 `logs/auto-*.jsonl` 不同）；可通过环境变量 `NEST_LOG_TO_FILE=false` 关闭写文件，或用 `NEST_LOG_DIR` / `NEST_LOG_FILE` 调整路径与文件名。

## 当前范围

这个仓库仍然是一个 local-first MVP，已经覆盖：

- Meegle CLI 任务同步
- 固定规模 Agent pool
- 自动调度与生命周期管理
- Codex / Cursor workflow execution
- `git worktree` 隔离执行
- ExecutionLog 查询
- Ops Console 和 SSE 实时更新
- Meegle comment 回写

暂不覆盖：

- GitHub 官方集成
- Webhook 外部推送
- 动态 Agent pool sizing
- 托管式远程执行平台
- 自动创建 PR 的完整流程

## 开源化演进建议

如果 AutoDev Agent 面向开源用户发布，最重要的变化不是简单补几个插件，而是把项目从“内置插件组成的本地工具”推进到“有稳定 plugin API、安全默认配置、低门槛 quickstart 的可扩展平台”。现阶段的 monorepo 内置插件机制适合快速迭代，但第三方开发者需要更清晰的包边界、配置入口和风险模型。

### 插件机制与包边界

当前插件由 `apps/server/src/plugin-loader.ts` 扫描 `plugins/*/src/plugin.manifest.ts`，这对仓库内置插件很方便，但不适合作为第三方插件发布方式。开源版本建议保留内置插件，同时支持：

- 约定加载 `@autodev-agent/plugin-`* npm 包。
- 通过配置文件显式声明启用哪些插件。
- 使用 `ACTIVE_EXECUTION_ENGINE` 明确当前 execution engine，避免仅靠 priority 推断。
- 在启动阶段检查插件能力、版本范围、依赖项和健康状态。

`packages/core` 也应收敛成真正可发布的 SDK 边界。第三方插件不应该 import 仓库内部深层相对路径，而应依赖稳定包，例如：

- `@autodev-agent/core`
- `@autodev-agent/plugin-api`
- `@autodev-agent/shared-workflow-runner`

### 安全默认值与显式配置

开源用户的运行环境不可控，默认安全策略需要更保守。API 默认只监听 `127.0.0.1`，Frontend origin 使用白名单，管理接口需要 `admin token`。Runtime 不应默认继承完整 `process.env`，而应提供 `runtime env allowlist`，并把 `sandbox`、approval、CLI 权限模型写进配置和文档。

配置层也应从 `.env` 猜路径，转向统一的显式配置。建议引入 `autodev.config.ts` 或 `autodev.config.json`，让 `.env` 只承担 secret 和本地覆盖。`APP_ROOT`、`PLUGIN_ROOT`、`WORKSPACE_ROOT`、`LOG_ROOT` 等路径应在配置中明确声明，服务启动时打印最终解析结果，降低 CWD heuristic 带来的不确定性。

文档需要直接说明风险模型：AutoDev Agent 会执行目标仓库代码，也会调用本机 CLI、访问本地凭据和创建 `git worktree`。这类能力适合 local-first 自动化，但默认配置必须提醒用户从最小权限开始。

### 存储、调度与执行模型

当前默认使用 PostgreSQL，对开源 quickstart 来说门槛偏高。建议保留 PostgreSQL 作为 production store，同时支持 SQLite 作为默认试用方案，file log store 继续保留。Migration 应统一从同一个 DataSource 来源读取配置，避免不同启动路径下的数据库配置不一致。

调度器也需要从 MVP polling 模型升级为更可扩展的 dispatch 模型。`scheduler` 只负责 claim 和 dispatch，长时间运行的任务交给独立 execution worker；系统维护 running execution registry，避免同一任务重复执行。后续可以把队列后端替换为 BullMQ / Redis / in-memory queue，而不改变上层任务生命周期语义。

Executor 是开源后最可能被社区扩展的部分，因此 Cursor / Codex runner 中重复的 workflow 逻辑应抽到共享层：

- shared workflow parser
- worktree manager
- execution log adapter
- engine strategy：只负责构造 CLI args、读取 engine 配置、解释失败原因

### 任务来源与开源治理

Meegle 对内部场景有价值，但不应成为开源用户理解项目的默认核心路径。主叙事应抽象为 Task Source Plugin：manual / local JSON / GitHub Issues 可以作为开源友好的默认入口，Meegle 则降级为 enterprise/internal plugin 示例。

开源发布还需要补齐工程治理材料：

- `LICENSE`
- `CONTRIBUTING.md`
- plugin API stability policy
- versioning / changelog
- security policy
- example plugin template
- Docker Compose quickstart

## 未来规划


| 优先级  | 目标                 | 说明                                                                                                                      |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `P0` | 安全默认值              | 收紧 API 监听地址、Frontend origin、admin token、runtime env allowlist、sandbox / approval 默认行为，并在文档中声明执行目标仓库代码的风险模型。             |
| `P0` | 配置显式化              | 引入 `autodev.config.ts` 或 `autodev.config.json`，明确 `APP_ROOT`、`PLUGIN_ROOT`、`WORKSPACE_ROOT`、`LOG_ROOT`，启动时打印最终解析结果。     |
| `P0` | DataSource 统一      | 让应用启动、migration 和测试使用同一套 DataSource 配置来源，减少环境差异。                                                                        |
| `P1` | SQLite quickstart  | 默认支持 SQLite store，PostgreSQL 保留为 recommended production store，file log store 继续作为轻量日志方案。                                |
| `P1` | SDK 包边界            | 将 `packages/core` 拆成稳定发布包，例如 `@autodev-agent/core`、`@autodev-agent/plugin-api`、`@autodev-agent/shared-workflow-runner`。 |
| `P1` | Meegle 可选化         | 将 Meegle 从默认核心路径调整为可选插件，并补充 manual / local JSON / GitHub Issues 等通用 Task Source Plugin 示例。                              |
| `P1` | Dispatch 式调度       | 拆分 scheduler 与 execution worker，引入 running execution registry，为未来 queue backend 做准备。                                    |
| `P1` | 共享 workflow runner | 抽出 workflow parser、worktree manager 和 execution log adapter，让新增 execution engine 只实现 engine strategy。                   |
| `P2` | 第三方 npm 插件加载       | 支持加载 `@autodev-agent/plugin-*` 包，并通过配置文件声明启用插件。                                                                         |
| `P2` | 插件模板与健康检查          | 提供 example plugin template、插件能力 / 版本 / 依赖健康检查，以及 plugin API 兼容性文档。                                                      |


## 适用场景

AutoDev Agent 更适合内部工程自动化试点：你已经有稳定的 PM 任务来源，也希望 AI agent 在自己的仓库、自己的凭据和自己的本地环境中执行。它让团队先把“任务到代码执行”的流程标准化，再决定哪些部分需要走向更强的平台化。