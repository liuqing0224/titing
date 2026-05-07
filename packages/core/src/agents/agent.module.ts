import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";

@Module({
  imports: [EventsModule],
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService]
})
export class AgentModule {}
