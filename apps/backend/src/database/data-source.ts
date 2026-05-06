import "reflect-metadata";
import { DataSource } from "typeorm";
import { Agent } from "../agents/agent.entity";
import { ExecutionLog } from "../execution-logs/execution-log.entity";
import { SystemSetting } from "../settings/system-setting.entity";
import { Task } from "../tasks/task.entity";
import { TaskLifecycle1714406400001 } from "./migrations/1714406400001-task-lifecycle";
import { SystemSettings1714492800002 } from "./migrations/1714492800002-system-settings";

export default new DataSource({
  type: "postgres",
  host: process.env.DATABASE_HOST ?? "localhost",
  port: Number(process.env.DATABASE_PORT ?? "5432"),
  username: process.env.DATABASE_USER ?? "autodev",
  password: process.env.DATABASE_PASSWORD ?? "autodev",
  database: process.env.DATABASE_NAME ?? "autodev",
  entities: [Task, Agent, ExecutionLog, SystemSetting],
  migrations: [TaskLifecycle1714406400001, SystemSettings1714492800002],
  synchronize: false
});
