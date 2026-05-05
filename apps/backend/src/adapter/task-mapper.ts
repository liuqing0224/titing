import { randomUUID } from "node:crypto";
import { Task, TaskPriority, TaskType } from "../tasks/task.entity";

export type RawMeegleTask = {
  id: string;
  title: string;
  description?: string | null;
  repo?: string | null;
  branch?: string | null;
  instruction?: string | null;
  priority?: string | null;
  projectKey?: string | null;
};

export function mapRawTaskToTaskInput(raw: RawMeegleTask): Partial<Task> {
  return {
    id: `auto-${randomUUID()}`,
    source: "meegle",
    externalId: raw.id,
    title: raw.title,
    description: raw.description ?? null,
    repo: raw.repo ?? "",
    branch: raw.branch ?? "main",
    instruction: raw.instruction ?? null,
    priority: mapPriority(raw.priority),
    taskType: inferTaskType(raw.title),
    constraints: [],
    retryCount: 0
  };
}

export function mapPriority(priority?: string | null): TaskPriority {
  const normalized = priority?.toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  return "medium";
}

export function inferTaskType(title: string): TaskType {
  const normalized = title.toLowerCase();
  if (normalized.includes("bug") || normalized.includes("fix")) {
    return "bug";
  }
  if (normalized.includes("doc")) {
    return "docs";
  }
  if (normalized.includes("feature") || normalized.includes("feat")) {
    return "feature";
  }
  return "chore";
}
