import { Module } from "@nestjs/common";
import { AgentModule } from "../agents/agent.module";
import { ExecutionLogModule } from "../execution-logs/execution-log.module";
import { TaskModule } from "../tasks/task.module";
import { OrchestratorService } from "./orchestrator.service";
import { ResultReporterService } from "./result-reporter.service";

@Module({
  imports: [AgentModule, ExecutionLogModule, TaskModule],
  providers: [OrchestratorService, ResultReporterService],
  exports: [OrchestratorService]
})
export class OrchestratorModule {}
