import { Agent } from "../api/types";
import { AgentCard } from "../components/AgentCard";

type AgentsPageProps = {
  agents: Agent[];
};

export function AgentsPage({ agents }: AgentsPageProps) {
  return (
    <main>
      <h2>Agent 状态</h2>
      <section className="grid">
        {agents.map((agent) => (
          <AgentCard agent={agent} key={agent.id} />
        ))}
      </section>
    </main>
  );
}
