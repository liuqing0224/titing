create table if not exists tasks (
  id text primary key,
  source text not null,
  external_id text,
  title text not null,
  instruction text not null,
  repo text not null,
  branch text not null,
  priority text not null,
  status text not null,
  executor text not null,
  trace_id text not null,
  constraints_json text not null default '{"schemaVersion":"2026-05-11","data":[]}',
  acceptance_criteria_json text not null default '{"schemaVersion":"2026-05-11","data":[]}',
  metadata_json text not null default '{"schemaVersion":"2026-05-11","data":{}}',
  retry_count integer not null default 0,
  repair_count integer not null default 0,
  started_at text,
  completed_at text,
  created_at text not null,
  updated_at text not null
);

create unique index if not exists tasks_external_id_uq on tasks (external_id) where external_id is not null;

create table if not exists task_transitions (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  trace_id text not null,
  from_status text not null,
  to_status text not null,
  reason text not null,
  operator text not null,
  created_at text not null
);

create table if not exists executions (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  agent_id text,
  workspace text not null,
  status text not null,
  summary text,
  executor text not null,
  started_at text not null,
  ended_at text
);

create table if not exists execution_logs (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  execution_id text references executions(id) on delete set null,
  event_type text not null,
  message text not null,
  data_json text not null default '{"schemaVersion":"2026-05-11","data":{}}',
  created_at text not null
);

create table if not exists agents (
  id text primary key,
  status text not null,
  task_id text,
  executor text not null,
  labels_json text not null default '{"schemaVersion":"2026-05-11","data":[]}',
  last_heartbeat_at text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists repair_goals (
  id text primary key,
  task_id text not null unique references tasks(id) on delete cascade,
  objective text not null,
  constraints_json text not null default '{"schemaVersion":"2026-05-11","data":[]}',
  done_when_json text not null default '{"schemaVersion":"2026-05-11","data":[]}',
  status text not null,
  iteration integer not null,
  max_iterations integer not null,
  last_failure_hash text,
  created_at text not null,
  updated_at text not null
);

create table if not exists eval_results (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  execution_id text not null references executions(id) on delete cascade,
  passed integer not null,
  score integer not null,
  risk_level text not null,
  report_json text not null default '{"schemaVersion":"2026-05-11","data":{}}',
  created_at text not null
);

create table if not exists plugin_configs (
  id text primary key,
  plugin_id text not null unique,
  kind text not null,
  enabled integer not null default 1,
  priority integer not null default 0,
  config_json text not null default '{"schemaVersion":"2026-05-11","data":{}}',
  updated_at text not null
);
