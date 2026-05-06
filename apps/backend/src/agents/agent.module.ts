import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EventsModule } from "../events/events.module";
import { AgentController } from "./agent.controller";
import { Agent } from "./agent.entity";
import { AgentService } from "./agent.service";
import { DockerAgentService } from "./docker-agent.service";

@Module({
  imports: [TypeOrmModule.forFeature([Agent]), EventsModule],
  controllers: [AgentController],
  providers: [AgentService, DockerAgentService],
  exports: [AgentService, DockerAgentService]
})
export class AgentModule {}
