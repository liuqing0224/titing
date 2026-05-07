import { Controller, Get, Param, Post } from "@nestjs/common";
import { Agent } from "./agent.entity";
import { AgentService } from "./agent.service";

@Controller("agents")
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get()
  listAgents(): Promise<Agent[]> {
    return this.agentService.listAgents();
  }

  @Post(":id/heartbeat")
  refreshHeartbeat(@Param("id") id: string): Promise<Agent> {
    return this.agentService.refreshHeartbeat(id);
  }
}
