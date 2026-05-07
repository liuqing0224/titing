import { Module } from "@nestjs/common";
import { AgentModule } from "./agents/agent.module";
import { EventsModule } from "./events/events.module";
import { ExecutionLogModule } from "./execution-logs/execution-log.module";
import { OrchestratorModule } from "./orchestrator/orchestrator.module";
import { TaskModule } from "./tasks/task.module";

@Module({
  imports: [
    EventsModule,
    ExecutionLogModule,
    TaskModule,
    AgentModule,
    OrchestratorModule
  ],
  exports: [
    EventsModule,
    ExecutionLogModule,
    TaskModule,
    AgentModule,
    OrchestratorModule
  ]
})
export class CoreModule {}
