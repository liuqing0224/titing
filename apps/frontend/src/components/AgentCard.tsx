import { Agent } from "../api/types";

type AgentCardProps = {
  agent: Agent;
};

export function AgentCard({ agent }: AgentCardProps) {
  return (
    <article className="card">
      <div className="row">
        <strong>{agent.id}</strong>
        <span className={`badge ${agent.status}`}>{agent.status}</span>
      </div>
      <p>container: {agent.containerName}</p>
      <p>containerId: {agent.containerId ?? "-"}</p>
      <p>taskId: {agent.taskId ?? "-"}</p>
      <p>startedAt: {agent.startedAt ?? "-"}</p>
      <p>heartbeatAt: {agent.heartbeatAt}</p>
      <p>updatedAt: {agent.updatedAt}</p>
    </article>
  );
}
