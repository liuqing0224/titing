import { TaskRecord } from "./models/task";
import { resolveExecutionBranch } from "./task-branch";

export const TERMINAL_TASK_STATUSES = new Set(["done", "failed"]);

export function hasValidExecutionFields(task: Pick<TaskRecord, "repo" | "branch" | "instruction">): boolean {
  return Boolean(task.repo?.trim() && resolveExecutionBranch(task.branch) && task.instruction?.trim());
}
