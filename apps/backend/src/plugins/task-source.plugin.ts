import { TaskSource } from "../tasks/task.entity";

export type TaskSourceSyncItem = {
  id: string;
  title: string;
  description?: string | null;
  repo?: string | null;
  branch?: string | null;
  instruction?: string | null;
  priority?: string | null;
  taskType?: string | null;
};

export type TaskSourcePlugin = {
  readonly source: TaskSource | string;
  listOpenTasks(): Promise<TaskSourceSyncItem[]>;
};

export type TaskSourceAuthStatus = {
  authenticated: boolean;
  host: string;
};

export type AuthenticatedTaskSourcePlugin<
  LoginInit = unknown,
  LoginPollInput = unknown,
  LoginPollResult = unknown
> = TaskSourcePlugin & {
  getAuthStatus(): Promise<TaskSourceAuthStatus>;
  beginLogin(): Promise<LoginInit>;
  pollLogin(input: LoginPollInput): Promise<LoginPollResult>;
};
