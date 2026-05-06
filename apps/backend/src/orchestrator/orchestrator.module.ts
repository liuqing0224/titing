import { Module } from "@nestjs/common";
import { AdapterModule } from "../adapter/adapter.module";
import { AgentModule } from "../agents/agent.module";
import { ExecutionLogModule } from "../execution-logs/execution-log.module";
import { TaskModule } from "../tasks/task.module";
import { CodexRunner } from "./codex-runner";
import { OrchestratorService } from "./orchestrator.service";
import { ResultReporterService } from "./result-reporter.service";

@Module({
  imports: [AdapterModule, AgentModule, ExecutionLogModule, TaskModule],
  providers: [CodexRunner, OrchestratorService, ResultReporterService],
  exports: [OrchestratorService]
})
export class OrchestratorModule {}
