import { DynamicModule, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PluginEntityClass } from "@autodev-agent/plugin-api";
import { Agent } from "../agents/agent.entity";
import { Task } from "../tasks/task.entity";
import { TaskLifecycle1714406400001 } from "./migrations/1714406400001-task-lifecycle";

@Module({})
export class DatabaseModule {
  static register(options: {
    pluginEntities?: PluginEntityClass[];
    pluginMigrations?: Function[];
  } = {}): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            type: "postgres",
            host: config.get<string>("DATABASE_HOST", "127.0.0.1"),
            port: Number(config.get<string>("DATABASE_PORT", "55432")),
            username: config.get<string>("DATABASE_USER", "autodev"),
            password: config.get<string>("DATABASE_PASSWORD", "autodev"),
            database: config.get<string>("DATABASE_NAME", "autodev"),
            entities: [Task, Agent, ...(options.pluginEntities ?? [])],
            synchronize: false,
            migrations: [TaskLifecycle1714406400001, ...(options.pluginMigrations ?? [])],
            migrationsRun: true
          })
        })
      ]
    };
  }
}
