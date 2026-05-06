import { useEffect, useState } from "react";
import { listAgents } from "./api/agents";
import { getDashboardStats } from "./api/dashboard";
import { connectEvents } from "./api/events";
import { getTask, listTasks } from "./api/tasks";
import { Agent, DashboardStats, Task } from "./api/types";
import { AgentsPage } from "./pages/AgentsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { TasksPage } from "./pages/TasksPage";

type Page = "dashboard" | "tasks" | "agents" | "task-detail";
type RouteState = { page: Page; taskId: string | null };

const NAV_ITEMS: Array<{ id: Page; label: string; hint: string; ariaLabel: string }> = [
  { id: "dashboard", label: "Overview", hint: "总览节奏与风险", ariaLabel: "Dashboard" },
  { id: "tasks", label: "Tasks", hint: "任务流转与处理", ariaLabel: "Tasks" },
  { id: "agents", label: "Agents", hint: "执行容量与容器状态", ariaLabel: "Agents" }
];

export default function App() {
  const [route, setRoute] = useState<RouteState>(() => getRouteState(window.location.pathname));
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [isTaskLoading, setIsTaskLoading] = useState(false);

  const refreshAll = async () => {
    setIsRefreshing(true);
    try {
      const [nextStats, nextTasks, nextAgents] = await Promise.all([
        getDashboardStats(),
        listTasks(),
        listAgents()
      ]);
      setStats(nextStats);
      setTasks(nextTasks);
      setAgents(nextAgents);
      if (route.taskId) {
        const nextSelectedTask = nextTasks.find((task) => task.id === route.taskId) ?? null;
        setSelectedTask(nextSelectedTask);
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void refreshAll();
    return connectEvents(() => {
      void refreshAll();
    });
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(getRouteState(window.location.pathname));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (route.page !== "task-detail" || !route.taskId) {
      setSelectedTask(null);
      setIsTaskLoading(false);
      return;
    }

    const existingTask = tasks.find((task) => task.id === route.taskId) ?? null;
    if (existingTask) {
      setSelectedTask(existingTask);
      setIsTaskLoading(false);
      return;
    }

    let cancelled = false;
    setIsTaskLoading(true);
    void getTask(route.taskId)
      .then((task) => {
        if (!cancelled) {
          setSelectedTask(task);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedTask(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsTaskLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [route, tasks]);

  const runningTasks = tasks.filter((task) => task.status === "running").length;
  const failedTasks = tasks.filter((task) => task.status === "failed").length;
  const idleAgents = agents.filter((agent) => agent.status === "idle").length;

  const navigateTo = (path: string) => {
    window.history.pushState({}, "", path);
    setRoute(getRouteState(path));
  };

  const openTaskDetail = (taskId: string) => {
    navigateTo(`/tasks/${taskId}`);
  };

  return (
    <div className="app-shell">
      <div className="app-grid">
        <aside className="sidebar">
          <div className="brand-block">
            <p className="eyebrow">AUTODEV CONTROL</p>
            <h1>AutoDev Agent</h1>
            <p className="lede">
              为任务编排、Agent 容量和执行日志提供一个更接近终端工作流的控制面板。
            </p>
          </div>

          <nav className="nav-cluster" aria-label="Primary">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                aria-label={item.ariaLabel}
                className={`nav-pill ${route.page === item.id ? "active" : ""}`}
                onClick={() => navigateTo(item.id === "dashboard" ? "/" : `/${item.id}`)}
                type="button"
              >
                <span>{item.label}</span>
                <small>{item.hint}</small>
              </button>
            ))}
          </nav>

          <section className="status-panel" aria-label="Live system snapshot">
            <div className="status-panel-header">
              <span className={`live-dot ${isRefreshing ? "is-live" : ""}`} />
              <strong>{isRefreshing ? "Syncing live state" : "Realtime stream active"}</strong>
            </div>
            <div className="mini-metrics">
              <article>
                <span>Running</span>
                <strong>{runningTasks}</strong>
              </article>
              <article>
                <span>Failed</span>
                <strong>{failedTasks}</strong>
              </article>
              <article>
                <span>Idle Agents</span>
                <strong>{idleAgents}</strong>
              </article>
            </div>
          </section>
        </aside>

        <main className="content-shell">
          <header className="topbar">
            <div>
              <p className="eyebrow">Workspace</p>
              <h2>
                {route.page === "dashboard"
                  ? "Mission Overview"
                  : route.page === "tasks"
                    ? "Task Operations"
                    : route.page === "agents"
                      ? "Agent Capacity"
                      : "Task Detail"}
              </h2>
            </div>
            <div className="topbar-meta">
              <span className="terminal-chip">tasks {tasks.length}</span>
              <span className="terminal-chip">agents {agents.length}</span>
              <button className="ghost-button" onClick={() => void refreshAll()} type="button">
                Refresh
              </button>
            </div>
          </header>

          {route.page === "dashboard" ? (
            <DashboardPage
              stats={stats}
              tasks={tasks}
              agents={agents}
              refreshAll={refreshAll}
              onOpenTask={openTaskDetail}
            />
          ) : null}
          {route.page === "tasks" ? (
            <TasksPage tasks={tasks} refreshAll={refreshAll} onOpenTask={openTaskDetail} />
          ) : null}
          {route.page === "agents" ? <AgentsPage agents={agents} tasks={tasks} /> : null}
          {route.page === "task-detail" && selectedTask ? (
            <TaskDetailPage
              task={selectedTask}
              onBack={() => navigateTo("/tasks")}
              onOpenTask={openTaskDetail}
              refreshAll={refreshAll}
            />
          ) : null}
          {route.page === "task-detail" && isTaskLoading ? (
            <section className="panel muted-copy">正在加载任务详情...</section>
          ) : null}
          {route.page === "task-detail" && !isTaskLoading && !selectedTask ? (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">TASK DETAIL</p>
                  <h3>任务不存在</h3>
                </div>
                <button className="ghost-button" onClick={() => navigateTo("/tasks")} type="button">
                  返回任务列表
                </button>
              </div>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function getRouteState(pathname: string): RouteState {
  if (pathname === "/" || pathname === "") {
    return { page: "dashboard", taskId: null };
  }

  if (pathname === "/tasks") {
    return { page: "tasks", taskId: null };
  }

  if (pathname === "/agents") {
    return { page: "agents", taskId: null };
  }

  const taskDetailMatch = pathname.match(/^\/tasks\/([^/]+)$/);
  if (taskDetailMatch) {
    return { page: "task-detail", taskId: decodeURIComponent(taskDetailMatch[1]) };
  }

  return { page: "dashboard", taskId: null };
}
