import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Agent } from "../../../packages/core/src/agents/agent.entity";
import { TaskLifecycle1714406400001 } from "../../../packages/core/src/database/migrations/1714406400001-task-lifecycle";
import { SystemSettings1714492800002 } from "../../../packages/core/src/database/migrations/1714492800002-system-settings";
import { Task } from "../../../packages/core/src/tasks/task.entity";
import { StoredSetting } from "./stored-setting.entity";
import { TypeOrmAgentStoreService } from "./typeorm-agent-store.service";
import { TypeOrmSettingsStoreService } from "./typeorm-settings-store.service";
import { TypeOrmTaskStoreService } from "./typeorm-task-store.service";

@Module({
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
        entities: [Task, Agent, StoredSetting],
        synchronize: false,
        migrations: [TaskLifecycle1714406400001, SystemSettings1714492800002],
        migrationsRun: true
      })
    }),
    TypeOrmModule.forFeature([Task, Agent, StoredSetting])
  ],
  providers: [
    TypeOrmTaskStoreService,
    TypeOrmAgentStoreService,
    TypeOrmSettingsStoreService
  ],
  exports: [
    TypeOrmTaskStoreService,
    TypeOrmAgentStoreService,
    TypeOrmSettingsStoreService
  ]
})
export class TypeOrmStoreModule {}
