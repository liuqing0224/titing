import { useCallback, useEffect, useState } from "react";
import { listAgents } from "./api/agents";
import { getDashboardStats } from "./api/dashboard";
import { connectEvents } from "./api/events";
import { listTasks } from "./api/tasks";
import { Agent, DashboardStats, Task } from "./api/types";
import { AgentsPage } from "./pages/AgentsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { TasksPage } from "./pages/TasksPage";

type Page = "dashboard" | "tasks" | "agents";

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);

  const refreshAll = useCallback(async () => {
    const [nextStats, nextTasks, nextAgents] = await Promise.all([
      getDashboardStats(),
      listTasks(),
      listAgents()
    ]);
    setStats(nextStats);
    setTasks(nextTasks);
    setAgents(nextAgents);
  }, []);

  useEffect(() => {
    void refreshAll();
    return connectEvents(() => {
      void refreshAll();
    });
  }, [refreshAll]);

  return (
    <div className="app-shell">
      <header>
        <h1>AutoDev Agent</h1>
        <nav>
          <button onClick={() => setPage("dashboard")}>Dashboard</button>
          <button onClick={() => setPage("tasks")}>Tasks</button>
          <button onClick={() => setPage("agents")}>Agents</button>
        </nav>
      </header>
      {page === "dashboard" ? (
        <DashboardPage stats={stats} tasks={tasks} agents={agents} refreshAll={refreshAll} />
      ) : null}
      {page === "tasks" ? <TasksPage tasks={tasks} refreshAll={refreshAll} /> : null}
      {page === "agents" ? <AgentsPage agents={agents} /> : null}
    </div>
  );
}
