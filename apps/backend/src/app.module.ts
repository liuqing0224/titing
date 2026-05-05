import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdapterModule } from "./adapter/adapter.module";
import { AgentModule } from "./agents/agent.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { DatabaseModule } from "./database/database.module";
import { EventsModule } from "./events/events.module";
import { ExecutionLogModule } from "./execution-logs/execution-log.module";
import { OrchestratorModule } from "./orchestrator/orchestrator.module";
import { TaskModule } from "./tasks/task.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true
    }),
    AdapterModule,
    AgentModule,
    DashboardModule,
    DatabaseModule,
    EventsModule,
    ExecutionLogModule,
    OrchestratorModule,
    TaskModule
  ]
})
export class AppModule {}
