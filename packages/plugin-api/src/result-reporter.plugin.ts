import { TaskRecord, TaskSource } from "./models/task";
import { ExecutionRunResult } from "./execution-engine.plugin";

export type TaskResultReporterPlugin = {
  readonly source: TaskSource | string;
  reportSuccess(task: TaskRecord, result: ExecutionRunResult): Promise<void>;
  reportFailure(task: TaskRecord, result: ExecutionRunResult): Promise<void>;
};
