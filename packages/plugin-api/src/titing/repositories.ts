import {
  AgentRecord,
  EvalResult,
  ExecutionLogRecord,
  ExecutionRecord,
  PluginConfig,
  RepairGoal,
  TaskListQuery,
  TaskTransition,
  TitingTask
} from "./models";

export interface TaskRepository {
  create(task: TitingTask): Promise<void>;
  save(task: TitingTask): Promise<void>;
  getById(id: string): Promise<TitingTask | null>;
  getByExternalId(source: string, externalId: string): Promise<TitingTask | null>;
  listByTraceId(traceId: string): Promise<TitingTask[]>;
  list(query?: TaskListQuery): Promise<TitingTask[]>;
  claimQueued(id: string, startedAt: Date): Promise<TitingTask | null>;
}

export interface TaskTransitionRepository {
  append(transition: TaskTransition): Promise<void>;
  listByTask(taskId: string): Promise<TaskTransition[]>;
  listByTraceId(traceId: string): Promise<TaskTransition[]>;
}

export interface ExecutionRepository {
  create(execution: ExecutionRecord): Promise<void>;
  save(execution: ExecutionRecord): Promise<void>;
  listByTask(taskId: string): Promise<ExecutionRecord[]>;
  getLatestByTask(taskId: string): Promise<ExecutionRecord | null>;
}

export interface ExecutionLogRepository {
  append(log: ExecutionLogRecord): Promise<void>;
  listByTask(taskId: string): Promise<ExecutionLogRecord[]>;
}

export interface AgentRepository {
  upsert(agent: AgentRecord): Promise<void>;
  list(): Promise<AgentRecord[]>;
  getIdle(executor: string): Promise<AgentRecord | null>;
  getById(id: string): Promise<AgentRecord | null>;
  claimIdle(executor: string, taskId: string, now: Date): Promise<AgentRecord | null>;
}

export interface RepairGoalRepository {
  upsert(goal: RepairGoal): Promise<void>;
  getByTaskId(taskId: string): Promise<RepairGoal | null>;
}

export interface EvalResultRepository {
  create(result: EvalResult): Promise<void>;
  listByTask(taskId: string): Promise<EvalResult[]>;
}

export interface PluginConfigRepository {
  list(): Promise<PluginConfig[]>;
  getByPluginId(pluginId: string): Promise<PluginConfig | null>;
  upsert(config: PluginConfig): Promise<void>;
}
