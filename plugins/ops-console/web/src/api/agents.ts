import { apiRequest } from "./client";
import { Agent } from "./types";

export function listAgents(): Promise<Agent[]> {
  return apiRequest<Agent[]>("/agents");
}
