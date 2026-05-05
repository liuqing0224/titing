import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EventsModule } from "../events/events.module";
import { ExecutionLogModule } from "../execution-logs/execution-log.module";
import { TaskController } from "./task.controller";
import { Task } from "./task.entity";
import { TaskService } from "./task.service";

@Module({
  imports: [TypeOrmModule.forFeature([Task]), ExecutionLogModule, EventsModule],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService]
})
export class TaskModule {}
