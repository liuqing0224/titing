import { apiRequest } from "./client";
import { ExecutionLog, Task, TaskPriority, TaskStatus } from "./types";

export type TaskFilters = {
  status?: TaskStatus;
  priority?: TaskPriority;
};

export function listTasks(filters: TaskFilters = {}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filters.status) {
    params.set("status", filters.status);
  }
  if (filters.priority) {
    params.set("priority", filters.priority);
  }
  const query = params.toString();
  return apiRequest<Task[]>(`/tasks${query ? `?${query}` : ""}`);
}

export function updateTaskExecutionFields(
  taskId: string,
  input: { repo: string; branch: string; instruction: string }
): Promise<Task> {
  return apiRequest<Task>(`/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function retryTask(taskId: string): Promise<Task> {
  return apiRequest<Task>(`/tasks/${taskId}/retry`, {
    method: "POST"
  });
}

export function listTaskLogs(taskId: string): Promise<ExecutionLog[]> {
  return apiRequest<ExecutionLog[]>(`/tasks/${taskId}/logs`);
}
