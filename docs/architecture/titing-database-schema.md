# Titing 数据库 Schema

更新日期：2026-05-11

当前服务端使用 SQLite，默认数据库文件：

```text
.titing/sqlite/titing.sqlite
```

迁移入口：

```bash
npm run migration:run -w apps/server
```

当前 schema 由以下迁移文件维护：

- [001_initial.sql](/Users/l/Documents/work/code/demo/autoDevAgent/apps/server/src/titing/migrations/001_initial.sql:1)
- [002_indexes_and_external_id_scope.sql](/Users/l/Documents/work/code/demo/autoDevAgent/apps/server/src/titing/migrations/002_indexes_and_external_id_scope.sql:1)
- [003_json_schema_envelopes.sql](/Users/l/Documents/work/code/demo/autoDevAgent/apps/server/src/titing/migrations/003_json_schema_envelopes.sql:1)

## 表说明

### `schema_migrations`

记录已执行 migration。

字段：

- `id`
- `applied_at`

### `tasks`

任务主表。

关键字段：

- `id`
- `source`
- `external_id`
- `title`
- `instruction`
- `repo`
- `branch`
- `priority`
- `status`
- `executor`
- `trace_id`
- `constraints_json`
- `acceptance_criteria_json`
- `metadata_json`
- `retry_count`
- `repair_count`
- `started_at`
- `completed_at`
- `created_at`
- `updated_at`

约束：

- 主键 `id`
- `(source, external_id)` 唯一，且 `external_id is not null`

### `task_transitions`

任务状态流转审计表。

关键字段：

- `id`
- `task_id`
- `trace_id`
- `from_status`
- `to_status`
- `reason`
- `operator`
- `created_at`

### `executions`

任务执行记录。

关键字段：

- `id`
- `task_id`
- `agent_id`
- `workspace`
- `status`
- `summary`
- `executor`
- `started_at`
- `ended_at`

说明：

- `summary` 仍保留在执行主记录中，用于快速展示最近执行结果。
- 详细 stdout / stderr / summary 原始日志不再作为数据库日志持久化来源，而是统一写入根目录 `logs/`。

### `execution_logs`

历史上的执行日志和结构化事件记录表。

关键字段：

- `id`
- `task_id`
- `execution_id`
- `event_type`
- `message`
- `data_json`
- `created_at`

当前状态：

- 该表和相关索引仍保留在 schema 中，以兼容已有数据库与历史迁移。
- 新版本运行时不再向该表写入日志。
- 任务日志、trace 日志、SSE 初始快照与执行器输出已统一迁移到根目录 `logs/` 文件体系。

### `agents`

执行 agent 状态表。

关键字段：

- `id`
- `status`
- `task_id`
- `executor`
- `labels_json`
- `last_heartbeat_at`
- `created_at`
- `updated_at`

### `repair_goals`

Goal Loop 修复目标表。

关键字段：

- `id`
- `task_id`
- `objective`
- `constraints_json`
- `done_when_json`
- `status`
- `iteration`
- `max_iterations`
- `last_failure_hash`
- `created_at`
- `updated_at`

约束：

- `task_id` 唯一

### `eval_results`

质量评测结果表。

关键字段：

- `id`
- `task_id`
- `execution_id`
- `passed`
- `score`
- `risk_level`
- `report_json`
- `created_at`

说明：

- `passed` 在 SQLite 中以 `integer` 形式存储，由 repository 层映射为 boolean

### `plugin_configs`

插件运行时覆盖配置。

关键字段：

- `id`
- `plugin_id`
- `kind`
- `enabled`
- `priority`
- `config_json`
- `updated_at`

## JSON Envelope 约定

以下字段统一使用 `{ schemaVersion, data }` envelope 存储：

- `tasks.constraints_json`
- `tasks.acceptance_criteria_json`
- `tasks.metadata_json`
- `agents.labels_json`
- `repair_goals.constraints_json`
- `repair_goals.done_when_json`
- `eval_results.report_json`
- `plugin_configs.config_json`

补充说明：

- `execution_logs.data_json` 仍是旧表定义的一部分，但当前文件日志方案不再依赖该字段作为主数据源。

示例：

```json
{
  "schemaVersion": "2026-05-11",
  "data": {
    "env": {
      "NODE_ENV": "test"
    }
  }
}
```

读取策略：

- repository 兼容历史裸数组和裸对象
- 新写入统一写 envelope

## 索引

热点索引包括：

- `tasks_source_external_id_uq`
- `tasks_status_executor_created_idx`
- `tasks_trace_created_idx`
- `tasks_executor_status_priority_created_idx`
- `task_transitions_task_created_idx`
- `task_transitions_trace_created_idx`
- `executions_task_started_idx`
- `executions_task_status_started_idx`
- `execution_logs_task_created_idx`
- `execution_logs_execution_created_idx`
- `eval_results_task_created_idx`
- `agents_status_executor_updated_idx`
- `plugin_configs_kind_enabled_priority_idx`

## 旧表迁移

如果本地还残留旧 NestJS/TypeORM 表结构，可执行：

```bash
npm run migration:legacy -w apps/server
```

该脚本会：

1. 识别旧 `tasks / agents / execution_logs` 表形状。
2. 重命名为 `legacy_*`。
3. 运行当前 SQLite migrations。
4. 回填到新 schema。
