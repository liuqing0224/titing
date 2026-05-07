import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EventsModule } from "../events/events.module";
import { AGENT_RUNTIME_PLUGIN } from "../plugins/plugin.tokens";
import { AgentController } from "./agent.controller";
import { Agent } from "./agent.entity";
import { AgentService } from "./agent.service";
import { DockerAgentService } from "./docker-agent.service";

@Module({
  imports: [TypeOrmModule.forFeature([Agent]), EventsModule],
  controllers: [AgentController],
  providers: [
    AgentService,
    DockerAgentService,
    {
      provide: AGENT_RUNTIME_PLUGIN,
      useExisting: DockerAgentService
    }
  ],
  exports: [AgentService, DockerAgentService, AGENT_RUNTIME_PLUGIN]
})
export class AgentModule {}
