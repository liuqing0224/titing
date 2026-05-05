import { Task } from "./task.entity";
import { resolveExecutionBranch } from "./task-branch";

export const TERMINAL_TASK_STATUSES = new Set(["done", "failed"]);

export function hasValidExecutionFields(task: Pick<Task, "repo" | "branch" | "instruction">): boolean {
  return Boolean(task.repo?.trim() && resolveExecutionBranch(task.branch) && task.instruction?.trim());
}
