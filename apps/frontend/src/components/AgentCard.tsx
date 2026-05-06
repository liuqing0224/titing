import { Agent } from "../api/types";
import { formatShanghaiTime } from "../utils/time";

type AgentCardProps = {
  agent: Agent;
};

export function AgentCard({ agent }: AgentCardProps) {
  return (
    <article className="card agent-card">
      <div className="card-topline">
        <span className="eyebrow">AGENT SLOT</span>
        <span className={`badge ${agent.status}`}>{agent.status}</span>
      </div>
      <div className="card-header">
        <div>
          <h3>{agent.id}</h3>
          <p className="muted-copy">{agent.containerName}</p>
        </div>
      </div>
      <dl className="meta-grid">
        <div>
          <dt>Container ID</dt>
          <dd>{agent.containerId ?? "-"}</dd>
        </div>
        <div>
          <dt>Task</dt>
          <dd>{agent.taskId ?? "-"}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatShanghaiTime(agent.startedAt)}</dd>
        </div>
        <div>
          <dt>Heartbeat</dt>
          <dd>{formatShanghaiTime(agent.heartbeatAt)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatShanghaiTime(agent.updatedAt)}</dd>
        </div>
      </dl>
    </article>
  );
}
