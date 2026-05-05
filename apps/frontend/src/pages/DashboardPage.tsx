import { syncMeegle } from "../api/adapter";
import { Agent, DashboardStats, Task } from "../api/types";
import { AgentCard } from "../components/AgentCard";
import { StatsCards } from "../components/StatsCards";

type DashboardPageProps = {
  stats: DashboardStats | null;
  agents: Agent[];
  tasks: Task[];
  refreshAll: () => Promise<void>;
};

export function DashboardPage({ stats, agents, tasks, refreshAll }: DashboardPageProps) {
  const recentTasks = tasks.slice(0, 5);

  const handleSync = async () => {
    const result = await syncMeegle();
    window.alert(
      `sync: created ${result.summary.created}, updated ${result.summary.updated}, failed ${result.summary.failed}, recovered ${result.summary.recovered}`
    );
    await refreshAll();
  };

  return (
    <main>
      <div className="row">
        <h2>运维总览</h2>
        <button onClick={handleSync}>同步 Meegle</button>
      </div>
      <StatsCards stats={stats} />
      <section>
        <h2>Agent 概览</h2>
        <div className="grid">
          {agents.slice(0, 2).map((agent) => (
            <AgentCard agent={agent} key={agent.id} />
          ))}
        </div>
      </section>
      <section>
        <h2>最近任务</h2>
        {recentTasks.length === 0 ? <p>暂无任务</p> : recentTasks.map((task) => <p key={task.id}>{task.title}</p>)}
      </section>
    </main>
  );
}
