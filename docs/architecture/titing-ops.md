# Titing Ops Guide

更新日期：2026-05-11

## 启动检查

- 先看 `GET /api/health`，确认进程存活。
- 再看 `GET /api/readiness`，确认 database 与 required plugin kinds 都 ready。
- 如果只某个集成异常，单独看对应健康端点，例如 `GET /api/integrations/meegle/health`。

## 启动日志建议

启动期至少记录：

- 监听端口
- SQLite 文件路径
- migration 执行结果
- 已注册插件与健康状态
- scheduler interval 和 seed agent 数

建议把以下场景打成明确 error 日志：

- 数据库连接失败
- migration 失败
- webhook secret 缺失
- 必需插件种类不健康

## 指标与告警建议

当前仓库尚未内建 metrics exporter，但上线时建议至少接入这些指标：

- `tasks_total{status=...}`
- `executions_total{status=...,executor=...}`
- `scheduler_tick_duration_ms`
- `scheduler_dispatch_count`
- `agent_total{status=...}`
- `plugin_health{plugin_id=...,healthy=...}`
- `eval_risk_total{risk_level=...}`
- `goal_stop_reason_total{reason=...}`

建议告警：

1. `/api/readiness` 持续非 200 超过 5 分钟。
2. `offline` agent 数量持续大于 0。
3. `needs_human` 或 `blocked` 任务数量持续增长。
4. 高频出现 `repair_budget_exhausted` 或 `high_risk_eval`。
5. SQLite 文件所在磁盘容量低于阈值。

## 失败任务诊断

服务端提供一个本地诊断脚本：

```bash
npm run diagnose:task -w apps/server -- --task-id <task-id>
```

也支持按外部任务号诊断：

```bash
npm run diagnose:task -w apps/server -- --external-id <external-id> --source meegle
```

输出内容包括：

- 任务当前状态、traceId、retry/repair 计数
- 最近一次 execution 摘要
- 最近一次 eval 的失败 checks 与 risk level
- 当前 repair goal 和迭代次数
- 最近状态流转与最近 execution logs
- 推断的 stop reason，例如 `repair_budget_exhausted`、`high_risk_eval`

如需结构化输出，附加 `--json`：

```bash
npm run diagnose:task -w apps/server -- --task-id <task-id> --json
```

## 常见排障顺序

1. `health` 正常但 `readiness` 降级：先看数据库连接和 plugin health。
2. 任务卡在 `queued`：看 agent 是否都 `offline / disabled`，以及 scheduler 是否被跳过。
3. 任务卡在 `needs_human`：运行 `diagnose:task`，重点看失败 checks、risk level 和 repair goal。
4. 外部任务未进系统：看 integration health，再检查 `source + externalId` 是否已存在。
5. Webhook 没生效：检查 `GET /api/integrations/meegle/health`，确认 mode 为 `webhook` 且 secret configured。

## 数据修复手册

操作前建议：

1. 停掉 server 进程。
2. 备份 `DATABASE_FILE`。
3. 明确要修复的是任务状态、plugin config 还是 legacy 数据。

常用操作：

### 重新跑 schema 迁移

```bash
npm run migration:run -w apps/server
```

### 执行旧表迁移

```bash
npm run migration:legacy -w apps/server
```

### 诊断单个任务

```bash
npm run diagnose:task -w apps/server -- --task-id <task-id> --json
```

### 手工恢复任务

如果任务已进入 `blocked` 或 `needs_human`，优先用业务 API 恢复，而不是直接改库：

```bash
curl -X POST http://localhost:3000/api/tasks/<task-id>/recover \
  -H 'content-type: application/json' \
  -d '{"reason":"manual recovery"}'
```

### 手工恢复 agent

```bash
curl -X POST http://localhost:3000/api/agents/<agent-id>/recover
```

## 回滚手册

当前回滚以文件级备份恢复为主。

推荐步骤：

1. 停掉服务。
2. 备份当前故障库文件。
3. 用最近一次可用备份覆盖 `DATABASE_FILE`。
4. 如有需要，同时恢复 `.titing/repos` 和保留的 artifacts。
5. 启动服务并校验 `/api/health`、`/api/readiness`、`/api/dashboard`。

如果是版本升级后回滚：

1. 恢复旧代码版本。
2. 恢复升级前的 SQLite 备份。
3. 启动旧版本服务。

不建议直接手工回退已执行 migration 的单个 SQL 变更，当前更安全的方式仍是文件备份回滚。
