# Titing 本地开发与联调指南

更新日期：2026-05-11

## 环境要求

- Node.js
- npm
- git
- SQLite
- `codex` 或 Cursor CLI `agent`

说明：

- SQLite 使用 Node 内置 `node:sqlite`，无需额外安装数据库服务。
- 若仅做 API/前端联调，可先不接入真实外部任务源。

## 安装依赖

```bash
npm install
```

## 启动后端

```bash
npm run dev:backend
```

默认监听：

```text
http://localhost:3000
```

数据库默认文件：

```text
.titing/sqlite/titing.sqlite
```

## 启动前端

```bash
npm run dev:frontend
```

默认访问：

```text
http://localhost:5173
```

## 常用本地命令

```bash
npm run build
npm test
npm run migration:run -w apps/server
npm run migration:legacy -w apps/server
npm run smoke:sqlite -w apps/server
npm run diagnose:task -w apps/server -- --task-id <task-id>
```

## 手工联调一条任务

### 1. 创建任务

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H 'content-type: application/json' \
  -d '{
    "title": "Fix build",
    "instruction": "Run build and fix errors",
    "repo": "https://example.com/repo.git",
    "branch": "main",
    "executor": "codex"
  }'
```

### 2. 推进入队

```bash
curl -X POST http://localhost:3000/api/tasks/<task-id>/validate
curl -X POST http://localhost:3000/api/tasks/<task-id>/queue
```

### 3. 观察状态

```bash
curl http://localhost:3000/api/tasks/<task-id>
curl http://localhost:3000/api/tasks/<task-id>/observability
curl http://localhost:3000/api/traces/<trace-id>
```

## Meegle 文件型联调

适用于不接真实 webhook 时的本地模拟。

设置环境变量：

```bash
export TITING_PLUGIN_MEEGLE_MODE=polling
export TITING_PLUGIN_MEEGLE_TASKS_FILE=$PWD/.titing/meegle/tasks.json
export TITING_PLUGIN_MEEGLE_RESULTS_FILE=$PWD/.titing/meegle/results.json
```

准备任务文件：

```json
{
  "tasks": [
    {
      "id": "MEEGLE-1",
      "title": "Fix build",
      "instruction": "Run build and fix errors",
      "repo": "https://example.com/repo.git",
      "branch": "main",
      "executor": "codex"
    }
  ]
}
```

手工触发同步：

```bash
curl -X POST http://localhost:3000/api/debug/sync
```

## Meegle Webhook 联调

设置：

```bash
export TITING_PLUGIN_MEEGLE_MODE=webhook
export TITING_PLUGIN_MEEGLE_WEBHOOK_SECRET=secret-1
```

发送 webhook：

```bash
curl -X POST http://localhost:3000/api/integrations/meegle/webhook \
  -H 'content-type: application/json' \
  -H 'x-titing-webhook-secret: secret-1' \
  -d '{
    "task": {
      "id": "MEEGLE-2",
      "title": "Webhook task",
      "instruction": "Fix from webhook",
      "repo": "https://example.com/repo.git",
      "branch": "main",
      "executor": "codex"
    }
  }'
```

## 前后端联调检查项

建议顺序：

1. `GET /api/health`
2. `GET /api/readiness`
3. `GET /api/dashboard`
4. `GET /api/plugins`
5. `GET /api/agents`
6. 创建任务并观察详情页与 SSE

## 常见问题

### SQLite 文件被占用

- 检查是否有另一个后端实例指向同一 `DATABASE_FILE`
- 默认已启用 `busy_timeout` 和 WAL，但不建议多个开发实例长期共享同一文件

### 任务一直 `queued`

- 看 `/api/agents` 是否都 `offline` 或 `disabled`
- 看 `/api/readiness` 是否有必需插件不健康

### 任务进入 `needs_human`

- 运行 `diagnose:task`
- 看 eval risk、repair goal、最近 logs

