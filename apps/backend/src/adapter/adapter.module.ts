import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EventsModule } from "../events/events.module";
import { ExecutionLogModule } from "../execution-logs/execution-log.module";
import { Task } from "../tasks/task.entity";
import { AdapterController } from "./adapter.controller";
import { AdapterService } from "./adapter.service";
import { MeegleAdapter } from "./meegle.adapter";

@Module({
  imports: [TypeOrmModule.forFeature([Task]), ExecutionLogModule, EventsModule],
  controllers: [AdapterController],
  providers: [AdapterService, MeegleAdapter],
  exports: [AdapterService, MeegleAdapter]
})
export class AdapterModule {}
