import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module";
import { ExecutionLogController } from "./execution-log.controller";
import { ExecutionLogService } from "./execution-log.service";

@Module({
  imports: [EventsModule],
  controllers: [ExecutionLogController],
  providers: [ExecutionLogService],
  exports: [ExecutionLogService]
})
export class ExecutionLogModule {}
