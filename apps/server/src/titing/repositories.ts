import {
  AgentRecord,
  AgentLease,
  AgentLeaseRepository,
  AgentRepository,
  EvalResult,
  EvalResultRepository,
  ExecutionLogRecord,
  ExecutionLogRepository,
  ExecutionRecord,
  ExecutionRepository,
  HumanReview,
  HumanReviewRepository,
  PluginConfig,
  PluginConfigRepository,
  RepairGoal,
  RepairGoalRepository,
  TaskListQuery,
  TaskRepository,
  TaskTransition,
  TaskTransitionRepository,
  TitingTask
} from "@titing/plugin-api";
import { randomUUID } from "node:crypto";
import { DatabaseClient } from "./database";

/**
 * SQLite 上的仓储实现：SQL 与类型名保留 `Pg*` 前缀以对齐 `@titing/plugin-api` 契约与既有迁移。
 * JSON 列通过带 `schemaVersion` 的信封读写，便于演进（见 `encodeJsonObject` / `decodeJsonObject`）。
 */
const JSON_SCHEMA_VERSION = "2026-05-11";

export class PgTaskRepository implements TaskRepository {
  constructor(private readonly pool: DatabaseClient) {}

  async create(task: TitingTask): Promise<void> {
    await this.save(task);
  }

  async save(task: TitingTask): Promise<void> {
    await this.pool.query(
      `insert into tasks (
        id, source, external_id, title, instruction, repo, branch, priority, status, executor, trace_id,
        source_identity, integration_key, constraints_json, acceptance_criteria_json, metadata_json,
        retry_count, repair_count, started_at, completed_at, created_at, updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
      )
      on conflict (id) do update set
        source = excluded.source,
        external_id = excluded.external_id,
        title = excluded.title,
        instruction = excluded.instruction,
        repo = excluded.repo,
        branch = excluded.branch,
        priority = excluded.priority,
        status = excluded.status,
        executor = excluded.executor,
        trace_id = excluded.trace_id,
        source_identity = excluded.source_identity,
        integration_key = excluded.integration_key,
        constraints_json = excluded.constraints_json,
        acceptance_criteria_json = excluded.acceptance_criteria_json,
        metadata_json = excluded.metadata_json,
        retry_count = excluded.retry_count,
        repair_count = excluded.repair_count,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at`,
      [
        task.id,
        task.source,
        task.externalId,
        task.title,
        task.instruction,
        task.repo,
        task.branch,
        task.priority,
        task.status,
        task.executor,
        task.traceId,
        task.sourceIdentity ?? null,
        task.integrationKey ?? null,
        JSON.stringify(encodeJsonArray(task.constraints)),
        JSON.stringify(encodeJsonArray(task.acceptanceCriteria)),
        JSON.stringify(encodeJsonObject(task.metadata)),
        task.retryCount,
        task.repairCount,
        task.startedAt,
        task.completedAt,
        task.createdAt,
        task.updatedAt
      ]
    );
  }

  async getById(id: string): Promise<TitingTask | null> {
    const result = await this.pool.query("select * from tasks where id = $1", [id]);
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async getByExternalId(source: string, externalId: string): Promise<TitingTask | null> {
    const result = await this.pool.query(
      "select * from tasks where source = $1 and external_id = $2 limit 1",
      [source, externalId]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async listByTraceId(traceId: string): Promise<TitingTask[]> {
    const result = await this.pool.query("select * from tasks where trace_id = $1 order by created_at asc", [traceId]);
    return result.rows.map(mapTask);
  }

  async list(query: TaskListQuery = {}): Promise<TitingTask[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query.status) {
      values.push(query.status);
      clauses.push(`status = $${values.length}`);
    }
    if (query.executor) {
      values.push(query.executor);
      clauses.push(`executor = $${values.length}`);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const result = await this.pool.query(`select * from tasks ${where} order by created_at desc`, values);
    return result.rows.map(mapTask);
  }

  async claimQueued(id: string, startedAt: Date): Promise<TitingTask | null> {
    const result = await this.pool.query(
      `update tasks
       set status = 'running',
           started_at = coalesce(started_at, $2),
           updated_at = $2
       where id = $1 and status = 'queued'
       returning *`,
      [id, startedAt]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }
}

export class PgTaskTransitionRepository implements TaskTransitionRepository {
  constructor(private readonly pool: DatabaseClient) {}

  async append(transition: TaskTransition): Promise<void> {
    await this.pool.query(
      `insert into task_transitions (id, task_id, trace_id, from_status, to_status, reason, operator, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        randomUUID(),
        transition.taskId,
        transition.traceId,
        transition.from,
        transition.to,
        transition.reason,
        transition.operator,
        transition.timestamp
      ]
    );
  }

  async listByTask(taskId: string): Promise<TaskTransition[]> {
    const result = await this.pool.query(
      "select * from task_transitions where task_id = $1 order by created_at asc",
      [taskId]
    );
    return result.rows.map(mapTaskTransition);
  }

  async listByTraceId(traceId: string): Promise<TaskTransition[]> {
    const result = await this.pool.query(
      "select * from task_transitions where trace_id = $1 order by created_at asc",
      [traceId]
    );
    return result.rows.map(mapTaskTransition);
  }
}

export class PgExecutionRepository implements ExecutionRepository {
  constructor(private readonly pool: DatabaseClient) {}

  async create(execution: ExecutionRecord): Promise<void> {
    await this.save(execution);
  }

  async save(execution: ExecutionRecord): Promise<void> {
    await this.pool.query(
      `insert into executions (id, task_id, agent_id, workspace, status, summary, executor, started_at, ended_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set
         agent_id = excluded.agent_id,
         workspace = excluded.workspace,
         status = excluded.status,
         summary = excluded.summary,
         executor = excluded.executor,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at`,
      [
        execution.id,
        execution.taskId,
        execution.agentId,
        execution.workspace,
        execution.status,
        execution.summary,
        execution.executor,
        execution.startedAt,
        execution.endedAt
      ]
    );
  }

  async listByTask(taskId: string): Promise<ExecutionRecord[]> {
    const result = await this.pool.query("select * from executions where task_id = $1 order by started_at desc", [taskId]);
    return result.rows.map(mapExecution);
  }

  async getLatestByTask(taskId: string): Promise<ExecutionRecord | null> {
    const result = await this.pool.query(
      "select * from executions where task_id = $1 order by started_at desc limit 1",
      [taskId]
    );
    return result.rows[0] ? mapExecution(result.rows[0]) : null;
  }
}

export class PgExecutionLogRepository implements ExecutionLogRepository {
  constructor(private readonly pool: DatabaseClient) {}

  async append(log: ExecutionLogRecord): Promise<void> {
    await this.pool.query(
      `insert into execution_logs (id, task_id, execution_id, event_type, message, data_json, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        log.id,
        log.taskId,
        log.executionId,
        log.eventType,
        log.message,
        JSON.stringify(encodeJsonObject(log.data)),
        log.createdAt
      ]
    );
  }

  async listByTask(taskId: string): Promise<ExecutionLogRecord[]> {
    const result = await this.pool.query(
      "select * from execution_logs where task_id = $1 order by created_at asc",
      [taskId]
    );
    return result.rows.map(mapExecutionLog);
  }
}

export class PgAgentRepository implements AgentRepository {
  constructor(private readonly pool: DatabaseClient) {}

  async upsert(agent: AgentRecord): Promise<void> {
    await this.pool.query(
      `insert into agents (id, status, task_id, executor, labels_json, last_heartbeat_at, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set
         status = excluded.status,
         task_id = excluded.task_id,
         executor = excluded.executor,
         labels_json = excluded.labels_json,
         last_heartbeat_at = excluded.last_heartbeat_at,
         updated_at = excluded.updated_at`,
      [
        agent.id,
        agent.status,
        agent.taskId,
        agent.executor,
        JSON.stringify(encodeJsonArray(agent.labels)),
        agent.lastHeartbeatAt,
        agent.createdAt,
        agent.updatedAt
      ]
    );
  }

  async list(): Promise<AgentRecord[]> {
    const result = await this.pool.query("select * from agents order by id asc");
    return result.rows.map(mapAgent);
  }

  async getIdle(executor: string): Promise<AgentRecord | null> {
    const result = await this.pool.query(
      "select * from agents where status = 'idle' and executor = $1 order by updated_at asc limit 1",
      [executor]
    );
    return result.rows[0] ? mapAgent(result.rows[0]) : null;
  }

  async getById(id: string): Promise<AgentRecord | null> {
    const result = await this.pool.query("select * from agents where id = $1", [id]);
    return result.rows[0] ? mapAgent(result.rows[0]) : null;
  }

  async claimIdle(executor: string, taskId: string, now: Date): Promise<AgentRecord | null> {
    const result = await this.pool.query(
      `update agents
       set status = 'busy',
           task_id = $2,
           last_heartbeat_at = $3,
           updated_at = $3
       where id = (
         select id
         from agents
         where status = 'idle' and executor = $1
         order by updated_at asc
         limit 1
       )
       returning *`,
      [executor, taskId, now]
    );
    return result.rows[0] ? mapAgent(result.rows[0]) : null;
  }
}

export class PgRepairGoalRepository implements RepairGoalRepository {
  constructor(private readonly pool: DatabaseClient) {}

  async upsert(goal: RepairGoal): Promise<void> {
    await this.pool.query(
      `insert into repair_goals (
        id, task_id, objective, constraints_json, done_when_json, status, iteration, max_iterations,
        last_failure_hash, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict (task_id) do update set
        objective = excluded.objective,
        constraints_json = excluded.constraints_json,
        done_when_json = excluded.done_when_json,
        status = excluded.status,
        iteration = excluded.iteration,
        max_iterations = excluded.max_iterations,
        last_failure_hash = excluded.last_failure_hash,
        updated_at = excluded.updated_at`,
      [
        goal.id,
        goal.taskId,
        goal.objective,
        JSON.stringify(encodeJsonArray(goal.constraints)),
        JSON.stringify(encodeJsonArray(goal.doneWhen)),
        goal.status,
        goal.currentIteration,
        goal.maxIterations,
        goal.lastFailureHash,
        goal.createdAt,
        goal.updatedAt
      ]
    );
  }

  async getByTaskId(taskId: string): Promise<RepairGoal | null> {
    const result = await this.pool.query("select * from repair_goals where task_id = $1", [taskId]);
    return result.rows[0] ? mapRepairGoal(result.rows[0]) : null;
  }
}

export class PgEvalResultRepository implements EvalResultRepository {
  constructor(private readonly pool: DatabaseClient) {}

  async create(result: EvalResult): Promise<void> {
    await this.pool.query(
      `insert into eval_results (id, task_id, execution_id, passed, score, risk_level, report_json, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        result.id,
        result.taskId,
        result.executionId,
        result.passed,
        result.score,
        result.riskLevel,
        JSON.stringify(encodeJsonObject(result.report)),
        result.createdAt
      ]
    );
  }

  async listByTask(taskId: string): Promise<EvalResult[]> {
    const result = await this.pool.query("select * from eval_results where task_id = $1 order by created_at desc", [taskId]);
    return result.rows.map(mapEvalResult);
  }
}

export class PgPluginConfigRepository implements PluginConfigRepository {
  constructor(private readonly pool: DatabaseClient) {}

  async list(): Promise<PluginConfig[]> {
    const result = await this.pool.query("select * from plugin_configs order by priority desc, plugin_id asc");
    return result.rows.map(mapPluginConfig);
  }

  async getByPluginId(pluginId: string): Promise<PluginConfig | null> {
    const result = await this.pool.query("select * from plugin_configs where plugin_id = $1 limit 1", [pluginId]);
    return result.rows[0] ? mapPluginConfig(result.rows[0]) : null;
  }

  async upsert(config: PluginConfig): Promise<void> {
    await this.pool.query(
      `insert into plugin_configs (id, plugin_id, kind, enabled, priority, config_json, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (plugin_id) do update set
         kind = excluded.kind,
         enabled = excluded.enabled,
         priority = excluded.priority,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
      [
        config.id,
        config.pluginId,
        config.kind,
        config.enabled,
        config.priority,
        JSON.stringify(encodeJsonObject(config.config)),
        config.updatedAt
      ]
    );
  }
}

export class PgAgentLeaseRepository implements AgentLeaseRepository {
  constructor(private readonly pool: DatabaseClient) {}

  async create(lease: AgentLease): Promise<void> {
    await this.pool.query(
      `insert into agent_leases (
        id, agent_id, task_id, execution_id, leased_at, lease_expires_at, released_at, release_reason,
        candidate_agents_json, selection_reason, priority_snapshot_json
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        lease.id,
        lease.agentId,
        lease.taskId,
        lease.executionId,
        lease.leasedAt,
        lease.leaseExpiresAt,
        lease.releasedAt,
        lease.releaseReason,
        JSON.stringify(encodeJsonArray(lease.candidateAgents)),
        lease.selectionReason,
        JSON.stringify(encodeJsonObject(lease.prioritySnapshot))
      ]
    );
  }

  async release(id: string, releasedAt: Date, releaseReason: string): Promise<void> {
    await this.pool.query(
      `update agent_leases
       set released_at = $2,
           release_reason = $3
       where id = $1`,
      [id, releasedAt, releaseReason]
    );
  }

  async listActive(): Promise<AgentLease[]> {
    const result = await this.pool.query("select * from agent_leases where released_at is null order by leased_at desc");
    return result.rows.map(mapAgentLease);
  }

  async listByTask(taskId: string): Promise<AgentLease[]> {
    const result = await this.pool.query("select * from agent_leases where task_id = $1 order by leased_at desc", [taskId]);
    return result.rows.map(mapAgentLease);
  }
}

export class PgHumanReviewRepository implements HumanReviewRepository {
  constructor(private readonly pool: DatabaseClient) {}

  async create(review: HumanReview): Promise<void> {
    await this.save(review);
  }

  async save(review: HumanReview): Promise<void> {
    await this.pool.query(
      `insert into human_reviews (
        id, task_id, execution_id, request_type, reason, external_thread_ref, response_summary, status, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (id) do update set
        execution_id = excluded.execution_id,
        request_type = excluded.request_type,
        reason = excluded.reason,
        external_thread_ref = excluded.external_thread_ref,
        response_summary = excluded.response_summary,
        status = excluded.status,
        updated_at = excluded.updated_at`,
      [
        review.id,
        review.taskId,
        review.executionId,
        review.requestType,
        review.reason,
        review.externalThreadRef,
        review.responseSummary,
        review.status,
        review.createdAt,
        review.updatedAt
      ]
    );
  }

  async getLatestByTask(taskId: string): Promise<HumanReview | null> {
    const result = await this.pool.query(
      "select * from human_reviews where task_id = $1 order by created_at desc limit 1",
      [taskId]
    );
    return result.rows[0] ? mapHumanReview(result.rows[0]) : null;
  }

  async listByTask(taskId: string): Promise<HumanReview[]> {
    const result = await this.pool.query("select * from human_reviews where task_id = $1 order by created_at asc", [taskId]);
    return result.rows.map(mapHumanReview);
  }
}

function mapTask(row: Record<string, unknown>): TitingTask {
  return {
    id: String(row.id),
    source: String(row.source),
    externalId: row.external_id ? String(row.external_id) : null,
    sourceIdentity: row.source_identity ? String(row.source_identity) : undefined,
    integrationKey: row.integration_key ? String(row.integration_key) : undefined,
    title: String(row.title),
    instruction: String(row.instruction),
    repo: String(row.repo),
    branch: String(row.branch),
    priority: row.priority as TitingTask["priority"],
    status: row.status as TitingTask["status"],
    executor: String(row.executor),
    traceId: String(row.trace_id),
    constraints: decodeJsonArray(row.constraints_json),
    acceptanceCriteria: decodeJsonArray(row.acceptance_criteria_json),
    metadata: decodeJsonObject(row.metadata_json),
    retryCount: Number(row.retry_count),
    repairCount: Number(row.repair_count),
    startedAt: row.started_at ? new Date(String(row.started_at)) : null,
    completedAt: row.completed_at ? new Date(String(row.completed_at)) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at))
  };
}

function mapExecution(row: Record<string, unknown>): ExecutionRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    agentId: row.agent_id ? String(row.agent_id) : null,
    workspace: String(row.workspace),
    status: row.status as ExecutionRecord["status"],
    summary: row.summary ? String(row.summary) : null,
    executor: String(row.executor),
    startedAt: new Date(String(row.started_at)),
    endedAt: row.ended_at ? new Date(String(row.ended_at)) : null
  };
}

function mapTaskTransition(row: Record<string, unknown>): TaskTransition {
  return {
    taskId: String(row.task_id),
    traceId: String(row.trace_id),
    from: row.from_status as TaskTransition["from"],
    to: row.to_status as TaskTransition["to"],
    reason: String(row.reason),
    operator: String(row.operator),
    timestamp: new Date(String(row.created_at))
  };
}

function mapExecutionLog(row: Record<string, unknown>): ExecutionLogRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    executionId: row.execution_id ? String(row.execution_id) : null,
    eventType: String(row.event_type),
    message: String(row.message),
    data: decodeJsonObject(row.data_json),
    createdAt: new Date(String(row.created_at))
  };
}

function mapAgent(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    status: row.status as AgentRecord["status"],
    taskId: row.task_id ? String(row.task_id) : null,
    executor: String(row.executor),
    labels: decodeJsonArray(row.labels_json),
    lastHeartbeatAt: new Date(String(row.last_heartbeat_at)),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at))
  };
}

function mapRepairGoal(row: Record<string, unknown>): RepairGoal {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    objective: String(row.objective),
    constraints: decodeJsonArray(row.constraints_json),
    doneWhen: decodeJsonArray(row.done_when_json),
    status: row.status as RepairGoal["status"],
    currentIteration: Number(row.iteration),
    maxIterations: Number(row.max_iterations),
    lastFailureHash: row.last_failure_hash ? String(row.last_failure_hash) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at))
  };
}

function mapEvalResult(row: Record<string, unknown>): EvalResult {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    executionId: String(row.execution_id),
    passed: decodeBoolean(row.passed),
    score: Number(row.score),
    riskLevel: row.risk_level as EvalResult["riskLevel"],
    report: decodeJsonObject(row.report_json),
    createdAt: new Date(String(row.created_at))
  };
}

function mapPluginConfig(row: Record<string, unknown>): PluginConfig {
  return {
    id: String(row.id),
    pluginId: String(row.plugin_id),
    kind: row.kind as PluginConfig["kind"],
    enabled: decodeBoolean(row.enabled),
    priority: Number(row.priority),
    config: decodeJsonObject(row.config_json),
    updatedAt: new Date(String(row.updated_at))
  };
}

function mapAgentLease(row: Record<string, unknown>): AgentLease {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    taskId: String(row.task_id),
    executionId: row.execution_id ? String(row.execution_id) : null,
    leasedAt: new Date(String(row.leased_at)),
    leaseExpiresAt: new Date(String(row.lease_expires_at)),
    releasedAt: row.released_at ? new Date(String(row.released_at)) : null,
    releaseReason: row.release_reason ? String(row.release_reason) : null,
    candidateAgents: decodeJsonArray(row.candidate_agents_json),
    selectionReason: String(row.selection_reason),
    prioritySnapshot: decodeJsonObject(row.priority_snapshot_json)
  };
}

function mapHumanReview(row: Record<string, unknown>): HumanReview {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    executionId: row.execution_id ? String(row.execution_id) : null,
    requestType: String(row.request_type),
    reason: String(row.reason),
    externalThreadRef: row.external_thread_ref ? String(row.external_thread_ref) : null,
    responseSummary: row.response_summary ? String(row.response_summary) : null,
    status: row.status as HumanReview["status"],
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at))
  };
}

/** 列中原生 JSON 对象与信封格式 `{ schemaVersion, data }` 双兼容，迁移期可共存。 */
type JsonEnvelope<T> = {
  schemaVersion: string;
  data: T;
};

function encodeJsonArray(values: string[]): JsonEnvelope<string[]> {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    data: values
  };
}

function encodeJsonObject(values: Record<string, unknown>): JsonEnvelope<Record<string, unknown>> {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    data: values
  };
}

function decodeJsonArray(value: unknown): string[] {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    return parsed.map(String);
  }
  if (isJsonEnvelope(parsed) && Array.isArray(parsed.data)) {
    return parsed.data.map(String);
  }
  return [];
}

function decodeJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  if (isPlainObject(parsed) && !isJsonEnvelope(parsed)) {
    return parsed;
  }
  if (isJsonEnvelope(parsed) && isPlainObject(parsed.data)) {
    return parsed.data;
  }
  return {};
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value !== "0" && value.toLowerCase() !== "false" && value.length > 0;
  }
  return Boolean(value);
}

function isJsonEnvelope(value: unknown): value is JsonEnvelope<unknown> {
  return isPlainObject(value) && typeof value.schemaVersion === "string" && "data" in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
