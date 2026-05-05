import { Injectable, NotFoundException, OnApplicationBootstrap, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EventsService } from "../events/events.service";
import { DockerAgentService } from "./docker-agent.service";
import { Agent } from "./agent.entity";

@Injectable()
export class AgentService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    private readonly eventsService: EventsService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly dockerAgentService?: DockerAgentService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const poolSize = Number(this.configService?.get<string>("AGENT_POOL_SIZE", "2") ?? 2);
    await this.ensurePool(poolSize);
  }

  async ensurePool(size: number): Promise<void> {
    const agents = await this.agentRepository.find();
    for (const agent of agents) {
      if (agent.status === "idle" || (agent.status === "offline" && !agent.taskId)) {
        agent.status = "idle";
        agent.heartbeatAt = new Date();
        await this.ensureDockerContainer(agent);
        await this.agentRepository.save(agent);
      }
    }

    const existingCount = await this.agentRepository.count();
    for (let index = existingCount + 1; index <= size; index += 1) {
      const agent = this.agentRepository.create({
        id: `agent-${index}`,
        taskId: null,
        containerId: null,
        containerName: `agent-${index}`,
        status: "idle",
        startedAt: new Date(),
        heartbeatAt: new Date()
      });
      await this.ensureDockerContainer(agent);
      await this.agentRepository.save(agent);
    }
  }

  async listAgents(): Promise<Agent[]> {
    return this.agentRepository.find({
      order: { id: "ASC" }
    });
  }

  async findIdleAgent(): Promise<Agent | null> {
    const agent = await this.agentRepository.findOne({ where: { status: "idle" } });
    return agent?.taskId ? null : agent;
  }

  async claimIdleAgent(taskId: string): Promise<Agent | null> {
    const candidate = await this.findIdleAgent();
    if (!candidate) {
      return null;
    }

    const result = await this.agentRepository
      .createQueryBuilder()
      .update(Agent)
      .set({
        status: "running",
        taskId,
        heartbeatAt: new Date()
      })
      .where("id = :id", { id: candidate.id })
      .andWhere("status = :status", { status: "idle" })
      .andWhere("task_id IS NULL")
      .execute();

    if (result.affected !== 1) {
      return null;
    }

    const agent = await this.getAgent(candidate.id);
    this.eventsService.publishAgentStatus(agent.id, agent.status);
    return agent;
  }

  async markRunning(agentId: string, taskId: string): Promise<Agent> {
    const agent = await this.getAgent(agentId);
    agent.status = "running";
    agent.taskId = taskId;
    agent.heartbeatAt = new Date();
    const saved = await this.agentRepository.save(agent);
    this.eventsService.publishAgentStatus(saved.id, saved.status);
    return saved;
  }

  async markIdle(agentId: string): Promise<Agent> {
    const agent = await this.getAgent(agentId);
    agent.status = "idle";
    agent.taskId = null;
    agent.heartbeatAt = new Date();
    await this.ensureDockerContainer(agent);
    const saved = await this.agentRepository.save(agent);
    this.eventsService.publishAgentStatus(saved.id, saved.status);
    return saved;
  }

  async markOffline(agentId: string): Promise<Agent> {
    const agent = await this.getAgent(agentId);
    agent.status = "offline";
    const saved = await this.agentRepository.save(agent);
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
    return this.agentRepository.save(agent);
  }

  async detectOfflineAgents(timeoutSeconds: number, now = new Date()): Promise<Agent[]> {
    const agents = await this.agentRepository.find();
    const offlineAgents: Agent[] = [];
    const timeoutMs = timeoutSeconds * 1000;

    for (const agent of agents) {
      if (agent.status === "offline") {
        continue;
      }

      const ageMs = now.getTime() - agent.heartbeatAt.getTime();
      if (ageMs > timeoutMs) {
        agent.status = "offline";
        const saved = await this.agentRepository.save(agent);
        this.eventsService.publishAgentStatus(saved.id, saved.status);
        offlineAgents.push(saved);
      }
    }

    return offlineAgents;
  }

  private async ensureDockerContainer(agent: Agent): Promise<void> {
    if (!this.dockerAgentService) {
      return;
    }
    const containerState = await this.dockerAgentService.ensureContainer(agent);
    agent.containerId = containerState.containerId;
    agent.startedAt = agent.startedAt ?? new Date();
  }

  private async getAgent(agentId: string): Promise<Agent> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId } });
    if (!agent) {
      throw new NotFoundException(`Agent ${agentId} not found`);
    }
    return agent;
  }
}
