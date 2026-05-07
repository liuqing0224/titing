import { Agent, Task } from "../api/types";
import { AgentCard } from "../components/AgentCard";

type AgentsPageProps = {
  agents: Agent[];
  tasks: Task[];
};

export function AgentsPage({ agents, tasks }: AgentsPageProps) {
  const running = agents.filter((agent) => agent.status === "running").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const offline = agents.filter((agent) => agent.status === "offline").length;

  return (
    <div className="page-stack">
      <section className="hero-panel compact">
        <div>
          <p className="eyebrow">EXECUTION CAPACITY</p>
          <h3>Agent 状态</h3>
          <p className="hero-copy">
            显示容器占用、最近心跳和任务绑定情况，帮助判断是否需要扩容或重建运行环境。
          </p>
        </div>
        <div className="mini-metrics inline">
          <article>
            <span>Running</span>
            <strong>{running}</strong>
          </article>
          <article>
            <span>Idle</span>
            <strong>{idle}</strong>
          </article>
          <article>
            <span>Offline</span>
            <strong>{offline}</strong>
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">POOL MAP</p>
            <h3>Agent 容器池</h3>
          </div>
          <span className="terminal-chip">{tasks.filter((task) => task.agentId).length} task bindings</span>
        </div>
        <section className="grid agent-grid">
          {agents.map((agent) => (
            <AgentCard agent={agent} key={agent.id} />
          ))}
        </section>
      </section>
    </div>
  );
}
