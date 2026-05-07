import { Agent } from "../agents/agent.entity";

export type AgentStorePlugin = {
  countAgents(): Promise<number>;
  listAgents(): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | null>;
  createAgent(input: Partial<Agent>): Agent;
  saveAgent(agent: Agent): Promise<Agent>;
  findIdleAgent(): Promise<Agent | null>;
  claimIdleAgent(taskId: string): Promise<Agent | null>;
};
