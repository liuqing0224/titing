import { AgentRecord, EvalResult, ExecutionLogRecord, ExecutionRecord, RepairGoal, TaskTransition, TitingTask } from "@titing/plugin-api";

/**
 * `TitingServices` 上**只读**子集的稳定外观：任务/仪表盘/trace/可观测/执行产物/Agent。
 * 与 `TaskCommandService` 拆分后可单独做缓存或鉴权。
 */
type QueryHost = {
  getTask(id: string): Promise<TitingTask>;
  listTasks(query?: { status?: TitingTask["status"]; executor?: string }): Promise<TitingTask[]>;
  dashboard(): Promise<Record<string, unknown>>;
  getTraceView(traceId: string): Promise<Record<string, unknown>>;
  getTaskObservability(taskId: string): Promise<Record<string, unknown>>;
  listExecutions(taskId: string): Promise<ExecutionRecord[]>;
  listEvalResults(taskId: string): Promise<EvalResult[]>;
  getRepairGoal(taskId: string): Promise<RepairGoal | null>;
  listExecutionLogs(taskId: string): Promise<ExecutionLogRecord[]>;
  listTaskTransitions(taskId: string): Promise<TaskTransition[]>;
  listAgents(): Promise<AgentRecord[]>;
};

export class TaskQueryService {
  constructor(private readonly host: QueryHost) {}

  getTask(id: string): Promise<TitingTask> {
    return this.host.getTask(id);
  }

  listTasks(query?: { status?: TitingTask["status"]; executor?: string }): Promise<TitingTask[]> {
    return this.host.listTasks(query);
  }

  dashboard(): Promise<Record<string, unknown>> {
    return this.host.dashboard();
  }

  getTraceView(traceId: string): Promise<Record<string, unknown>> {
    return this.host.getTraceView(traceId);
  }

  getTaskObservability(taskId: string): Promise<Record<string, unknown>> {
    return this.host.getTaskObservability(taskId);
  }

  listExecutions(taskId: string): Promise<ExecutionRecord[]> {
    return this.host.listExecutions(taskId);
  }

  listEvalResults(taskId: string): Promise<EvalResult[]> {
    return this.host.listEvalResults(taskId);
  }

  getRepairGoal(taskId: string): Promise<RepairGoal | null> {
    return this.host.getRepairGoal(taskId);
  }

  listExecutionLogs(taskId: string): Promise<ExecutionLogRecord[]> {
    return this.host.listExecutionLogs(taskId);
  }

  listTaskTransitions(taskId: string): Promise<TaskTransition[]> {
    return this.host.listTaskTransitions(taskId);
  }

  listAgents(): Promise<AgentRecord[]> {
    return this.host.listAgents();
  }
}
