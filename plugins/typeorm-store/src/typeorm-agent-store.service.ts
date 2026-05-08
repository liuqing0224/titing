import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Agent } from "@autodev-agent/core";
import { AgentStorePlugin } from "@autodev-agent/plugin-api";

@Injectable()
export class TypeOrmAgentStoreService implements AgentStorePlugin {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>
  ) {}

  async countAgents(): Promise<number> {
    return this.agentRepository.count();
  }

  async listAgents(): Promise<Agent[]> {
    return this.agentRepository.find({
      order: { id: "ASC" }
    });
  }

  async getAgent(id: string): Promise<Agent | null> {
    return this.agentRepository.findOne({ where: { id } });
  }

  createAgent(input: Partial<Agent>): Agent {
    return this.agentRepository.create(input);
  }

  async saveAgent(agent: Agent): Promise<Agent> {
    return this.agentRepository.save(agent);
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

    return this.getAgent(candidate.id);
  }
}
