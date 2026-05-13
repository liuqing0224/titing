drop index if exists tasks_external_id_uq;

create unique index if not exists tasks_source_external_id_uq
  on tasks (source, external_id)
  where external_id is not null;

create index if not exists tasks_status_executor_created_idx
  on tasks (status, executor, created_at desc);

create index if not exists tasks_trace_created_idx
  on tasks (trace_id, created_at asc);

create index if not exists tasks_executor_status_priority_created_idx
  on tasks (executor, status, priority, created_at asc);

create index if not exists task_transitions_task_created_idx
  on task_transitions (task_id, created_at asc);

create index if not exists task_transitions_trace_created_idx
  on task_transitions (trace_id, created_at asc);

create index if not exists executions_task_started_idx
  on executions (task_id, started_at desc);

create index if not exists executions_task_status_started_idx
  on executions (task_id, status, started_at desc);

create index if not exists execution_logs_task_created_idx
  on execution_logs (task_id, created_at asc);

create index if not exists execution_logs_execution_created_idx
  on execution_logs (execution_id, created_at asc)
  where execution_id is not null;

create index if not exists eval_results_task_created_idx
  on eval_results (task_id, created_at desc);

create index if not exists agents_status_executor_updated_idx
  on agents (status, executor, updated_at asc);

create index if not exists plugin_configs_kind_enabled_priority_idx
  on plugin_configs (kind, enabled, priority desc);
