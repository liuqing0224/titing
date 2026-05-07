# AutoDev Agent

AutoDev Agent 是一个 local-first 的 AI engineering orchestration system。它把 Meegle 中的产品任务同步到本地，交给固定规模的 Agent 池调度执行，再通过 Codex CLI 在目标仓库的独立 `git worktree` 中跑完整的研发工作流。

这个项目的重点不是做一个大而全的托管平台，而是先把一条实用链路跑通：任务接入、状态校验、Agent 调度、AI 执行、日志追踪和结果回写。

## 功能亮点

- 从 Meegle CLI 同步 open tasks，并将任务字段标准化为本地 `Task`。
- 支持自动同步和手动同步，同步间隔可在 Ops Console 中调整并持久化。
- 通过 `pending -> queued -> running -> done/failed` 状态机管理任务生命周期。
- 根据 `repo`、`branch`、`instruction` 校验任务是否可执行，失败原因会写入 execution logs。
- 每个任务在独立 `git worktree` 中执行，减少多个任务共享工作区带来的干扰。
- 使用目标仓库的 `knowledge/WORKFLOW_PROMPTS.md` 定义节点化执行流程。
- 内置 Codex execution engine，按 workflow node 调用 `codex exec`。
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

核心系统只负责通用编排能力：任务状态机、Agent 管理、调度、事件、日志和插件注册。具体的外部系统和运行方式都通过插件接入，目前仓库内置了 Meegle、Codex、local runtime、TypeORM store、file log store、SSE event bus 和 Ops Console。

## 技术栈

- Backend：`NestJS`、`TypeORM`、`PostgreSQL`、`@nestjs/schedule`
- Frontend：`React`、`Vite`、`TypeScript`
- Runtime：`Codex CLI`、`git worktree`、local host command runner
- Monorepo：`npm workspaces`

## 内置插件

| 插件 | 类型 | 作用 |
|------|------|------|
| `meegle` | `composite` | 同步 Meegle 任务，并将执行结果回写为 Meegle comment |
| `codex-executor` | `execution-engine` | 解析 `WORKFLOW_PROMPTS.md`，编排 `codex exec` 执行节点 |
| `local-runtime` | `agent-runtime` | 在宿主机本地运行命令 |
| `typeorm-store` | `composite` | 提供 `taskStore`、`agentStore`、`settingsStore` |
| `file-log-store` | `composite` | 将 execution logs 写入本地文件 |
| `sse-event-bus` | `composite` | 通过 SSE 广播系统事件 |
| `ops-console` | `ui-backend` | 提供运维控制台后端和前端入口 |

插件由 `apps/server/src/plugin-loader.ts` 自动发现。只要在 `plugins/<plugin>/src/plugin.manifest.ts` 中导出符合 `ServerPluginManifest` 的 manifest，服务启动时就会加载。

## 目录结构

```text
apps/
  server/                    NestJS host shell
  web/                       React host shell
packages/
  core/                      任务、Agent、调度、事件、日志和插件协议
plugins/
  codex-executor/            Codex workflow execution engine
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
- `codex` CLI
- `meegle` CLI

如果需要让 AutoDev Agent 执行真实仓库任务，目标仓库还应提供 `AGENTS.md`，并在 `knowledge/WORKFLOW_PROMPTS.md` 中声明 workflow。仓库根目录的 `WORKFLOW_PROMPTS.md` 也可作为兼容位置使用。

### 安装依赖

```bash
npm install
cp .env.example .env
```

根据你的本地环境修改 `.env`，尤其是数据库、Meegle、Codex 和 workspace 相关配置。

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

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BACKEND_PORT` | `3000` | Backend API 端口 |
| `VITE_API_BASE_URL` | `http://localhost:3000/api` | Frontend 请求后端的 API base URL |
| `DATABASE_HOST` | `localhost` | PostgreSQL host |
| `DATABASE_PORT` | `55432` | PostgreSQL port |
| `DATABASE_USER` | `autodev` | PostgreSQL user |
| `DATABASE_PASSWORD` | `autodev` | PostgreSQL password |
| `DATABASE_NAME` | `autodev` | PostgreSQL database |

### Agent 与执行

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENT_POOL_SIZE` | `2` | 固定 Agent 池大小 |
| `AGENT_HEARTBEAT_TIMEOUT_SECONDS` | `60` | Agent heartbeat 超时时间 |
| `CODEX_CLI_BIN` | `codex` | Codex CLI 可执行文件 |
| `CODEX_WORKDIR` | `/tmp/autodev-agent/workspaces` | 目标仓库和 worktree 的工作目录 |
| `CODEX_TIMEOUT_MS` | `1800000` | 单次 Codex 执行超时时间 |
| `CODEX_IGNORE_USER_CONFIG` | `false` | 是否忽略用户 Codex 配置 |

### Meegle

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEEGLE_CLI_BIN` | `meegle` | Meegle CLI 可执行文件 |
| `MEEGLE_SYNC_ENABLED` | `true` | 是否启用自动同步 |
| `MEEGLE_SYNC_INTERVAL_MINUTES` | `5` | 自动同步间隔 |
| `MEEGLE_SOURCE_MODE` | 空 | Meegle 任务来源模式 |
| `MEEGLE_PROJECT_KEY` | 空 | Meegle 项目 key |
| `MEEGLE_QUERY_MQL` | 空 | 自定义 MQL 查询 |
| `MEEGLE_DETAIL_FIELDS` | `repo,branch,instruction,priority,description,title` | 同步任务详情时读取的字段 |
| `MEEGLE_LATEST_SPRINT_DETAIL_FIELDS` | `description` | 拉取最新 sprint 任务时读取的字段 |

当 Meegle 需要认证时，后端会触发 login 流程，前端收到 SSE event 后会在 host browser 中打开登录页。

## Workflow Prompt System

AutoDev Agent 不把研发流程写死在代码里。每个目标仓库可以通过 `WORKFLOW_PROMPTS.md` 定义自己的节点顺序、节点 prompt、循环规则和产物约束。

Codex executor 默认查找：

```text
knowledge/WORKFLOW_PROMPTS.md
```

可以从模板开始改：

- [`docs/templates/WORKFLOW_PROMPTS.example.md`](docs/templates/WORKFLOW_PROMPTS.example.md)

一个实际 workflow 通常会把任务拆成 planning、documentation、implementation、review、verification 等节点。每个节点会生成独立 prompt，并由 `codex exec` 在对应 worktree 中执行。

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

## 当前范围

这个仓库仍然是一个 local-first MVP，已经覆盖：

- Meegle CLI 任务同步
- 固定规模 Agent pool
- 自动调度与生命周期管理
- Codex workflow execution
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

## 适用场景

AutoDev Agent 更适合内部工程自动化试点：你已经有稳定的 PM 任务来源，也希望 AI agent 在自己的仓库、自己的凭据和自己的本地环境中执行。它让团队先把“任务到代码执行”的流程标准化，再决定哪些部分需要走向更强的平台化。
