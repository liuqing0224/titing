import { Task } from "./task.entity";

export const TERMINAL_TASK_STATUSES = new Set(["done", "failed"]);

export function hasValidExecutionFields(task: Pick<Task, "repo" | "branch" | "instruction">): boolean {
  return Boolean(task.repo?.trim() && task.branch?.trim() && task.instruction?.trim());
}
