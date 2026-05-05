# AutoDev Agent — 产品需求文档（PRD）

| 字段 | 内容 |
|------|------|
| **项目名称** | AutoDev Agent |
| **文档版本** | v2.0（生命周期管理 + 实时推送） |
| **日期** | 2026-04-30 初版 / 2026-05-03 v2 |
| **状态** | 已确认 |

---

## 17. 需求澄清补充（2026-05-05）

### 17.1 调度与生命周期

- MVP 以自动调度为主；`pending` 表示待校验/待确认。
- `pending` 自动转 `queued` 前必须校验 `repo`、`branch`、`instruction` 非空。
- 校验失败的任务标记为 `failed`，并写入 `ExecutionLog`。
- `claim` 一步完成认领和开始执行：写入 `claimedAt`、`startedAt`、`agentId`，状态进入 `running`。
- `start` 不作为 MVP 生命周期接口。
- `complete` / `fail` 不对 Agent 暴露，只由 Orchestrator 内部根据 Codex 进程或容器命令 exit code 调用。
- CodexRunner 调用 `CODEX_CLI_BIN`，执行参数为 `exec --cwd <CODEX_WORKDIR>/<repo> --branch <branch> <instruction>`；stdout/stderr/exit code 写入 `ExecutionLog.metadata`，超时按失败处理。
- Codex 执行完成后，Orchestrator 通过 `meegle comment add <externalId> <summary>` 回写成功或失败摘要；本阶段不自动创建 PR。

### 17.2 Sync 与重跑规则

- `POST /api/adapter/meegle/sync` 对重复 `external_id` 总是 upsert。
- Meegle sync 先调用 `meegle task list --status open` 获取 open 任务，再逐个调用 `meegle task get <id>` 拉取详情；CLI 输出按 JSON 解析，兼容数组、`tasks`、`items`、`data` 包装结构。
- `failed` 任务在后续 sync 后只要 `repo`、`branch`、`instruction` 有效，就恢复为 `pending`。
- `done` 任务仅当 `repo`、`branch`、`instruction` 变化时恢复为 `pending`；普通展示字段变化只更新展示。
- 任务恢复为 `pending` 时清空 `agentId`、`claimedAt`、`startedAt`、`completedAt`，保留 `ExecutionLog`。
- failed 任务在前端点击“重试”时进入 `queued`，保留 `retry_count` 和历史运行字段。

### 17.3 Agent 与重试

- Agent 池预创建，最大数量固定为 2。
- Agent 池通过 Docker CLI 创建/启动容器；容器名使用 `agent-<n>`，镜像由 `AGENT_IMAGE` 配置，`CODEX_WORKDIR` 挂载到容器内 `/workspace`。
- Agent 超过 60 秒无心跳标记为 `offline`，并推送 `agent.status`。
- Agent 通过 `POST /api/agents/:id/heartbeat` 刷新心跳；空闲 Agent 会在调度轮询中刷新心跳，避免预创建池在无任务时耗尽。
- running 任务遇到 Agent offline 时优先重启/恢复原 Agent，自动重试一次；再次失败才标记任务 `failed`。
- Task 表新增 `retry_count`，用于持久化重试次数。

### 17.4 前端交互

- Dashboard 展示统计卡片、Agent 概览、最近任务和“同步 Meegle”按钮。
- Tasks 页面展示完整任务摘要，支持 `status`、`priority` 筛选。
- `pending`、`queued`、`failed` 任务可编辑 `repo`、`branch`、`instruction`；保存后重新校验，通过则回到 `pending`，失败则 `failed`。
- ExecutionLog 使用 Modal 展示，按时间线展示 `status`、`message`、`createdAt`，`metadata` 默认折叠。
- 前端收到任意 `task.lifecycle` 或 `agent.status` SSE 事件后，重新拉取 `tasks`、`agents`、`dashboard stats`。
- MVP 暂不做 SSE heartbeat；重连成功后以前端重新拉取快照保证一致性。

---

## 1. 概述

AutoDev Agent 是一个可在本地运行的 AI 辅助编程智能体。系统从 Meegle 拉取任务，通过容器池调度 Codex Agent 执行编码，自动提交 PR 并回写飞书评论。系统提供前端 Dashboard 实时监控任务和 Agent 状态。

**v2 新增**：任务生命周期独立 API、实时 SSE 推送、Scheduler 定时轮询。

---

## 2. 需求背景

### 2.1 问题陈述

当前系统已完成基础 CRUD，但：
- 任务状态由 Orchestrator 内部隐式管理，外部无法干预
- 前端无实时更新，依赖用户手动刷新
- ExecutionLog 只写库，前端无法查看
- 任务拉取依赖手动触发，无定时同步

### 2.2 目标用户

- **开发者**：查看任务状态、触发同步
- **AI Agent（Codex）**：认领任务、执行编码、报告结果
- **系统运维**：监控 Agent 池健康状态

---

## 3. 目标与范围

### 3.1 目标

| 编号 | 目标 |
|------|------|
| G1 | 任务生命周期（pending → queued → running → done/failed）有独立 API，可外部调用 |
| G2 | 前端通过 SSE 实时接收任务状态变更，无需手动刷新 |
| G3 | 前端实时接收 Agent 上下线事件 |
| G4 | Orchestrator 自动定时轮询，无需手动触发 |
| G5 | 执行历史对前端可见（ExecutionLog API） |

### 3.2 非目标

| 编号 | 说明 |
|------|------|
| NG1 | 不做 GitHub 官方接入（仍用 PR 评论回写） |
| NG2 | 不做 Webhook 外部推送 |
| NG3 | 不做任务并行上限动态调整（固定上限 2） |
| NG4 | 不做任务详情页（前端的 task 列表无详情） |

### 3.3 MVP 做与不做

| MVP 做 | MVP 不做 |
|--------|---------|
| Meegle CLI 任务拉取 | GitHub 接入 |
| 单任务串行/并发（上限 2） | 多任务并行 > 2 |
| 手动触发同步 + 定时轮询 | Webhook 自动推送 |
| 飞书评论回写 | 外部状态回调 |
| 轻量 Dashboard | 任务详情页 |
| SSE 实时推送 | WebSocket 双工通信 |
| ExecutionLog 查看 | 日志实时流（stdout） |

---

## 4. 用户故事

| ID | 角色 | 故事 |
|----|------|------|
| US-1 | 开发者 | 我希望手动同步 Meegle 任务，以便在界面上看到最新任务 |
| US-2 | 开发者 | 我希望查看任务列表和状态筛选，不用刷新页面就能看到最新状态 |
| US-3 | 开发者 | 我希望查看 Agent 池状态，了解当前有多少 Agent 空闲 |
| US-4 | 开发者 | 我希望查看某个任务的执行历史，了解任务执行过程 |
| US-5 | Codex Agent | 我希望认领一个任务并报告执行结果，整个生命周期可追溯 |
| US-6 | 系统 | 希望定时轮询 Meegle，无需人工触发 |
| US-7 | 前端 | 希望任务状态变更时自动更新界面，不用用户操作 |

---

## 5. 功能架构

### 5.1 系统架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                         前端（Frontend）                         │
│   Dashboard  │  TasksView  │  AgentsView                         │
│   EventSource ──────────► 实时接收 task.lifecycle / agent.status │
└──────────────┬────────────────────┬────────────────────────────┘
               │  HTTP/REST          │  SSE（免鉴权）
               ▼                    ▼
┌──────────────────────────────────────────────────────────────┐
│                       后端（Backend NestJS）                   │
│                                                              │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌─────────────┐   │
│  │  Task   │  │  Agent   │  │Orchestrator│  │  Dashboard  │   │
│  │Module   │  │ Module   │  │  Module   │  │   Module    │   │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  └──────┬──────┘   │
│       │             │             │                │          │
│       └─────────────┴──────────────┴────────────────┘          │
│                           │                                    │
│                    ┌──────▼──────┐                             │
│                    │   Events    │  ◄── SSE 广播               │
│                    │   Module    │                             │
│                    └─────────────┘                             │
└───────────────────────────────────────────────────────────────┘
           │                                    │
           ▼                                    ▼
┌─────────────────────┐          ┌─────────────────────────────┐
│   PostgreSQL        │          │  Agent Pool（Docker 容器）   │
│  tasks              │          │  agent-1 / agent-2           │
│  agents             │          │  上限 2 个并发               │
│  execution_logs     │          └─────────────────────────────┘
└─────────────────────┘
```

### 5.2 模块职责

| 模块 | 职责 |
|------|------|
| TaskModule | 任务 CRUD + 生命周期 API + ExecutionLog 查询 |
| AgentModule | Agent 池管理（注册/注销/心跳） |
| OrchestratorModule | 轮询调度 + 状态转换 + CronJob |
| EventsModule | SSE 客户端管理 + 事件广播 |
| AdapterModule | Meegle CLI 适配 |
| ToolchainModule | Git 克隆 / Codex 执行 / PR 提交 / 评论回写 |
| DashboardModule | 聚合统计 |

---

## 6. 任务生命周期

### 6.1 状态机

```
                                    ┌──────────────┐
                                    │   pending    │  ◄── 任务创建
                                    └──────┬───────┘
                                           │ POST /tasks/:id/enqueue
                                           ▼
                                    ┌──────────────┐
                              ┌────►│   queued     │  ◄── 待 Agent 认领
                              │     └──────┬───────┘
                              │            │ POST /tasks/:id/claim
                              │            │ (X-Agent-Id header)
                              │            ▼
                              │     ┌──────────────┐
        ┌─────────────────────└     │   running    │
        │      POST /tasks/:id/fail  └──────┬───────┘
        │                                  │ POST /tasks/:id/start
        │                                  ▼
        │                           ┌──────────────┐
        │                           │   running    │  ◄── 执行中
        │     POST /tasks/:id/complete            │
        │                                  │     │
        ▼                                  ▼     ▼
  ┌──────────┐                        ┌──────────────┐
  │  failed  │                        │     done     │
  └──────────┘                        └──────────────┘
```

### 6.2 状态说明

| 状态 | 含义 | 可转换至 |
|------|------|---------|
| `pending` | 任务刚创建，等待加入队列 | `queued`（enqueue） |
| `queued` | 已加入执行队列，等待 Agent 认领 | `running`（claim） |
| `running` | Agent 正在执行 | `done`（complete）、`failed`（fail） |
| `done` | 成功完成 | 不可转换（终态） |
| `failed` | 执行失败 | 不可转换（终态） |

### 6.3 生命周期操作权限

| 操作 | 调用者 | 前置状态 | 后置状态 | 必填 Header |
|------|--------|---------|---------|-------------|
| enqueue | 任意 | pending | queued | — |
| claim | Agent | queued | running | `X-Agent-Id` |
| start | Agent | running | running | — |
| complete | Agent | running | done | — |
| fail | Agent | running | failed | — |

> **注意**：终态（done / failed）不允许任何生命周期操作，违者返回 400。

---

## 7. 实时推送（Server-Sent Events）

### 7.1 接入方式

- **端点**：`GET /api/events`
- **鉴权**：免鉴权（接入层直接放行，不校验 token）
- **CORS**：全开放（`origin: *`）
- **协议**：SSE（text/event-stream），HTTP 长连接

### 7.2 事件类型

| 事件名 | 触发时机 | Payload |
|--------|---------|---------|
| `task.lifecycle` | 任一生命周期操作（enqueue/claim/start/complete/fail） | `{taskId, status, agentId?, timestamp}` |
| `agent.status` | Agent 状态变更（idle ↔ running） | `{agentId, status, timestamp}` |

### 7.3 SSE 数据格式

```
event: task.lifecycle
data: {"taskId":"auto-001","status":"running","agentId":"agent-1","timestamp":"2026-05-03T09:00:00.000Z"}

event: agent.status
data: {"agentId":"agent-1","status":"idle","timestamp":"2026-05-03T09:05:00.000Z"}

```

### 7.4 前端接入示例

```typescript
// 连接 SSE（免鉴权）
const es = new EventSource('/api/events');

// 监听任务状态变更
es.addEventListener('task.lifecycle', (e) => {
  const { taskId, status, agentId, timestamp } = JSON.parse(e.data);
  updateTaskCard(taskId, status);
});

// 监听 Agent 上下线
es.addEventListener('agent.status', (e) => {
  const { agentId, status } = JSON.parse(e.data);
  updateAgentBadge(agentId, status);
});
```

---

## 8. API 规格

### 8.1 全局响应格式

```typescript
// 成功
{ "code": 0, "data": <T>, "message": "success" }

// 失败
{ "code": <number>, "data": null, "message": <string> }
```

### 8.2 Task API

#### GET /api/tasks

Query 参数：`status`（可选，pending/queued/running/done/failed）

#### GET /api/tasks/:id

#### POST /api/tasks

#### PATCH /api/tasks/:id

#### POST /api/tasks/:id/enqueue
- **说明**：将 `pending` → `queued`
- **调用者**：任意
- **返回**：更新后的 Task

#### POST /api/tasks/:id/claim
- **说明**：Agent 认领，`queued` → `running`，写入 `claimedAt` + `agentId`
- **调用者**：Agent
- **Header**：`X-Agent-Id: <agent-id>`（必填，缺省返回 400）
- **前置条件**：任务状态为 `queued`，违者 400
- **返回**：更新后的 Task

#### POST /api/tasks/:id/start
- **说明**：写入 `startedAt`，状态保持 `running`
- **前置条件**：任务状态为 `running`，违者 400
- **返回**：更新后的 Task

#### POST /api/tasks/:id/complete
- **说明**：`running` → `done`，写入 `completedAt`
- **前置条件**：任务状态为 `running`，违者 400
- **返回**：更新后的 Task

#### POST /api/tasks/:id/fail
- **说明**：`running` → `failed`，写入 `completedAt`
- **前置条件**：任务状态为 `running`，违者 400
- **返回**：更新后的 Task

#### GET /api/tasks/:id/logs
- **说明**：返回该任务的所有 ExecutionLog，按 `createdAt` 升序
- **返回**：`ExecutionLog[]`

### 8.3 Agent API

#### GET /api/agents
- **说明**：返回所有 Agent 状态

### 8.4 Dashboard API

#### GET /api/dashboard/stats
- **说明**：返回聚合统计 `{total, pending, queued, running, done, failed}`

### 8.5 Adapter API

#### POST /api/adapter/meegle/sync
- **说明**：从 Meegle CLI 拉取任务，存入数据库，状态默认 `pending`

#### GET /api/adapter/meegle/tasks
- **说明**：调试用，返回 Meegle CLI 原始输出

### 8.6 SSE 端点

#### GET /api/events
- **说明**：SSE 长连接，实时推送 `task.lifecycle` 和 `agent.status`
- **鉴权**：免鉴权

---

## 9. 数据库设计

### 9.1 ER 图

```
┌─────────────┐         ┌──────────────────┐
│    Task     │ 1 ─── N │  ExecutionLog    │
│             ├────────►│                  │
└─────────────┘         └──────────────────┘

┌─────────────┐         ┌─────────────┐
│    Agent    │ 1 ─── N │    Task     │
│             ├────────►│ (当前执行中)  │
└─────────────┘         └─────────────┘
```

### 9.2 tasks 表

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR | PK | 格式 `auto-<uuid>` |
| source | VARCHAR(20) | NOT NULL, DEFAULT 'meegle' | meegle / manual |
| external_id | VARCHAR(100) | UNIQUE, NULLABLE | Meegle 任务 ID |
| title | VARCHAR(500) | NOT NULL | |
| description | TEXT | | |
| repo | VARCHAR(200) | NOT NULL | |
| branch | VARCHAR(200) | NOT NULL, DEFAULT 'main' | |
| task_type | VARCHAR(20) | NOT NULL | feature / bug / chore / docs |
| priority | VARCHAR(20) | NOT NULL, DEFAULT 'medium' | low / medium / high |
| status | VARCHAR(20) | NOT NULL, DEFAULT 'pending' | pending / queued / running / done / failed |
| instruction | TEXT | | Codex 执行指令 |
| constraints | JSONB | DEFAULT '[]' | |
| claimed_at | TIMESTAMP | NULLABLE | v2 新增 |
| started_at | TIMESTAMP | NULLABLE | v2 新增 |
| completed_at | TIMESTAMP | NULLABLE | v2 新增 |
| agent_id | VARCHAR | NULLABLE | v2 新增，执行该任务的 Agent |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

> **Migration**：`apps/backend/src/database/migrations/1714406400001-task-lifecycle.ts`

### 9.3 agents 表

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR | PK | 格式 `agent-<uuid>` |
| task_id | VARCHAR | FK(tasks.id), NULLABLE | 当前执行的任务 |
| container_id | VARCHAR(100) | NULLABLE | Docker 容器 ID |
| container_name | VARCHAR(100) | NOT NULL | |
| status | VARCHAR(20) | NOT NULL, DEFAULT 'idle' | idle / running / offline |
| started_at | TIMESTAMP | NULLABLE | 容器启动时间 |
| heartbeat_at | TIMESTAMP | NOT NULL | 最近心跳时间 |
| created_at | TIMESTAMP | NOT NULL | |
| updated_at | TIMESTAMP | NOT NULL | |

### 9.4 execution_logs 表

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR | PK | 格式 `log-<uuid>` |
| task_id | VARCHAR | FK(tasks.id), NOT NULL | |
| agent_id | VARCHAR | NULLABLE | |
| status | VARCHAR(20) | NOT NULL | pending / queued / running / done / failed |
| message | TEXT | NOT NULL | 日志内容 |
| metadata | JSONB | NULLABLE | 扩展字段 |
| created_at | TIMESTAMP | NOT NULL | |

---

## 10. 前端设计

### 10.1 页面清单

| 路由 | 页面 | 说明 |
|------|------|------|
| `/` | Dashboard 首页 | 统计卡片 + 快捷操作 |
| `/tasks` | 任务列表 | 状态筛选 + 任务卡片 |
| `/agents` | Agent 状态 | 容器池状态 |

### 10.2 任务卡片状态色

| 状态 | 颜色 |
|------|------|
| pending | 灰 `#9CA3AF` |
| queued | 黄 `#F59E0B` |
| running | 蓝 `#3B82F6` |
| done | 绿 `#10B981` |
| failed | 红 `#EF4444` |

### 10.3 SSE 接入（前端）

前端在 App 初始化时建立 SSE 连接，缓存最新任务列表和 Agent 列表。收到事件后更新对应项，无需刷新页面。

---

## 11. Scheduler

- **驱动**：`@nestjs/schedule`
- **Cron 表达式**：`@Cron(CronExpression.EVERY_30_SECONDS)`
- **行为**：调用 `OrchestratorService.poll()`，扫描所有 `pending` + `queued` 任务，分配空闲 Agent 执行

---

## 12. Meegle 适配器

### 12.1 CLI 命令（已验证）

```bash
meegle auth status          # 登录状态检查
meegle task list --status open   # 拉取待处理任务
meegle task get <id>       # 任务详情
meegle comment add <id> "<text>"  # 回写评论
```

### 12.2 RawTask → Task 映射

| Meegle 字段 | → | Task 字段 | 说明 |
|------------|---|---------|------|
| id | → | externalId | Meegle 任务 ID |
| title | → | title | 直接映射 |
| description | → | description | 直接映射 |
| repo | → | repo | 无则默认 'TODO' |
| branch | → | branch | 无则默认 'main' |
| — | → | source | 固定为 'meegle' |
| — | → | status | 固定为 'pending' |
| — | → | taskType | 从 title 推断 |

---

## 13. Docker 配置

### 13.1 docker-compose 结构

| Service | 说明 | Port |
|---------|------|------|
| backend | NestJS API | 3000 |
| frontend | Vite 前端 | 5173 |
| postgres | PostgreSQL 15 | 5432 |
| agent-task-* | 按需动态启动 | — |

### 13.2 Agent 容器上限

- 最大并发 Agent 容器：**2 个**
- 超出上限的任务进入 `queued` 状态等待

---

## 14. 验收标准

### 14.1 核心功能

- [ ] `POST /api/adapter/meegle/sync` 拉取任务并入库，状态为 `pending`
- [ ] `GET /api/tasks` 返回任务列表，支持 `status` 筛选
- [ ] `GET /api/dashboard/stats` 返回正确聚合数据
- [ ] `GET /api/agents` 返回 Agent 池状态
- [ ] 并发上限 2，第 3 个任务进入 `queued`
- [ ] 任务完成后 Meegle 评论回写成功

### 14.2 生命周期 API

- [ ] `POST /api/tasks/:id/enqueue`：`pending` → `queued`
- [ ] `POST /api/tasks/:id/claim`（带 `X-Agent-Id`）：`queued` → `running`，写入 `claimedAt` + `agentId`
- [ ] `POST /api/tasks/:id/start`：写入 `startedAt`
- [ ] `POST /api/tasks/:id/complete`：`running` → `done`，写入 `completedAt`
- [ ] `POST /api/tasks/:id/fail`：`running` → `failed`，写入 `completedAt`
- [ ] 非法状态转换返回 400（如 `done` 后再 `claim`）
- [ ] `GET /api/tasks/:id/logs` 返回执行历史

### 14.3 SSE 实时推送

- [ ] `GET /api/events` 建立 SSE 连接（无 token）
- [ ] 生命周期操作触发 `task.lifecycle` 事件
- [ ] Agent 认领/释放触发 `agent.status` 事件

### 14.4 Scheduler

- [ ] Orchestrator 每 30 秒自动轮询
- [ ] 空闲 Agent < 2 时自动分配 `queued` 任务

### 14.5 质量

- [ ] `npm run build` 编译通过
- [ ] `npm run test` 全部测试通过
- [ ] 数据库迁移脚本可执行
- [ ] API 有完整的错误处理（400/404/500）
- [ ] `.env.example` 已提供

---

## 15. 风险与依赖

| 风险 | 影响 | 缓解 |
|------|------|------|
| Meegle CLI 命令变更 | 任务拉取失败 | 预留 CLI 输出解析容错 |
| Codex API 限流 | 任务执行慢/失败 | failed 状态 + 评论告警 |
| Docker 容器启动慢 | Agent 响应超时 | 重试一次，仍慢则 failed |
| SSE 连接数上限 | 大量前端实例时 | 建议单页应用唯一连接 |
| 数据库 migration 并发 | 多实例同时 migrate | 建议单次部署先 migrate |

---

## 16. 术语表

| 术语 | 说明 |
|------|------|
| Task | 一个编码任务，对应 Meegle 里的一个 story/issue |
| Agent | 运行在 Docker 容器中的 Codex 执行环境 |
| Orchestrator | 任务调度器，负责分配 Agent 和驱动执行流程 |
| ExecutionLog | 任务执行步骤记录 |
| SSE | Server-Sent Events，服务器推送技术 |
| Meegle | 团队协作平台（任务来源） |

---