# Titing API

更新日期：2026-05-12

本文档描述当前 Fastify 服务端对外暴露的 HTTP API。默认基准地址（Base URL）：

```text
http://localhost:3000/api
```

通用约定：

- 所有请求和响应均为 JSON，除 SSE 端点外。
- 任务相关聚合响应会带 schemaVersion 字段，取值与运行中服务发布的观测模式版本一致。
- 失败响应统一为含 error 字段的 JSON 对象。
- 运行时日志现统一写入仓库根目录 logs/；/api/events、/api/tasks/:id/logs 等接口已改为读取文件日志插件，而不是 execution_logs 数据库表。

## Health

### GET /health

进程存活检查。

示例响应：

```json
{
  "ok": true,
  "status": "alive",
  "schemaVersion": "2026-05-11",
  "service": "titing",
  "timestamp": "2026-05-11T09:00:00.000Z"
}
```

### GET /readiness

服务就绪检查，聚合数据库与插件健康状态。

示例响应：

```json
{
  "ok": true,
  "status": "ready",
  "schemaVersion": "2026-05-11",
  "service": "titing",
  "timestamp": "2026-05-11T09:00:00.000Z",
  "checks": {
    "database": {
      "ok": true,
      "message": "Database connection is ready"
    },
    "plugins": {
      "ok": true,
      "message": "Required plugin kinds are ready",
      "total": 7,
      "healthy": 7,
      "requiredKinds": {
        "environment": true,
        "execution": true,
        "observability-governance": true
      },
      "items": []
    }
  }
}
```

说明：total / healthy 统计 **全部** 注册插件；内置栈共 7 个（root-logs、meegle、git-worktree-local、codex、cursor、default-quality、default-observability-governance）。requiredKinds 仅检查 environment、execution、observability-governance 三类是否各自存在 **健康** 插件。

## Tasks

### GET /tasks

按条件查询任务。

查询参数（Query）：

- status
- executor

### POST /tasks

创建手工任务。

请求体：

```json
{
  "title": "Fix build",
  "instruction": "Run build and fix errors",
  "repo": "https://example.com/repo.git",
  "branch": "main",
  "priority": "medium",
  "executor": "codex",
  "source": "manual",
  "externalId": "EXT-1",
  "constraints": ["do not force push"],
  "acceptanceCriteria": ["build passes"],
  "metadata": {
    "env": {
      "NODE_ENV": "test"
    }
  }
}
```

说明：

- branch 可选；省略、空字符串或仅空白时，系统会按当前服务进程时区生成 feature/YYYYMMDDHHmmss-<taskId前8位>。

必填字段：

- title
- instruction
- repo

### GET /tasks/:id

查询单个任务详情。

### POST /tasks/:id/validate

把任务推进到 validated。

### POST /tasks/:id/queue

把任务推进到 queued。

### POST /tasks/:id/retry

触发重试，通常用于 failed 或需要再次入队的任务。

### POST /tasks/:id/block

把任务置为 blocked。

请求体：

```json
{
  "reason": "Waiting for dependency owner"
}
```

### POST /tasks/:id/needs-human

把任务置为 needs_human。

自动进入 needs_human 的行为现在受环境变量 TITING_GOAL_ENABLE_NEEDS_HUMAN_LOOP 控制：

- false：自动 Goal Loop 在命中 high_risk / repeated_failure / no_effective_diff 等 stop signal 时继续 repair，并写 goal.stop_reason_continued；达到迭代上限后写 goal.budget_exhausted 并以 failed 结束。
- true：当任务来源插件支持人工回复闭环时，以上 stop signal 会自动转入 needs_human，并通过 integration 回写评论；后续收到用户评论回复后会自动恢复执行链。

请求体：

```json
{
  "reason": "High risk change requires review"
}
```

### POST /tasks/:id/recover

从 blocked / needs_human / failed 等人工恢复回执行链。

说明：

- needs_human 通常表示等待人工补充信息、审批或评论回复。
- blocked 通常表示自动重试已经停止，需要人工修复环境、依赖、配置或执行条件。

请求体：

```json
{
  "reason": "Dependency fixed"
}
```

### POST /tasks/:id/cancel

取消任务。

## Task Observability

### GET /tasks/:id/executions

查询任务 execution 列表。

### GET /tasks/:id/transitions

查询任务状态流转历史。

### GET /tasks/:id/logs

查询任务 execution logs。

说明：

- 当前返回结构保持兼容，但底层数据源来自 logs/tasks/<task-id>/task.log 等文件日志，而不是数据库 execution_logs 表。

### GET /tasks/:id/observability

查询聚合观测视图。

返回内容包括：

- schemaVersion
- task
- transitions
- executions
- executionLogs
- evalResults
- repairGoal

### GET /tasks/:id/eval-results

查询评测结果列表。

### GET /tasks/:id/repair-goal

查询当前 repair goal。

### GET /traces/:traceId

按 trace 维度聚合查询。

返回内容包括：

- tasks
- transitions
- executions
- executionLogs
- evalResults
- repairGoals

说明：

- executionLogs 字段当前由 logs/traces/<traceId>/trace.log 和 task 级文件日志聚合得到。

## Agents

### GET /agents

查询全部 agent。

### POST /agents/:id/heartbeat

刷新 agent heartbeat。

请求体：

```json
{
  "status": "idle"
}
```

### POST /agents/:id/disable

人工摘除 agent。

### POST /agents/:id/enable

重新启用 agent。

### POST /agents/:id/recover

把 agent 从异常态恢复。

## Plugins

### GET /plugins

查询运行中插件和健康状态。

### GET /plugin-configs

查询插件配置覆盖。

### POST /plugin-configs

更新或插入插件配置。

请求体：

```json
{
  "pluginId": "meegle",
  "kind": "task-integration",
  "enabled": true,
  "priority": 100,
  "config": {
    "mode": "poll"
  }
}
```

## Integrations

### GET /integrations/meegle/health

查看 Meegle integration readiness。

### POST /integrations/meegle/webhook

Meegle webhook 任务接入。

请求头：

```text
x-titing-webhook-secret: <secret>
```

请求体：

```json
{
  "task": {
    "id": "MEEGLE-1",
    "title": "Fix build",
    "instruction": "Run build and fix errors",
    "repo": "https://example.com/repo.git",
    "branch": "main",
    "executor": "codex"
  }
}
```

也支持：

```json
{
  "tasks": []
}
```

## Dashboard And Debug

### GET /dashboard

返回任务、agent、plugin 聚合统计。

### POST /debug/sync

手工触发 integration sync。

### POST /debug/scheduler

手工触发一次 scheduler dispatch。

## SSE

### GET /events

SSE 事件流端点。

说明：

- SSE 实时事件现在由文件日志插件维护的最近事件快照与订阅流提供。
- 事件仍保持原有 payload shape，但不再依赖内存事件流作为唯一数据源。

事件格式：

```text
event: <eventType>
data: <json>
```

事件 JSON 含：

- id
- schemaVersion
- eventType
- timestamp
- data.correlation
