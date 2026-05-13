create table if not exists agent_leases (
  id text primary key,
  agent_id text not null references agents(id) on delete cascade,
  task_id text not null references tasks(id) on delete cascade,
  execution_id text references executions(id) on delete set null,
  leased_at text not null,
  lease_expires_at text not null,
  released_at text,
  release_reason text,
  candidate_agents_json text not null default '{"schemaVersion":"2026-05-11","data":[]}',
  selection_reason text not null,
  priority_snapshot_json text not null default '{"schemaVersion":"2026-05-11","data":{}}'
);

create index if not exists agent_leases_task_leased_idx
  on agent_leases (task_id, leased_at desc);

create index if not exists agent_leases_agent_active_idx
  on agent_leases (agent_id, released_at);

create table if not exists human_reviews (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  execution_id text references executions(id) on delete set null,
  request_type text not null,
  reason text not null,
  external_thread_ref text,
  response_summary text,
  status text not null,
  created_at text not null,
  updated_at text not null
);

create index if not exists human_reviews_task_created_idx
  on human_reviews (task_id, created_at desc);
