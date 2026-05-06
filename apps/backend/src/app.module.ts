import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { AdapterModule } from "./adapter/adapter.module";
import { AgentModule } from "./agents/agent.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { DatabaseModule } from "./database/database.module";
import { EventsModule } from "./events/events.module";
import { ExecutionLogModule } from "./execution-logs/execution-log.module";
import { MeegleSyncModule } from "./meegle-sync/meegle-sync.module";
import { OrchestratorModule } from "./orchestrator/orchestrator.module";
import { SettingsModule } from "./settings/settings.module";
import { TaskModule } from "./tasks/task.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true
    }),
    ScheduleModule.forRoot(),
    AdapterModule,
    AgentModule,
    DashboardModule,
    DatabaseModule,
    EventsModule,
    ExecutionLogModule,
    MeegleSyncModule,
    OrchestratorModule,
    SettingsModule,
    TaskModule
  ]
})
export class AppModule {}
