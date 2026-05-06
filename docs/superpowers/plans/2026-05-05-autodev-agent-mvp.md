# AutoDev Agent MVP Implementation Plan

> **Note:** This plan file is kept as historical implementation context. Runtime task execution should follow the target repository root `agent.md` workflow instead of any superpowers-based process.

**Goal:** 从 `pm/prd.md` 落地 AutoDev Agent MVP：Meegle 同步、任务生命周期、预创建 Agent 池、Orchestrator 调度、SSE 实时推送、ExecutionLog 查看和轻量 Dashboard。

**Architecture:** 当前工作区只有 PRD，因此按 greenfield monorepo 初始化。后端使用 NestJS 拆分 `TaskModule`、`AgentModule`、`AdapterModule`、`OrchestratorModule`、`EventsModule`、`DashboardModule`；前端使用 Vite React，通过 REST 拉取快照，通过 `EventSource` 触发全量刷新。

**Tech Stack:** Node.js、npm workspaces、NestJS、TypeORM、PostgreSQL、`@nestjs/schedule`、React、Vite、TypeScript、Docker Compose、Jest。

---

## 已确认需求口径

- 自动调度为主；`pending` 表示待校验/待确认。
- `pending` 自动转 `queued` 前校验 `repo`、`branch`、`instruction` 非空。
- 校验失败标记 `failed`，写 `ExecutionLog`。
- `failed` 下次 sync 后字段有效可恢复为 `pending`；`done` 仅当 `repo`、`branch`、`instruction` 变化时恢复为 `pending`。
- 恢复到 `pending` 时清空 `agentId`、`claimedAt`、`startedAt`、`completedAt`，保留 `ExecutionLog`。
- `claim` 一步写入 `claimedAt`、`startedAt`、`agentId` 并进入 `running`；`start` 不作为 MVP 生命周期接口。
- Agent 池预创建最多 2 个 Agent；超过 60 秒无心跳标记 `offline`。
- running 任务遇到 Agent offline 时优先重启/恢复原 Agent 并自动重试一次；再次失败才标记 `failed`。
- Task 新增 `retry_count`。
- `complete/fail` 仅由 Orchestrator 内部调用；Orchestrator 等待 Codex 进程/容器 exit code 判定结果。
- `ExecutionLog` 保存完整 stdout/stderr，MVP 不限制大小。
- 前端收到任意 SSE 事件后重新拉取 `tasks`、`agents`、`dashboard stats`。

---

## 文件结构

- Create: `package.json`，根 workspace 脚本。
- Create: `tsconfig.base.json`，共享 TypeScript 配置。
- Create: `.env.example`，前后端和数据库环境变量。
- Create: `docker-compose.yml`，`backend`、`frontend`、`postgres` 服务。
- Create: `apps/backend/**`，NestJS 后端。
- Create: `apps/frontend/**`，Vite React 前端。
- Create: `apps/backend/src/database/migrations/1714406400001-task-lifecycle.ts`，初始表结构迁移。
- Create: `apps/backend/src/tasks/**`，任务实体、DTO、服务、Controller、测试。
- Create: `apps/backend/src/agents/**`，Agent 实体、服务、Controller、心跳与离线判定。
- Create: `apps/backend/src/execution-logs/**`，ExecutionLog 实体与查询。
- Create: `apps/backend/src/adapter/**`，Meegle CLI sync。
- Create: `apps/backend/src/orchestrator/**`，Scheduler、调度和 Codex 执行。
- Create: `apps/backend/src/events/**`，SSE 广播。
- Create: `apps/backend/src/dashboard/**`，统计 API。
- Create: `apps/frontend/src/api/**`，REST 客户端与 SSE 客户端。
- Create: `apps/frontend/src/pages/**`，`DashboardPage`、`TasksPage`、`AgentsPage`。
- Create: `apps/frontend/src/components/**`，任务卡片、日志 Modal、Agent 卡片、统计卡片。

---

## Task 1: 初始化 Monorepo

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `docker-compose.yml`
- Create: `apps/backend/package.json`
- Create: `apps/frontend/package.json`

- [ ] **Step 1: 创建 npm workspace**

根 `package.json`：

```json
{
  "name": "autodev-agent",
  "private": true,
  "workspaces": ["apps/backend", "apps/frontend"],
  "scripts": {
    "build": "npm run build -w apps/backend && npm run build -w apps/frontend",
    "test": "npm run test -w apps/backend && npm run test -w apps/frontend",
    "dev:backend": "npm run start:dev -w apps/backend",
    "dev:frontend": "npm run dev -w apps/frontend"
  }
}
```

- [ ] **Step 2: 定义环境变量样例**

`.env.example`：

```bash
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=autodev
DATABASE_PASSWORD=autodev
DATABASE_NAME=autodev
BACKEND_PORT=3000
VITE_API_BASE_URL=http://localhost:3000/api
AGENT_POOL_SIZE=2
AGENT_HEARTBEAT_TIMEOUT_SECONDS=60
MEEGLE_CLI_BIN=meegle
```

- [ ] **Step 3: 安装依赖**

Run:

```bash
npm install
npm install -w apps/backend @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/config @nestjs/schedule @nestjs/typeorm typeorm pg rxjs reflect-metadata class-validator class-transformer
npm install -D -w apps/backend @nestjs/cli @nestjs/testing typescript ts-jest jest supertest @types/jest @types/supertest
npm install -w apps/frontend @vitejs/plugin-react vite react react-dom
npm install -D -w apps/frontend typescript vitest @testing-library/react @testing-library/jest-dom @types/react @types/react-dom
```

Expected: `package-lock.json` 生成，`npm run build` 暂时可能失败，因为源码尚未创建。

---

## Task 2: 后端基础应用与数据库实体

**Files:**
- Create: `apps/backend/src/main.ts`
- Create: `apps/backend/src/app.module.ts`
- Create: `apps/backend/src/database/database.module.ts`
- Create: `apps/backend/src/tasks/task.entity.ts`
- Create: `apps/backend/src/agents/agent.entity.ts`
- Create: `apps/backend/src/execution-logs/execution-log.entity.ts`
- Create: `apps/backend/src/database/migrations/1714406400001-task-lifecycle.ts`

- [ ] **Step 1: 定义实体字段**

`Task` 必须包含：`id`、`source`、`externalId`、`title`、`description`、`repo`、`branch`、`taskType`、`priority`、`status`、`instruction`、`constraints`、`retryCount`、`claimedAt`、`startedAt`、`completedAt`、`agentId`、`createdAt`、`updatedAt`。

`Agent` 必须包含：`id`、`taskId`、`containerId`、`containerName`、`status`、`startedAt`、`heartbeatAt`、`createdAt`、`updatedAt`。

`ExecutionLog` 必须包含：`id`、`taskId`、`agentId`、`status`、`message`、`metadata`、`createdAt`。

- [ ] **Step 2: 写迁移**

迁移创建 `tasks`、`agents`、`execution_logs` 三张表；`tasks.external_id` 建唯一索引；`tasks.retry_count` 默认 `0`。

- [ ] **Step 3: 验证**

Run:

```bash
npm run build -w apps/backend
```

Expected: TypeScript 编译通过。

---

## Task 3: Task 生命周期服务

**Files:**
- Create: `apps/backend/src/tasks/task-status.ts`
- Create: `apps/backend/src/tasks/task.service.ts`
- Create: `apps/backend/src/tasks/task.controller.ts`
- Create: `apps/backend/src/tasks/dto/update-task.dto.ts`
- Create: `apps/backend/src/tasks/task.service.spec.ts`

- [ ] **Step 1: 写生命周期测试**

覆盖：

- `enqueue`: `pending -> queued`
- `claim`: `queued -> running`，写 `agentId`、`claimedAt`、`startedAt`
- 非法状态转换返回业务错误
- `done/failed` 终态通过普通生命周期接口不可再转换
- 编辑 `pending/queued/failed` 的 `repo/branch/instruction` 后重新校验

- [ ] **Step 2: 实现核心方法**

`TaskService` 暴露：

```typescript
listTasks(query: { status?: string; priority?: string }): Promise<Task[]>
getTask(id: string): Promise<Task>
enqueue(id: string): Promise<Task>
claim(id: string, agentId: string): Promise<Task>
updateExecutionFields(id: string, input: { repo?: string; branch?: string; instruction?: string }): Promise<Task>
markFailedInternal(id: string, message: string, metadata?: Record<string, unknown>): Promise<Task>
markDoneInternal(id: string, metadata?: Record<string, unknown>): Promise<Task>
resetForRerun(id: string, targetStatus: 'pending' | 'queued', resetRetryCount: boolean): Promise<Task>
```

- [ ] **Step 3: 实现 API**

公开接口：

- `GET /api/tasks?status=&priority=`
- `GET /api/tasks/:id`
- `PATCH /api/tasks/:id`
- `POST /api/tasks/:id/enqueue`
- `POST /api/tasks/:id/claim`
- `POST /api/tasks/:id/retry`
- `GET /api/tasks/:id/logs`

不公开 `start`、`complete`、`fail` 给 Agent。

- [ ] **Step 4: 运行测试**

Run:

```bash
npm run test -w apps/backend -- task.service.spec.ts
```

Expected: Task 生命周期测试通过。

---

## Task 4: ExecutionLog 查询与写入

**Files:**
- Create: `apps/backend/src/execution-logs/execution-log.service.ts`
- Create: `apps/backend/src/execution-logs/execution-log.controller.ts`
- Create: `apps/backend/src/execution-logs/execution-log.service.spec.ts`

- [ ] **Step 1: 写日志测试**

覆盖：

- 按 `createdAt ASC` 返回某任务全部日志
- `metadata` 可保存完整 `stdout` / `stderr` / `exitCode`
- 日志不做大小限制

- [ ] **Step 2: 实现服务**

`ExecutionLogService` 提供：

```typescript
append(input: {
  taskId: string;
  agentId?: string | null;
  status: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<ExecutionLog>
listByTask(taskId: string): Promise<ExecutionLog[]>
```

- [ ] **Step 3: 接入 TaskService**

所有状态变化和校验失败都追加 `ExecutionLog`。

---

## Task 5: Meegle Sync 与 Upsert 规则

**Files:**
- Create: `apps/backend/src/adapter/meegle.adapter.ts`
- Create: `apps/backend/src/adapter/adapter.controller.ts`
- Create: `apps/backend/src/adapter/task-mapper.ts`
- Create: `apps/backend/src/adapter/adapter.service.spec.ts`

- [ ] **Step 1: 写 sync 测试**

覆盖：

- 新任务创建为 `pending` 或字段缺失时 `failed`
- 重复 `externalId` 总是 upsert 基础字段
- `failed` 字段有效后恢复为 `pending`
- `done` 仅当 `repo`、`branch`、`instruction` 变化时恢复为 `pending`
- 恢复时清空运行态字段，保留历史日志
- 返回 `summary + items`

- [ ] **Step 2: 定义返回结构**

```typescript
type SyncResult = {
  summary: {
    created: number;
    updated: number;
    failed: number;
    recovered: number;
    resetToPending: number;
  };
  items: Array<{
    externalId: string;
    taskId?: string;
    action: 'created' | 'updated' | 'failed' | 'recovered' | 'resetToPending';
    reason: string;
  }>;
};
```

- [ ] **Step 3: 实现 CLI 调用**

使用 `MEEGLE_CLI_BIN` 执行：

```bash
meegle task list --status open
meegle task get <id>
```

MVP 中 CLI 解析失败时，sync 接口返回失败响应并记录后端日志，不创建脏数据。

---

## Task 6: Agent 池、心跳与离线判定

**Files:**
- Create: `apps/backend/src/agents/agent.service.ts`
- Create: `apps/backend/src/agents/agent.controller.ts`
- Create: `apps/backend/src/agents/agent.service.spec.ts`

- [ ] **Step 1: 写 Agent 服务测试**

覆盖：

- 启动时预创建最多 2 个 Agent 记录
- `GET /api/agents` 返回完整运行信息
- 超过 60 秒无心跳标记 `offline`
- 状态变化触发 `agent.status` 事件

- [ ] **Step 2: 实现服务**

`AgentService` 提供：

```typescript
ensurePool(size: number): Promise<void>
listAgents(): Promise<Agent[]>
findIdleAgent(): Promise<Agent | null>
markRunning(agentId: string, taskId: string): Promise<Agent>
markIdle(agentId: string): Promise<Agent>
markOffline(agentId: string): Promise<Agent>
refreshHeartbeat(agentId: string): Promise<Agent>
detectOfflineAgents(timeoutSeconds: number): Promise<Agent[]>
```

---

## Task 7: Orchestrator 调度与 Codex 执行

**Files:**
- Create: `apps/backend/src/orchestrator/orchestrator.service.ts`
- Create: `apps/backend/src/orchestrator/orchestrator.module.ts`
- Create: `apps/backend/src/orchestrator/codex-runner.ts`
- Create: `apps/backend/src/orchestrator/orchestrator.service.spec.ts`

- [ ] **Step 1: 写调度测试**

覆盖：

- 每轮扫描 `pending + queued`
- `pending` 校验通过后转 `queued`
- 调度顺序为 `priority high > medium > low`，同优先级按 `createdAt ASC`
- 只分配给 `idle` Agent，最多并发 2
- Codex exit code `0` 标记 `done`
- Codex exit code 非 `0` 标记 `failed`
- Agent offline 时原 Agent 优先重启/恢复，任务自动重试一次；第二次失败标记 `failed`

- [ ] **Step 2: 实现 Cron**

使用：

```typescript
@Cron(CronExpression.EVERY_30_SECONDS)
async poll(): Promise<void>
```

- [ ] **Step 3: 实现 CodexRunner**

`CodexRunner` 负责启动 Codex/容器命令并返回：

```typescript
type CodexRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
```

Orchestrator 将完整 `stdout/stderr/exitCode` 写入 `ExecutionLog.metadata`。

---

## Task 8: SSE Events

**Files:**
- Create: `apps/backend/src/events/events.service.ts`
- Create: `apps/backend/src/events/events.controller.ts`
- Create: `apps/backend/src/events/events.service.spec.ts`

- [ ] **Step 1: 写事件测试**

覆盖：

- `GET /api/events` 返回 `text/event-stream`
- 生命周期变化推送 `task.lifecycle`
- Agent 状态变化推送 `agent.status`
- MVP 不实现 heartbeat

- [ ] **Step 2: 实现事件服务**

事件 payload：

```typescript
type TaskLifecycleEvent = {
  taskId: string;
  status: string;
  agentId?: string | null;
  timestamp: string;
};

type AgentStatusEvent = {
  agentId: string;
  status: string;
  timestamp: string;
};
```

---

## Task 9: Dashboard API

**Files:**
- Create: `apps/backend/src/dashboard/dashboard.service.ts`
- Create: `apps/backend/src/dashboard/dashboard.controller.ts`
- Create: `apps/backend/src/dashboard/dashboard.service.spec.ts`

- [ ] **Step 1: 写统计测试**

覆盖 `total`、`pending`、`queued`、`running`、`done`、`failed` 聚合。

- [ ] **Step 2: 实现接口**

`GET /api/dashboard/stats` 返回：

```json
{
  "total": 0,
  "pending": 0,
  "queued": 0,
  "running": 0,
  "done": 0,
  "failed": 0
}
```

---

## Task 10: 前端 API Client 与实时刷新

**Files:**
- Create: `apps/frontend/src/api/client.ts`
- Create: `apps/frontend/src/api/tasks.ts`
- Create: `apps/frontend/src/api/agents.ts`
- Create: `apps/frontend/src/api/dashboard.ts`
- Create: `apps/frontend/src/api/events.ts`

- [ ] **Step 1: 实现 REST client**

统一解析全局响应：

```typescript
type ApiResponse<T> = {
  code: number;
  data: T;
  message: string;
};
```

- [ ] **Step 2: 实现 SSE client**

收到任意 `task.lifecycle` 或 `agent.status` 后调用页面传入的 `refreshAll()`，重新拉取 `tasks`、`agents`、`dashboard stats`。

---

## Task 11: 前端页面与组件

**Files:**
- Create: `apps/frontend/src/App.tsx`
- Create: `apps/frontend/src/pages/DashboardPage.tsx`
- Create: `apps/frontend/src/pages/TasksPage.tsx`
- Create: `apps/frontend/src/pages/AgentsPage.tsx`
- Create: `apps/frontend/src/components/TaskCard.tsx`
- Create: `apps/frontend/src/components/ExecutionLogModal.tsx`
- Create: `apps/frontend/src/components/AgentCard.tsx`
- Create: `apps/frontend/src/components/StatsCards.tsx`

- [ ] **Step 1: Dashboard**

展示统计卡片、Agent 概览、最近任务、同步 Meegle 按钮。同步按钮 loading，完成后 toast 展示 `created/updated/failed/recovered/resetToPending` 摘要并刷新数据。

- [ ] **Step 2: Tasks**

任务卡片展示：`title`、`description` 摘要、`repo`、`branch`、`externalId`、`status`、`priority`、`taskType`、`agentId`、`retryCount`、`updatedAt`。

筛选：`status`、`priority`。

操作：

- 查看日志：打开 `ExecutionLogModal`
- 编辑执行字段：仅 `pending/queued/failed` 可编辑 `repo/branch/instruction`
- failed 重试：调用 `POST /api/tasks/:id/retry`

- [ ] **Step 3: Agents**

只读展示：`agentId`、`status`、`containerName`、`containerId`、`taskId`、`startedAt`、`heartbeatAt`、`updatedAt`。

- [ ] **Step 4: 日志 Modal**

按时间线展示每条 `ExecutionLog` 的 `status`、`message`、`createdAt`；`metadata` 默认折叠。

---

## Task 12: Docker、验收与文档同步

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `pm/prd.md`
- Create: `README.md`

- [ ] **Step 1: 完成 Docker Compose**

服务：

- `postgres:15`
- `backend`，端口 `3000`
- `frontend`，端口 `5173`

- [ ] **Step 2: 更新 PRD**

把本次澄清结论补入 `pm/prd.md`：

- 自动调度主路径
- sync upsert / 恢复规则
- retry_count
- Agent offline 规则
- 前端页面交互
- `complete/fail` 内部化
- `start` 从 MVP 生命周期接口移除

- [ ] **Step 3: 写 README**

包含：

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run dev:backend
npm run dev:frontend
npm run test
npm run build
```

- [ ] **Step 4: 全量验证**

Run:

```bash
npm run build
npm run test
docker compose config
```

Expected:

- 后端编译通过
- 前端编译通过
- 单元测试通过
- Docker Compose 配置有效

---

## 自检

- PRD 核心目标 G1-G5 都有对应任务。
- 已覆盖生命周期、SSE、Scheduler、ExecutionLog、Meegle sync、Agent 池、Dashboard 和前端页面。
- 已把澄清过的需求差异纳入计划：`start` 移除、`complete/fail` 内部化、`retry_count`、sync 恢复规则、前端全量刷新。
- 当前仓库为空工程，因此计划从 monorepo 初始化开始，不依赖既有代码结构。
