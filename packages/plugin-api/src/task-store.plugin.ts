import { TaskPriority, TaskRecord, TaskStatus } from "./models/task";

export type ListTasksQuery = {
  status?: TaskStatus;
  priority?: TaskPriority;
};

export type TaskStorePlugin = {
  listTasks(query?: ListTasksQuery): Promise<TaskRecord[]>;
  getTask(id: string): Promise<TaskRecord | null>;
  findTaskByExternalId(externalId: string): Promise<TaskRecord | null>;
  createTask(input: Partial<TaskRecord>): TaskRecord;
  saveTask(task: TaskRecord): Promise<TaskRecord>;
};
