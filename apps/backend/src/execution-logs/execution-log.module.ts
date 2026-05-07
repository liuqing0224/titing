import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EventsModule } from "../events/events.module";
import { ExecutionLogController } from "./execution-log.controller";
import { ExecutionLog } from "./execution-log.entity";
import { ExecutionLogService } from "./execution-log.service";

@Module({
  imports: [TypeOrmModule.forFeature([ExecutionLog]), EventsModule],
  controllers: [ExecutionLogController],
  providers: [ExecutionLogService],
  exports: [ExecutionLogService]
})
export class ExecutionLogModule {}
