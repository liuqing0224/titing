# AutoDev Agent

AutoDev Agent 是一个 local-first 的 AI engineering orchestration system，用于把结构化产品任务转成可执行的研发工作流。
It is a local-first AI engineering orchestration system that turns structured product tasks into executable engineering workflows.

它把 task intake、agent scheduling、code execution、progress visibility 和 result feedback 串成一个统一控制面。
Instead of manually copying requirements into an AI tool and tracking progress across multiple systems, you can let AutoDev Agent pull tasks from Meegle, dispatch them to pre-created agents, execute workflow-driven coding steps, and surface status in a live dashboard.

## Why AutoDev Agent

- 把产品任务直接转成 runnable engineering jobs
- 用 task status、agent health 和 execution logs 保持过程可观测
- 用 workflow-driven prompt system 替代一次性手工 prompting
- 基于你自己的 repositories、Docker agents 和 Codex CLI 本地运行
- 保持 Meegle 作为 upstream source of truth，同时让工程执行自动化

## Core Capabilities

- **Task sync from Meegle**
  从 Meegle CLI 拉取 open tasks，标准化字段并 upsert 到本地系统。
- **Configurable auto-sync**
  按固定间隔执行 Meegle sync，持久化同步间隔，并支持在 dashboard 中动态更新，无需重启服务。
- **Workflow-based execution**
  使用 repository-level `WORKFLOW_PROMPTS.md` 定义任务如何经过 planning、documentation、implementation、review 和 verification。
- **Pre-created Docker agent pool**
  预创建一组可复用的 Docker agents，而不是每次任务执行都从零启动环境。
- **Orchestrated task lifecycle**
  让任务在 `pending -> queued -> running -> done/failed` 间流转，并带上 validation、retry 和 agent ownership tracking。
- **Live dashboard**
  在浏览器 UI 中查看任务总览、最近活动、agent capacity、失败任务和 sync 控制项。
- **Execution logs**
  通过结构化 stdout、stderr、stage 和 context metadata 查看完整执行历史。
- **Result feedback to Meegle**
  把成功或失败摘要回写到原始 Meegle work item。

## How It Works

```text
Meegle -> Backend Sync -> Task Store -> Orchestrator -> Docker Agent -> Codex CLI
   ^                                                                |
   |                                                                v
   +--------------------- Comment Back / Status ---------------- Dashboard
```

High-level flow:

1. Meegle tasks 被同步到本地数据库。
2. 带有有效 execution fields 的任务变成 runnable。
3. Orchestrator 选择任务并分配给 idle agents。
4. Agents 按仓库内的 `WORKFLOW_PROMPTS.md` 执行 workflow。
5. Execution logs 和状态变更通过 realtime stream 推送到前端。
6. Final summaries 回写到 Meegle。

## Architecture

### Backend

- NestJS
- TypeORM
- PostgreSQL
- `@nestjs/schedule`
- Server-Sent Events 用于 realtime updates

### Frontend

- React
- Vite
- TypeScript

### Runtime

- Docker-based agent pool
- Codex CLI execution
- npm workspaces monorepo

## Key Behaviors

- Tasks 在进入 scheduling 前会先校验。
- 缺少 `repo` 或 `instruction` 会导致任务校验失败，并写入 execution log。
- Failed tasks 在后续 sync 中如果 execution fields 恢复有效，可重新回到 `pending`。
- Done tasks 在 execution-critical fields 变化时会重置为 `pending`。
- Agent pool 大小由配置固定控制。
- Offline agents 通过 heartbeat timeout 检测。
- Backend 可触发 Meegle login，并通知 frontend 在 host browser 中打开登录页。

## Repository Layout

```text
apps/
  backend/     NestJS API, scheduler, orchestrator, adapter, database
  frontend/    React dashboard
docs/
  templates/   Reusable workflow prompt templates
pm/
  prd.md       Product requirement reference
```

## Quick Start

### 1. Install dependencies

```bash
npm install
cp .env.example .env
```

安装依赖并初始化环境变量。  
Install dependencies and bootstrap your local environment.

### 2. Start PostgreSQL

```bash
docker compose up -d postgres
```

先启动数据库。  
Start the database first.

### 3. Start backend and frontend

```bash
npm run dev:backend
npm run dev:frontend
```

分别启动后端和前端开发服务。  
Run backend and frontend in separate dev processes.

### Default addresses

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3000/api`
- PostgreSQL: `localhost:5432`

## Run With Docker

```bash
docker compose up -d --build
```

Services included:

- `postgres`
- `backend`
- `frontend`

`backend` 会挂载 `/var/run/docker.sock`，以便创建和管理 agent containers。  
The backend mounts `/var/run/docker.sock` so it can create and manage agent containers.

## Validation

```bash
npm test
npm run build
docker compose config
```

## Required Runtime Assumptions

- `AGENT_IMAGE` points to an image that contains the `codex` CLI and can stay alive as an agent container.
- Repositories executed by AutoDev Agent should provide `AGENTS.md`.
- Workflow-driven repositories should provide `knowledge/WORKFLOW_PROMPTS.md` or `WORKFLOW_PROMPTS.md`.
- Meegle CLI must be available where sync/login operations run.

如果 `AGENT_IMAGE` 尚未准备好，backend 依然可以启动，但 agents 会保持 `offline`。  
If the agent image is not ready, the backend can still start, but agents will remain `offline`.

## Configuration

### Common environment variables

- `BACKEND_PORT`
- `DATABASE_HOST`
- `DATABASE_PORT`
- `DATABASE_USER`
- `DATABASE_PASSWORD`
- `DATABASE_NAME`
- `AGENT_POOL_SIZE`
- `AGENT_HEARTBEAT_TIMEOUT_SECONDS`
- `AGENT_IMAGE`
- `DOCKER_BIN`
- `CODEX_CLI_BIN`
- `CODEX_WORKDIR`
- `CODEX_TIMEOUT_MS`

### Meegle

- `MEEGLE_CLI_BIN`
- `MEEGLE_SYNC_ENABLED`
- `MEEGLE_SYNC_INTERVAL_MINUTES`
- `MEEGLE_PROJECT_KEY`
- `MEEGLE_QUERY_MQL`
- `MEEGLE_DETAIL_FIELDS`

Notes:

- Auto-sync 默认开启。
- Sync interval 可以在 dashboard 中更新，并会持久化保存。
- 当 Meegle 需要认证时，frontend 会在收到 backend SSE event 后，在 host browser 中打开登录链接。

## Workflow Prompt System

AutoDev Agent 不会硬编码你的项目 workflow。
Instead, each target repository can define its own node-based execution flow through `WORKFLOW_PROMPTS.md`.

可以从这个通用模板开始：

- [docs/templates/WORKFLOW_PROMPTS.example.md](/Users/l/Documents/work/code/demo/autoDevAgent/docs/templates/WORKFLOW_PROMPTS.example.md)

这个模板刻意保持抽象。
Replace the node names, skills, output paths, and execution rules with your own project workflow.

## Best Fit

如果你想做下面这些事，AutoDev Agent 会比较适合：
AutoDev Agent is a strong fit if you want to:

- connect PM tasks to engineering execution
- run AI coding flows against real repositories
- keep a small internal agent pool instead of using a fully hosted platform
- standardize how AI agents plan, implement, review, and document work

## Current Scope

当前仓库仍然定位为一个 practical local-first MVP：

- automatic scheduling
- fixed-size agent pool
- Meegle integration through CLI
- realtime dashboard
- workflow-driven Codex execution

它的目标不是一次性做成大而全的平台，而是先把“任务接入、Agent 调度、AI 执行、结果回写、过程可观测”这条链路真正跑通。
It is designed to be useful now, while still leaving room to evolve into a more general internal engineering automation platform.
