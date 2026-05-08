import { AgentRecord } from "./models/agent";

export type AgentStorePlugin = {
  countAgents(): Promise<number>;
  listAgents(): Promise<AgentRecord[]>;
  getAgent(id: string): Promise<AgentRecord | null>;
  createAgent(input: Partial<AgentRecord>): AgentRecord;
  saveAgent(agent: AgentRecord): Promise<AgentRecord>;
  findIdleAgent(): Promise<AgentRecord | null>;
  claimIdleAgent(taskId: string): Promise<AgentRecord | null>;
};
