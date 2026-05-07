import { Task, TaskSource } from "../tasks/task.entity";
import { ExecutionRunResult } from "./execution-engine.plugin";

export type TaskResultReporterPlugin = {
  readonly source: TaskSource | string;
  reportSuccess(task: Task, result: ExecutionRunResult): Promise<void>;
  reportFailure(task: Task, result: ExecutionRunResult): Promise<void>;
};
