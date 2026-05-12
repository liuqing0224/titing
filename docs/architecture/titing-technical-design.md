# Titing Technical Design

## Overview

Titing is an AI engineering execution controller. It controls task lifecycle, state transitions, scheduling, Goal Loop execution, observability, and governance. It does not directly execute coding tools or infrastructure steps. Those capabilities are delegated to plugins.

## Runtime Layers

### Host Layer

- Fastify HTTP server
- SSE event stream
- Configuration bootstrap
- Migration runner startup

### Controller Core

- Domain models
- Task state machine
- Scheduler
- Goal Loop
- Governance checks
- Application services

### Plugin Runtime

- Task integration plugins
- Execution plugins
- Environment plugins
- Quality plugins
- Observability and governance plugins

### Persistence

- SQLite
- SQL migrations
- Repository adapters

## State Model

Normal states:

- `created`
- `validated`
- `pending`
- `queued`
- `running`
- `evaluating`
- `repairing`
- `done`

Exceptional states:

- `failed`
- `needs_human`
- `blocked`
- `cancelled`

Transitions are only legal through the state machine. Every transition emits a structured event and execution log entry with `from`, `to`, `reason`, `operator`, and `traceId`.

## Plugin Categories

### TaskIntegrationPlugin

- Pull tasks from external systems
- Convert remote fields to `TitingTask`
- Report results back

### ExecutionPlugin

- Prepare executor-specific input
- Execute a task or continue a session
- Capture stdout, stderr, exit code, session metadata

### EnvironmentPlugin

- Clone/fetch repository
- Prepare worktree
- Inject environment
- Clean workspace and manage artifacts

### QualityPlugin

- Run lint, typecheck, tests, build
- Produce risk and acceptance results

### ObservabilityGovernancePlugin

- Record structured events
- Export health signals
- Enforce command policy, redaction, secret scanning, and risk blocking

## Data Model

### tasks

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
- `created_at`
- `updated_at`
- `started_at`
- `completed_at`

### executions

- `id`
- `task_id`
- `agent_id`
- `workspace`
- `status`
- `summary`
- `executor`
- `started_at`
- `ended_at`

### execution_logs

- `id`
- `task_id`
- `execution_id`
- `event_type`
- `message`
- `data_json`
- `created_at`

### agents

- `id`
- `status`
- `task_id`
- `executor`
- `labels_json`
- `last_heartbeat_at`
- `created_at`
- `updated_at`

### repair_goals

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

### eval_results

- `id`
- `task_id`
- `execution_id`
- `passed`
- `score`
- `risk_level`
- `report_json`
- `created_at`

### plugin_configs

- `id`
- `plugin_id`
- `kind`
- `enabled`
- `priority`
- `config_json`
- `updated_at`

## API Surface

- `GET /api/health`
- `GET /api/tasks`
- `POST /api/tasks`
- `GET /api/tasks/:id`
- `POST /api/tasks/:id/validate`
- `POST /api/tasks/:id/queue`
- `POST /api/tasks/:id/retry`
- `POST /api/tasks/:id/cancel`
- `GET /api/tasks/:id/executions`
- `GET /api/tasks/:id/eval-results`
- `GET /api/tasks/:id/repair-goal`
- `GET /api/agents`
- `GET /api/plugins`
- `GET /api/dashboard`
- `GET /api/events`

## Goal Loop

The controller executes:

1. run execution plugin
2. if quality plugin is enabled, run quality plugin
3. if eval passes, or quality is disabled and execution succeeds, mark done
4. if eval fails, or quality is disabled and execution is non-retryably unsuccessful, create or update repair goal
5. re-run execution with repair context
6. repeat until success or stop condition

Stop conditions:

- all eval checks pass
- max repair iterations reached
- repeated identical failures
- no effective diff twice in a row
- risk policy blocks further execution
- task requires human intervention

## Implementation Notes

- Core code must remain framework-free.
- Fastify only owns transport.
- SQLite access lives in the server package.
- Plugin implementations are internal classes registered at bootstrap time.
