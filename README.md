# AutoDev Agent

AutoDev Agent 是一个本地运行的 AI 辅助编程智能体 MVP。系统从 Meegle 拉取任务，经过任务生命周期管理和 Orchestrator 调度后分配给预创建 Agent 池执行，并通过 Dashboard 展示任务、Agent 和执行日志。

## 技术栈

- Backend: NestJS、TypeORM、PostgreSQL、`@nestjs/schedule`
- Frontend: Vite、React、TypeScript
- Realtime: Server-Sent Events
- Workspace: npm workspaces

## 本地运行

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run dev:backend
npm run dev:frontend
```

默认端口：

- Backend: `http://localhost:3000/api`
- Frontend: `http://localhost:5173`
- PostgreSQL: `localhost:5432`

## 验证

```bash
npm run test
npm run build
docker compose config
```

## Docker

```bash
docker compose up --build
```

`docker-compose.yml` 包含 `postgres`、`backend`、`frontend` 三个服务。`backend` 依赖 PostgreSQL 健康检查，挂载 `/var/run/docker.sock` 以创建 Agent 容器；`frontend` 使用静态文件服务暴露 Vite build 产物。

运行真实 Agent 前，需要准备 `AGENT_IMAGE` 指向的镜像，镜像内应包含 `codex` CLI，并能执行 `sleep infinity`。如果镜像未准备好，后端仍会启动，但 Agent 会保持 `offline`。

## MVP 口径

- 调度以自动调度为主，`pending` 表示待校验。
- `repo`、`branch`、`instruction` 非空后任务才可进入调度。
- 校验失败标记 `failed` 并写入 `ExecutionLog`。
- `failed` 下次 sync 后字段有效可恢复为 `pending`。
- Agent 池固定最多 2 个，60 秒无心跳标记 `offline`。
- Agent 可调用 `POST /api/agents/:id/heartbeat` 刷新心跳；空闲 Agent 会在调度轮询时恢复心跳，避免池长期耗尽。
- Docker Agent 池通过 `DOCKER_BIN` 调用 Docker CLI，按 `AGENT_IMAGE` 创建/启动 `agent-1`、`agent-2` 等容器，并将 `CODEX_WORKDIR` 挂载到容器内 `/workspace`。
- Codex 执行命令由 `CODEX_CLI_BIN` 配置，默认 `codex`。
- CodexRunner 执行参数为 `codex exec --cwd <CODEX_WORKDIR>/<repo> --branch <branch> <instruction>`，默认超时由 `CODEX_TIMEOUT_MS` 控制。
- 数据库迁移随后端启动自动运行，也可通过 `npm run migration:run -w apps/backend` 手动执行。
- Meegle sync 会先执行 `meegle task list --status open` 获取 open 任务，再逐个执行 `meegle task get <id>` 拉取详情；支持数组、`tasks`、`items`、`data` 等 JSON 输出结构。
- Codex 执行完成后，系统会通过 `meegle comment add <externalId> <summary>` 回写成功或失败摘要；本阶段不自动创建 PR。
- 前端收到 SSE 事件后重新拉取任务、Agent 和 Dashboard 快照。
