alter table tasks add column source_identity text;
alter table tasks add column integration_key text;

create index if not exists tasks_source_identity_idx
  on tasks (source_identity);

create index if not exists tasks_integration_key_idx
  on tasks (integration_key);
