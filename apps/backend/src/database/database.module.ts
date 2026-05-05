import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Agent } from "../agents/agent.entity";
import { ExecutionLog } from "../execution-logs/execution-log.entity";
import { Task } from "../tasks/task.entity";
import { TaskLifecycle1714406400001 } from "./migrations/1714406400001-task-lifecycle";

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres",
        host: config.get<string>("DATABASE_HOST", "localhost"),
        port: Number(config.get<string>("DATABASE_PORT", "5432")),
        username: config.get<string>("DATABASE_USER", "autodev"),
        password: config.get<string>("DATABASE_PASSWORD", "autodev"),
        database: config.get<string>("DATABASE_NAME", "autodev"),
        entities: [Task, Agent, ExecutionLog],
        synchronize: false,
        migrations: [TaskLifecycle1714406400001],
        migrationsRun: true
      })
    })
  ]
})
export class DatabaseModule {}
