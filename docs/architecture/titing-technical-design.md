# Titing Technical Design

## Overview

Titing is an AI engineering execution controller. It controls task lifecycle, state transitions, scheduling, Goal Loop execution, observability, and governance. It does not directly execute coding tools or infrastructure steps. Those capabilities are delegated to plugins.

## Runtime Layers

### Host Layer

- Fastify HTTP server
- SSE event stream
- Configuration bootstrap
- Migration runner startup
- Optional Fastify routes registered by plugins through a host-specific route extension (registerRoutes hook on the plugin object)

### Controller Core

- Domain models
- Task state machine
- Scheduler
- Goal Loop
- Governance checks
- Application services

### Plugin Runtime

- Host entry createResolvedPlugins merges built-in groups with optional per-kind external packages; external package wins the whole kind slot when configured. Default merge order: log, task-integration, environment, execution (two built-in runners when not overridden), quality, observability-governance.
- Task integration plugins
- Execution plugins
- Environment plugins
- Quality plugins
- Observability and governance plugins
- Log plugins: append, lookup by task/trace, subscription for SSE

Current runtime behavior and constraints:

- PluginRuntime supports multiple plugins of the same kind in memory and selects implementations by enabled flag, effective priority, and execution capability matching.
- The host-side external plugin loader does not yet expose a true "many external plugins per kind" model. External registration is currently "whole-kind replacement by one plugin factory result".
- Because of that replacement model, execution is the most constrained kind: configuring one external execution package removes both built-in runners and collapses the kind to a single external implementation.
- Host bootstrap depends on a log plugin during startup to back SSE and execution log adapters, so log is operationally required even though selection happens through the same generic runtime.
- Plugin configuration currently influences enable/disable and effective priority; arbitrary config payload is passed into init but is not yet a fully modeled dynamic runtime configuration channel.

Current architecture gaps:

- External plugin loading validates only the base RuntimePlugin shape during bootstrap. Kind-specific required methods are not yet asserted up front, so some invalid plugins can fail late when first exercised by the scheduler.
- The current source field on tasks doubles as both business origin and task-integration plugin identifier for result reporting and needs-human reply sync. This couples persisted task provenance to plugin instance identity more tightly than desired.
- Readiness semantics are narrower than the real execution chain: environment, execution, and observability-governance are required for green readiness, but log remains a de facto runtime dependency and task-integration/quality can still materially affect business completeness.

### Persistence

- SQLite via bundled node:sqlite binding; default file .titing/sqlite/titing.sqlite, overridable via env DATABASE_FILE
- SQL migrations
- Repository adapters in the server app (class names keep historical Pg prefix; storage is SQLite)

## State Model

Normal states:

- created
- validated
- pending
- queued
- running
- evaluating
- repairing
- done

Exceptional states:

- failed
- needs_human
- blocked
- cancelled

Transitions are only legal through the state machine. Every transition emits a structured event and execution log entry with from, to, reason, operator, and traceId.

## Plugin Categories

### TaskIntegrationPlugin

- Pull tasks from external systems
- Convert remote fields to TitingTask
- Report results back

### ExecutionPlugin

- Prepare executor-specific input
- Resolve WORKFLOW_PROMPTS.md workflow definitions
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

- Command policy (allow prefixes / block patterns), output size and diff limits
- Secret scanning and redaction hooks around executor invocations
- Optional afterEval for post-evaluation policy

### LogPlugin

- Append structured LogEntry lines to the repository-root logs/ tree
- Back GET /api/events (SSE snapshot + subscription), task log APIs, and trace aggregation reads

## Plugin Resolution Model

Titing separates plugin concerns into three layers:

- Contract layer: `packages/plugin-api` defines stable runtime interfaces and domain payloads.
- Selection layer: `packages/core` owns enable/disable filtering, priority ordering, and capability-based selection.
- Host assembly layer: `apps/server` constructs the concrete plugin list from built-in groups plus optional external replacements.

This separation keeps the controller core framework-free, but it also means the host assembly rules are part of the architecture, not an implementation detail. In the current design, the host decides:

- which plugin kinds are mandatory for bootstrap
- whether built-in and external implementations can coexist
- how much validation must happen before a plugin becomes selectable
- whether plugin identity is stable enough to be referenced from persisted task data

Future evolution should preserve the contract/selection split while relaxing the current whole-kind replacement rule and strengthening bootstrap-time validation.

## Workflow Prompt System

Execution plugins treat WORKFLOW_PROMPTS.md as a first-class control input.

Lookup order:

- knowledge/WORKFLOW_PROMPTS.md
- WORKFLOW_PROMPTS.md

Supported workflow semantics:

- parse default node order from the workflow section
- parse node-local prompt templates from ### <Node> sections
- parse node-local loopEnabled / maxLoops configuration
- render variables from task and workspace context
- execute workflow nodes sequentially within one execution session

Failure semantics:

- missing or invalid WORKFLOW_PROMPTS.md fails the task before quality evaluation
- node-local workflow loops stay inside a single execution
- controller-level repairing remains an execution-to-execution loop and is not replaced by workflow loops

## Data Model

### tasks

- id
- source
- external_id
- title
- instruction
- repo
- branch
- priority
- status
- executor
- trace_id
- constraints_json
- acceptance_criteria_json
- metadata_json
- retry_count
- repair_count
- created_at
- updated_at
- started_at
- completed_at

### executions

- id
- task_id
- agent_id
- workspace
- status
- summary
- executor
- started_at
- ended_at

### execution_logs

- id
- task_id
- execution_id
- event_type
- message
- data_json
- created_at

### agents

- id
- status
- task_id
- executor
- labels_json
- last_heartbeat_at
- created_at
- updated_at

### repair_goals

- id
- task_id
- objective
- constraints_json
- done_when_json
- status
- iteration
- max_iterations
- last_failure_hash
- created_at
- updated_at

### eval_results

- id
- task_id
- execution_id
- passed
- score
- risk_level
- report_json
- created_at

### plugin_configs

- id
- plugin_id
- kind
- enabled
- priority
- config_json
- updated_at

## API Surface

- GET /api/health
- GET /api/tasks
- POST /api/tasks
- GET /api/tasks/:id
- POST /api/tasks/:id/validate
- POST /api/tasks/:id/queue
- POST /api/tasks/:id/retry
- POST /api/tasks/:id/cancel
- GET /api/tasks/:id/executions
- GET /api/tasks/:id/eval-results
- GET /api/tasks/:id/repair-goal
- GET /api/agents
- GET /api/plugins
- GET /api/dashboard
- GET /api/events

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

- Core code (packages/core) remains framework-free.
- Fastify only owns transport; HTTP routes owned by integrations are wired through HttpRoutePlugin from the plugin list.
- SQLite access lives in the server package behind DatabaseClient.
- Plugin implementations load at bootstrap via createResolvedPlugins, which composes built-ins and optional external createPlugin modules; no filesystem plugin discovery beyond configured package names.
