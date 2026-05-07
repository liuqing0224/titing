import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module";
import { ExecutionLogModule } from "../execution-logs/execution-log.module";
import { TaskController } from "./task.controller";
import { TaskService } from "./task.service";

@Module({
  imports: [ExecutionLogModule, EventsModule],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService]
})
export class TaskModule {}
