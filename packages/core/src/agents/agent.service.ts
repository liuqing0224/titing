import { Inject, Injectable, NotFoundException, OnApplicationBootstrap, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventsService } from "../events/events.service";
import { AgentStorePlugin } from "../plugins/agent-store.plugin";
import { AgentRuntimePlugin } from "../plugins/agent-runtime.plugin";
import { AGENT_RUNTIME_PLUGIN, AGENT_STORE_PLUGIN } from "../plugins/plugin.tokens";
import { Agent } from "./agent.entity";

@Injectable()
export class AgentService implements OnApplicationBootstrap {
  constructor(
    @Inject(AGENT_STORE_PLUGIN)
    private readonly agentStore: AgentStorePlugin,
    private readonly eventsService: EventsService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    @Inject(AGENT_RUNTIME_PLUGIN)
    private readonly agentRuntime?: AgentRuntimePlugin
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const poolSize = Number(this.configService?.get<string>("AGENT_POOL_SIZE", "2") ?? 2);
    await this.ensurePool(poolSize);
  }

  async ensurePool(size: number): Promise<void> {
    const agents = await this.agentStore.listAgents();
    for (const agent of agents) {
      if (agent.status === "idle" || (agent.status === "offline" && !agent.taskId)) {
        agent.status = "idle";
        agent.heartbeatAt = new Date();
        await this.ensureRuntime(agent);
        await this.agentStore.saveAgent(agent);
      }
    }

    const existingCount = await this.agentStore.countAgents();
    for (let index = existingCount + 1; index <= size; index += 1) {
      const agent = this.agentStore.createAgent({
        id: `agent-${index}`,
        taskId: null,
        containerId: null,
        containerName: `agent-${index}`,
        status: "idle",
        startedAt: new Date(),
        heartbeatAt: new Date()
      });
      await this.ensureRuntime(agent);
      await this.agentStore.saveAgent(agent);
    }
  }

  async listAgents(): Promise<Agent[]> {
    return this.agentStore.listAgents();
  }

  async findIdleAgent(): Promise<Agent | null> {
    return this.agentStore.findIdleAgent();
  }

  async claimIdleAgent(taskId: string): Promise<Agent | null> {
    const agent = await this.agentStore.claimIdleAgent(taskId);
    if (!agent) {
      return null;
    }
    this.eventsService.publishAgentStatus(agent.id, agent.status);
    return agent;
  }

  async markRunning(agentId: string, taskId: string): Promise<Agent> {
    const agent = await this.getAgent(agentId);
    agent.status = "running";
    agent.taskId = taskId;
    agent.heartbeatAt = new Date();
    const saved = await this.agentStore.saveAgent(agent);
    this.eventsService.publishAgentStatus(saved.id, saved.status);
    return saved;
  }

  async markIdle(agentId: string): Promise<Agent> {
    const agent = await this.getAgent(agentId);
    agent.status = "idle";
    agent.taskId = null;
    agent.heartbeatAt = new Date();
    await this.ensureRuntime(agent);
    const saved = await this.agentStore.saveAgent(agent);
    this.eventsService.publishAgentStatus(saved.id, saved.status);
    return saved;
  }

  async markOffline(agentId: string): Promise<Agent> {
    const agent = await this.getAgent(agentId);
    agent.status = "offline";
    const saved = await this.agentStore.saveAgent(agent);
    this.eventsService.publishAgentStatus(saved.id, saved.status);
    return saved;
  }

  async refreshHeartbeat(agentId: string): Promise<Agent> {
    const agent = await this.getAgent(agentId);
    agent.heartbeatAt = new Date();
    if (agent.status === "offline") {
      agent.status = agent.taskId ? "running" : "idle";
      this.eventsService.publishAgentStatus(agent.id, agent.status);
    }
    return this.agentStore.saveAgent(agent);
  }

  async detectOfflineAgents(timeoutSeconds: number, now = new Date()): Promise<Agent[]> {
    const agents = await this.agentStore.listAgents();
    const offlineAgents: Agent[] = [];
    const timeoutMs = timeoutSeconds * 1000;

    for (const agent of agents) {
      if (agent.status === "offline") {
        continue;
      }

      const ageMs = now.getTime() - agent.heartbeatAt.getTime();
      if (ageMs > timeoutMs) {
        agent.status = "offline";
        const saved = await this.agentStore.saveAgent(agent);
        this.eventsService.publishAgentStatus(saved.id, saved.status);
        offlineAgents.push(saved);
      }
    }

    return offlineAgents;
  }

  private async ensureRuntime(agent: Agent): Promise<void> {
    if (!this.agentRuntime) {
      return;
    }
    try {
      const runtimeState = await this.agentRuntime.ensureRuntime(agent);
      agent.containerId = runtimeState.containerId;
      agent.startedAt = agent.startedAt ?? new Date();
    } catch {
      agent.status = "offline";
    }
  }

  private async getAgent(agentId: string): Promise<Agent> {
    const agent = await this.agentStore.getAgent(agentId);
    if (!agent) {
      throw new NotFoundException(`Agent ${agentId} not found`);
    }
    return agent;
  }
}
