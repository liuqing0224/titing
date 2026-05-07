import { Task, TaskPriority, TaskStatus } from "../tasks/task.entity";

export type ListTasksQuery = {
  status?: TaskStatus;
  priority?: TaskPriority;
};

export type TaskStorePlugin = {
  listTasks(query?: ListTasksQuery): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  findTaskByExternalId(externalId: string): Promise<Task | null>;
  createTask(input: Partial<Task>): Task;
  saveTask(task: Task): Promise<Task>;
};
