import { useEffect, useState } from "react";

type DashboardData = {
  tasks: {
    total: number;
    byStatus: Record<string, number>;
  };
  agents: {
    total: number;
    byStatus: Record<string, number>;
  };
  plugins: {
    total: number;
    healthy: number;
  };
};

type OpsSnapshot = {
  focusEventTypes: string[];
  watchedEventCount: number;
  eventTypeCounts: Record<string, number>;
  eventTypeRanking: Array<{
    eventType: string;
    count: number;
  }>;
  recentWatchedEvents: EventItem[];
  recentAbnormalTasks: Array<{
    taskId: string;
    title: string;
    status: string;
    traceId: string;
    eventType: string;
    message: string;
    createdAt: string;
    retryCount: number;
    repairCount: number;
  }>;
};

type Task = {
  id: string;
  title: string;
  instruction?: string;
  repo: string;
  branch: string;
  executor: string;
  status: string;
  priority: string;
  traceId: string;
  repairCount: number;
  retryCount: number;
  createdAt: string;
  updatedAt?: string;
};

type Agent = {
  id: string;
  status: string;
  executor: string;
  taskId: string | null;
};

type Plugin = {
  id: string;
  kind: string;
  priority: number;
  capabilities: string[];
  health: {
    healthy: boolean;
    message: string;
  };
};

type PluginConfig = {
  pluginId: string;
  kind: string;
  enabled: boolean;
  priority: number;
  config: Record<string, unknown>;
};

type MeegleAuthStart = {
  status: "pending";
  authenticated: false;
  authorizationUrl: string;
  deviceCode: string;
  clientId: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  message: string;
};

type MeegleAuthPoll = {
  status: "pending" | "authenticated" | "failed" | "expired";
  authenticated: boolean;
  message: string;
};

type MeegleAuthUiState = {
  status: "idle" | "starting" | MeegleAuthPoll["status"];
  message: string;
};

type Readiness = {
  ok: boolean;
  status: string;
  checks: {
    plugins: {
      ok: boolean;
      message: string;
      requiredKinds: Record<string, boolean>;
    };
  };
};

type Execution = {
  id: string;
  status: string;
  summary: string | null;
  executor: string;
  startedAt: string;
  endedAt: string | null;
  agentId: string | null;
};

type Transition = {
  taskId: string;
  traceId: string;
  from: string;
  to: string;
  reason: string;
  operator: string;
  timestamp: string;
};

type ExecutionLog = {
  id: string;
  taskId: string;
  executionId: string | null;
  eventType: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
};

type EvalResult = {
  id: string;
  taskId: string;
  executionId: string;
  passed: boolean;
  score: number;
  riskLevel: string;
  report: Record<string, unknown>;
  createdAt: string;
};

type RepairGoal = {
  id: string;
  taskId: string;
  objective: string;
  constraints: string[];
  doneWhen: string[];
  status: string;
  currentIteration: number;
  maxIterations: number;
};

type Observability = {
  schemaVersion: string;
  taskId: string;
  transitions: Transition[];
  executionLogs: ExecutionLog[];
};

type TaskDetails = {
  executions: Execution[];
  transitions: Transition[];
  logs: ExecutionLog[];
  evalResults: EvalResult[];
  repairGoal: RepairGoal | null;
  observability: Observability;
};

type EventItem = {
  id: string;
  eventType: string;
  traceId: string;
  taskId?: string;
  createdAt?: string;
  data?: Record<string, unknown>;
};

type StreamStatus = "connecting" | "live" | "reconnecting";
type EventCategory =
  | "all"
  | "task"
  | "execution"
  | "goal"
  | "eval"
  | "scheduler"
  | "agent"
  | "plugin"
  | "governance"
  | "environment"
  | "other";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api";

export default function App() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [opsSnapshot, setOpsSnapshot] = useState<OpsSnapshot | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [pluginConfigs, setPluginConfigs] = useState<PluginConfig[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [taskDetails, setTaskDetails] = useState<Record<string, TaskDetails>>({});
  const [recentEvents, setRecentEvents] = useState<EventItem[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [meegleAuth, setMeegleAuth] = useState<MeegleAuthUiState>({
    status: "idle",
    message: ""
  });
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [streamRetryToken, setStreamRetryToken] = useState(0);
  const [taskQuery, setTaskQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [eventCategoryFilter, setEventCategoryFilter] = useState<EventCategory>("all");

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | null = null;
    let refreshTimer: number | null = null;
    const source = new EventSource(`${API_BASE}/events`);
    setStreamStatus("connecting");
    source.onmessage = (event) => {
      const payload = safeParseEvent(event.data);
      setStreamStatus("live");
      setRecentEvents((current) => [payload, ...current].slice(0, 20));
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        void refreshAll();
      }, 300);
    };
    source.onerror = () => {
      if (disposed) {
        return;
      }
      setStreamStatus("reconnecting");
      source.close();
      retryTimer = window.setTimeout(() => {
        if (!disposed) {
          setStreamRetryToken((current) => current + 1);
        }
      }, 2000);
    };

    return () => {
      disposed = true;
      source.close();
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [streamRetryToken]);

  const filteredTasks = tasks.filter((task) => {
    const matchesStatus = statusFilter === "all" || task.status === statusFilter;
    if (!matchesStatus) {
      return false;
    }
    const query = taskQuery.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return [
      task.id,
      task.title,
      task.repo,
      task.branch,
      task.executor,
      task.traceId
    ].some((value) => value.toLowerCase().includes(query));
  });
  const taskStatusCounts = groupTasksByStatus(tasks);

  useEffect(() => {
    if (filteredTasks.length === 0) {
      setSelectedTaskId(null);
      return;
    }
    setSelectedTaskId((current) =>
      current && filteredTasks.some((task) => task.id === current) ? current : filteredTasks[0].id
    );
  }, [filteredTasks]);

  useEffect(() => {
    if (plugins.length === 0) {
      setSelectedPluginId(null);
      return;
    }
    setSelectedPluginId((current) => (current && plugins.some((plugin) => plugin.id === current) ? current : plugins[0].id));
  }, [plugins]);

  useEffect(() => {
    if (!selectedTaskId) {
      return;
    }
    void refreshTaskDetails(selectedTaskId);
  }, [selectedTaskId]);

  useEffect(() => {
    setEventCategoryFilter("all");
  }, [selectedTaskId]);

  const selectedTask = filteredTasks.find((task) => task.id === selectedTaskId) ?? tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedDetails = selectedTaskId ? taskDetails[selectedTaskId] : null;
  const selectedEvents = selectedTask
    ? recentEvents.filter((event) => event.taskId === selectedTask.id || event.traceId === selectedTask.traceId)
    : recentEvents;
  const selectedExecutionLogs = selectedDetails?.observability.executionLogs ?? [];
  const eventCategoryCounts = groupEventsByCategory(selectedEvents);
  const logCategoryCounts = groupExecutionLogsByCategory(selectedExecutionLogs);
  const filteredSelectedEvents = selectedEvents.filter((event) => matchesEventCategory(event.eventType, eventCategoryFilter));
  const filteredSelectedLogs = selectedExecutionLogs.filter((log) => matchesEventCategory(log.eventType, eventCategoryFilter));
  const selectedExecutionSummary = selectedDetails ? summarizeExecutionState(selectedTask, selectedDetails, selectedEvents) : null;
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? null;
  const selectedPluginConfig = selectedPlugin
    ? pluginConfigs.find((config) => config.pluginId === selectedPlugin.id) ?? null
    : null;

  async function refreshAll(): Promise<void> {
    setIsRefreshing(true);
    try {
      const [dashboardResponse, opsResponse, tasksResponse, agentsResponse, pluginsResponse, pluginConfigsResponse, readinessResponse] = await Promise.all([
        fetchJson<DashboardData>("/dashboard"),
        fetchJson<OpsSnapshot>("/ops/events"),
        fetchJson<Task[]>("/tasks"),
        fetchJson<Agent[]>("/agents"),
        fetchJson<Plugin[]>("/plugins"),
        fetchJson<PluginConfig[]>("/plugin-configs"),
        fetchJson<Readiness>("/readiness")
      ]);
      setDashboard(dashboardResponse);
      setOpsSnapshot(opsResponse);
      setTasks(tasksResponse);
      setAgents(agentsResponse);
      setPlugins(pluginsResponse);
      setPluginConfigs(pluginConfigsResponse);
      setReadiness(readinessResponse);
      setRefreshError(null);
    } catch (refreshError) {
      setRefreshError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setIsRefreshing(false);
    }
  }

  async function refreshTaskDetails(taskId: string): Promise<void> {
    setLoadingDetails(true);
    try {
      const [executions, transitions, logs, evalResults, repairGoal, observability] = await Promise.all([
        fetchJson<Execution[]>(`/tasks/${taskId}/executions`),
        fetchJson<Transition[]>(`/tasks/${taskId}/transitions`),
        fetchJson<ExecutionLog[]>(`/tasks/${taskId}/logs`),
        fetchJson<EvalResult[]>(`/tasks/${taskId}/eval-results`),
        fetchJson<RepairGoal | null>(`/tasks/${taskId}/repair-goal`),
        fetchJson<Observability>(`/tasks/${taskId}/observability`)
      ]);
      setTaskDetails((current) => ({
        ...current,
        [taskId]: {
          executions,
          transitions,
          logs,
          evalResults,
          repairGoal,
          observability
        }
      }));
      setDetailError(null);
    } catch (detailError) {
      setDetailError(detailError instanceof Error ? detailError.message : String(detailError));
    } finally {
      setLoadingDetails(false);
    }
  }

  async function triggerTaskAction(
    taskId: string,
    action: "validate" | "queue" | "retry" | "cancel"
  ): Promise<void> {
    try {
      await postJson(`/tasks/${taskId}/${action}`);
      await Promise.all([refreshAll(), refreshTaskDetails(taskId)]);
      setRefreshError(null);
      setDetailError(null);
    } catch (actionError) {
      setDetailError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }

  async function startMeegleAuthorization(): Promise<void> {
    setMeegleAuth({ status: "starting", message: "Starting Meegle authorization..." });
    try {
      const started = await postJson<MeegleAuthStart>("/integrations/meegle/auth/start");
      window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
      setMeegleAuth({ status: "pending", message: started.message });
      await pollMeegleAuthorization(started);
    } catch (authError) {
      setMeegleAuth({
        status: "failed",
        message: authError instanceof Error ? authError.message : String(authError)
      });
    }
  }

  async function pollMeegleAuthorization(input: MeegleAuthStart): Promise<void> {
    try {
      const result = await postJson<MeegleAuthPoll>("/integrations/meegle/auth/poll", {
        deviceCode: input.deviceCode,
        clientId: input.clientId,
        intervalSeconds: input.intervalSeconds,
        expiresInSeconds: input.expiresInSeconds
      });
      setMeegleAuth({ status: result.status, message: result.message });
      if (result.authenticated) {
        await refreshAll();
        return;
      }
      if (result.status === "pending") {
        window.setTimeout(() => {
          void pollMeegleAuthorization(input);
        }, Math.max(input.intervalSeconds, 1) * 1000);
      }
    } catch (authError) {
      setMeegleAuth({
        status: "failed",
        message: authError instanceof Error ? authError.message : String(authError)
      });
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">TITING</p>
          <h1>AI Engineering Execution Controller</h1>
          <p className="lede">
            从任务接入到执行评测，再到修复和人工接管，全部收敛到一块操作台。
          </p>
        </div>
        <div className="hero-actions">
          <span className={`stream-badge stream-${streamStatus}`}>
            {streamStatus === "live" ? "Live updates connected" : streamStatus === "connecting" ? "Connecting live updates" : "Live updates reconnecting"}
          </span>
          <button className="secondary-button" onClick={() => void postJson("/debug/sync").then(refreshAll)} type="button">
            Sync
          </button>
          <button className="secondary-button" onClick={() => void postJson("/debug/scheduler").then(refreshAll)} type="button">
            Dispatch
          </button>
          <button className="primary-button" onClick={() => void refreshAll()} type="button">
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {refreshError ? (
        <section className="banner danger banner-actionable">
          <span>Data refresh failed: {refreshError}</span>
          <button className="secondary-button" onClick={() => void refreshAll()} type="button">
            Retry refresh
          </button>
        </section>
      ) : null}
      {streamStatus === "reconnecting" ? (
        <section className="banner warning banner-actionable">
          <span>Live updates disconnected. Reconnecting in the background.</span>
          <button
            className="secondary-button"
            onClick={() => {
              setStreamStatus("connecting");
              setStreamRetryToken((current) => current + 1);
            }}
            type="button"
          >
            Reconnect now
          </button>
        </section>
      ) : null}
      {detailError ? <section className="banner danger">{detailError}</section> : null}

      <section className="stats-grid">
        <StatCard title="Tasks" value={dashboard?.tasks.total ?? 0} detail={formatCounts(dashboard?.tasks.byStatus ?? {})} />
        <StatCard title="Agents" value={dashboard?.agents.total ?? 0} detail={formatCounts(dashboard?.agents.byStatus ?? {})} />
        <StatCard title="Plugins" value={dashboard?.plugins.total ?? 0} detail={`${dashboard?.plugins.healthy ?? 0} healthy`} />
      </section>

      <section className="panel ops-panel">
        <div className="panel-header">
          <div>
            <h2>Global Event / Ops</h2>
            <p className="meta detail-subtitle">
              Focus on blocked, retry-scheduled, scheduler skipped, offline agents, and skipped integrations.
            </p>
          </div>
          <span>{opsSnapshot?.watchedEventCount ?? 0}</span>
        </div>

        <div className="ops-summary-grid">
          <StatCard title="Watched Events" value={opsSnapshot?.watchedEventCount ?? 0} detail={formatCounts(opsSnapshot?.eventTypeCounts ?? {})} />
          <StatCard
            title="Abnormal Tasks"
            value={opsSnapshot?.recentAbnormalTasks.length ?? 0}
            detail={opsSnapshot?.recentAbnormalTasks[0] ? `latest ${formatEventLabel(opsSnapshot.recentAbnormalTasks[0].eventType)}` : "none"}
          />
          <StatCard
            title="Top Event"
            value={opsSnapshot?.eventTypeRanking[0]?.count ?? 0}
            detail={opsSnapshot?.eventTypeRanking[0] ? formatEventLabel(opsSnapshot.eventTypeRanking[0].eventType) : "none"}
          />
        </div>

        <div className="ops-grid">
          <article className="detail-card ops-card">
            <div className="subpanel-header">
              <h3>EventType Ranking</h3>
              <span>{opsSnapshot?.eventTypeRanking.length ?? 0}</span>
            </div>
            <div className="timeline-list compact-list">
              {(opsSnapshot?.eventTypeRanking ?? []).map((item) => (
                <article className={`timeline-item event-${classifyEventTone(item.eventType)}`} key={item.eventType}>
                  <div>
                    <p className="timeline-title">{formatEventLabel(item.eventType)}</p>
                    <p className="meta">recent abnormal signal</p>
                  </div>
                  <p className="mono">count {item.count}</p>
                </article>
              ))}
              {(opsSnapshot?.eventTypeRanking ?? []).length === 0 ? <div className="empty-state">No watched ops events yet.</div> : null}
            </div>
          </article>

          <article className="detail-card ops-card">
            <div className="subpanel-header">
              <h3>Recent Abnormal Tasks</h3>
              <span>{opsSnapshot?.recentAbnormalTasks.length ?? 0}</span>
            </div>
            <div className="timeline-list compact-list">
              {(opsSnapshot?.recentAbnormalTasks ?? []).map((item) => (
                <button className="ops-task-row" key={`${item.taskId}-${item.eventType}-${item.createdAt}`} onClick={() => setSelectedTaskId(item.taskId)} type="button">
                  <div>
                    <p className="timeline-title">
                      {item.title}
                      <span className={`badge status-${item.status}`}>{item.status}</span>
                    </p>
                    <p className="meta">
                      {formatEventLabel(item.eventType)} · retry {item.retryCount} · repair {item.repairCount}
                    </p>
                    <p className="event-context">{item.message}</p>
                  </div>
                  <p className="mono">{formatDate(item.createdAt)}</p>
                </button>
              ))}
              {(opsSnapshot?.recentAbnormalTasks ?? []).length === 0 ? <div className="empty-state">No abnormal tasks detected in the current event window.</div> : null}
            </div>
          </article>

          <article className="detail-card ops-card">
            <div className="subpanel-header">
              <h3>Global Watched Feed</h3>
              <span>{opsSnapshot?.recentWatchedEvents.length ?? 0}</span>
            </div>
            <div className="timeline-list compact-list">
              {(opsSnapshot?.recentWatchedEvents ?? []).map((event) => (
                <article className={`timeline-item event-${classifyEventTone(event.eventType)}`} key={event.id}>
                  <div>
                    <p className="timeline-title">
                      {formatEventLabel(event.eventType)}
                      <span className={`event-pill event-${classifyEventTone(event.eventType)}`}>
                        {classifyEventTone(event.eventType)}
                      </span>
                    </p>
                    <p className="meta">{eventSummary(event)}</p>
                  </div>
                  <p className="mono">{event.createdAt ? formatDate(event.createdAt) : "live"}</p>
                </article>
              ))}
              {(opsSnapshot?.recentWatchedEvents ?? []).length === 0 ? <div className="empty-state">No watched feed events yet.</div> : null}
            </div>
          </article>
        </div>
      </section>

      <main className="console-grid">
        <section className="panel task-panel">
          <div className="panel-header">
            <h2>Tasks</h2>
            <span>{filteredTasks.length}</span>
          </div>
          <div className="task-filter-row">
            <span className="eyebrow compact">Active Queue</span>
            <span className="meta">{formatCounts(taskStatusCounts)}</span>
          </div>
          <div className="task-search-row">
            <input
              aria-label="Search tasks"
              className="task-search"
              onChange={(event) => setTaskQuery(event.target.value)}
              placeholder="Search id, title, repo, branch, trace"
              type="search"
              value={taskQuery}
            />
          </div>
          <div className="filter-pills" role="tablist" aria-label="Task status filters">
            {buildStatusFilters(taskStatusCounts).map((filter) => (
              <button
                aria-pressed={statusFilter === filter.value}
                className={`filter-pill ${statusFilter === filter.value ? "filter-pill-active" : ""}`}
                key={filter.value}
                onClick={() => setStatusFilter(filter.value)}
                type="button"
              >
                {filter.label}
                <span>{filter.count}</span>
              </button>
            ))}
          </div>
          <div className="stack">
            {filteredTasks.map((task) => (
              <button
                className={`task-card ${selectedTaskId === task.id ? "task-card-selected" : ""}`}
                key={task.id}
                onClick={() => setSelectedTaskId(task.id)}
                type="button"
              >
                <div className="card-head">
                  <h3>{task.title}</h3>
                  <span className={`badge status-${task.status}`}>{task.status}</span>
                </div>
                <p className="mono">{task.repo}#{task.branch}</p>
                <p className="meta">
                  {task.executor} · {task.priority} · repair {task.repairCount} · retry {task.retryCount}
                </p>
              </button>
            ))}
            {filteredTasks.length === 0 ? (
              <div className="empty-state">
                {tasks.length === 0 ? "No tasks have been synced yet." : "No tasks match the current filter."}
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel detail-panel">
          <div className="panel-header">
            <div>
              <h2>{selectedTask?.title ?? "Task Detail"}</h2>
              <p className="meta detail-subtitle">
                {selectedTask ? `${selectedTask.repo}#${selectedTask.branch} · ${selectedTask.executor}` : "Select a task"}
              </p>
            </div>
            {selectedTask ? <span className={`badge status-${selectedTask.status}`}>{selectedTask.status}</span> : null}
          </div>

          {selectedTask ? (
            <>
              <div className="action-row">
                <button className="secondary-button" onClick={() => void triggerTaskAction(selectedTask.id, "validate")} type="button">
                  Validate
                </button>
                <button className="secondary-button" onClick={() => void triggerTaskAction(selectedTask.id, "queue")} type="button">
                  Queue
                </button>
                <button className="secondary-button" onClick={() => void triggerTaskAction(selectedTask.id, "retry")} type="button">
                  Retry
                </button>
                <button className="secondary-button danger-outline" onClick={() => void triggerTaskAction(selectedTask.id, "cancel")} type="button">
                  Cancel
                </button>
              </div>

              <div className="detail-grid">
                <article className="detail-card">
                  <p className="eyebrow compact">Task Context</p>
                  <p className="detail-copy">{selectedTask.instruction ?? "No instruction available."}</p>
                  <div className="detail-metrics">
                    <Metric label="Trace" value={selectedTask.traceId} mono />
                    <Metric label="Created" value={formatDate(selectedTask.createdAt)} />
                    <Metric label="Priority" value={selectedTask.priority} />
                  </div>
                </article>

                <article className="detail-card">
                  <p className="eyebrow compact">Repair Goal</p>
                  {selectedDetails?.repairGoal ? (
                    <>
                      <p className="detail-copy">{selectedDetails.repairGoal.objective}</p>
                      <p className="meta">
                        {selectedDetails.repairGoal.status} · iteration {selectedDetails.repairGoal.currentIteration}/
                        {selectedDetails.repairGoal.maxIterations}
                      </p>
                      <p className="mono">
                        {selectedDetails.repairGoal.doneWhen.length > 0
                          ? selectedDetails.repairGoal.doneWhen.join(" · ")
                          : "No done-when criteria"}
                      </p>
                    </>
                  ) : (
                    <p className="meta">No active repair goal.</p>
                  )}
                </article>
              </div>

              <section className="summary-strip">
                <article className={`summary-card ${selectedExecutionSummary?.tone ?? "neutral"}`}>
                  <p className="eyebrow compact">Execution Recovery</p>
                  <p className="summary-title">{selectedExecutionSummary?.headline ?? "No recovery signal yet."}</p>
                  <p className="meta">{selectedExecutionSummary?.detail ?? "The task has not emitted retry or block events yet."}</p>
                </article>
                <article className="summary-card neutral">
                  <p className="eyebrow compact">Current Pressure</p>
                  <p className="summary-title">
                    retry {selectedTask.retryCount} · repair {selectedTask.repairCount}
                  </p>
                  <p className="meta">
                    {selectedDetails?.evalResults[0]
                      ? `Latest eval score ${selectedDetails.evalResults[0].score} with ${selectedDetails.evalResults[0].riskLevel} risk`
                      : "No evaluation has been recorded yet."}
                  </p>
                </article>
              </section>

              <section className="timeline-section">
                <div className="subpanel-header">
                  <h3>Executions</h3>
                  <span>{selectedDetails?.executions.length ?? 0}</span>
                </div>
                <div className="mini-grid">
                  {(selectedDetails?.executions ?? []).map((execution) => (
                    <article className="mini-card" key={execution.id}>
                      <div className="card-head">
                        <strong className="mono">{execution.id}</strong>
                        <span className={`badge status-${execution.status}`}>{execution.status}</span>
                      </div>
                      <p className="meta">
                        {execution.executor} · {execution.agentId ?? "no agent"}
                      </p>
                      <p>{execution.summary ?? "No summary"}</p>
                      <p className="mono">
                        {formatDate(execution.startedAt)}
                        {execution.endedAt ? ` → ${formatDate(execution.endedAt)}` : ""}
                      </p>
                    </article>
                  ))}
                  {(selectedDetails?.executions ?? []).length === 0 ? <div className="empty-state">No executions yet.</div> : null}
                </div>
              </section>

              <section className="timeline-section">
                <div className="subpanel-header">
                  <h3>Lifecycle Timeline</h3>
                  <span>{selectedDetails?.transitions.length ?? 0}</span>
                </div>
                <div className="timeline-list">
                  {(selectedDetails?.transitions ?? []).map((transition, index) => (
                    <article className="timeline-item" key={`${transition.taskId}-${index}-${transition.timestamp}`}>
                      <div>
                        <p className="timeline-title">
                          {transition.from} → {transition.to}
                        </p>
                        <p className="meta">{transition.reason}</p>
                      </div>
                      <p className="mono">{formatDate(transition.timestamp)}</p>
                    </article>
                  ))}
                  {(selectedDetails?.transitions ?? []).length === 0 ? <div className="empty-state">No lifecycle transitions yet.</div> : null}
                </div>
              </section>

              <section className="timeline-section dual">
                <article className="detail-card">
                  <div className="subpanel-header">
                    <h3>Execution Logs</h3>
                    <span>{filteredSelectedLogs.length}</span>
                  </div>
                  <div className="task-filter-row event-filter-row">
                    <span className="eyebrow compact">Log Lens</span>
                    <span className="meta">{formatCounts(logCategoryCounts)}</span>
                  </div>
                  <div className="timeline-list compact-list">
                    {filteredSelectedLogs.map((log) => (
                      <article className={`timeline-item event-${classifyEventTone(log.eventType)}`} key={log.id}>
                        <div>
                          <p className="timeline-title">
                            {formatEventLabel(log.eventType)}
                            <span className={`event-pill event-${classifyEventTone(log.eventType)}`}>
                              {classifyEventTone(log.eventType)}
                            </span>
                          </p>
                          <p className="meta">{log.message}</p>
                          {renderExecutionLogContext(log)}
                        </div>
                        <p className="mono">{formatDate(log.createdAt)}</p>
                      </article>
                    ))}
                    {filteredSelectedLogs.length === 0 ? (
                      <div className="empty-state">
                        {selectedExecutionLogs.length === 0 ? "No execution logs yet." : "No execution logs match the current event lens."}
                      </div>
                    ) : null}
                  </div>
                </article>

                <article className="detail-card">
                  <div className="subpanel-header">
                    <h3>Eval Results</h3>
                    <span>{selectedDetails?.evalResults.length ?? 0}</span>
                  </div>
                  <div className="timeline-list compact-list">
                    {(selectedDetails?.evalResults ?? []).map((result) => (
                      <article className="timeline-item" key={result.id}>
                        <div>
                          <p className="timeline-title">
                            score {result.score} · {result.riskLevel}
                          </p>
                          <p className="meta">{result.passed ? "passed" : "failed"}</p>
                        </div>
                        <p className="mono">{formatDate(result.createdAt)}</p>
                      </article>
                    ))}
                    {(selectedDetails?.evalResults ?? []).length === 0 ? <div className="empty-state">No eval results yet.</div> : null}
                  </div>
                </article>
              </section>

              <section className="timeline-section">
                <div className="subpanel-header">
                  <h3>Live Event Stream</h3>
                  <span>{filteredSelectedEvents.length}</span>
                </div>
                <div className="task-filter-row event-filter-row">
                  <span className="eyebrow compact">Event Lens</span>
                  <span className="meta">{formatCounts(eventCategoryCounts)}</span>
                </div>
                <div className="filter-pills" role="tablist" aria-label="Event category filters">
                  {buildEventCategoryFilters(eventCategoryCounts).map((filter) => (
                    <button
                      aria-pressed={eventCategoryFilter === filter.value}
                      className={`filter-pill ${eventCategoryFilter === filter.value ? "filter-pill-active" : ""}`}
                      key={filter.value}
                      onClick={() => setEventCategoryFilter(filter.value)}
                      type="button"
                    >
                      {filter.label}
                      <span>{filter.count}</span>
                    </button>
                  ))}
                </div>
                <div className="timeline-list compact-list">
                  {loadingDetails ? <p className="meta">Loading task detail…</p> : null}
                  {filteredSelectedEvents.map((event) => (
                    <article className={`timeline-item event-${classifyEventTone(event.eventType)}`} key={event.id}>
                      <div>
                        <p className="timeline-title">
                          {formatEventLabel(event.eventType)}
                          <span className={`event-pill event-${classifyEventTone(event.eventType)}`}>
                            {classifyEventTone(event.eventType)}
                          </span>
                        </p>
                        <p className="meta">{eventSummary(event)}</p>
                      </div>
                      <p className="mono">{event.createdAt ? formatDate(event.createdAt) : "live"}</p>
                    </article>
                  ))}
                  {filteredSelectedEvents.length === 0 && !loadingDetails ? (
                    <div className="empty-state">
                      {selectedEvents.length === 0 ? "No live events yet." : "No live events match the current event lens."}
                    </div>
                  ) : null}
                </div>
              </section>
            </>
          ) : (
            <div className="empty-state">No task selected.</div>
          )}
        </section>

        <section className="panel sidebar-panel">
          <div className="panel-header">
            <h2>Agents</h2>
            <span>{agents.length}</span>
          </div>
          <div className="stack">
            {agents.map((agent) => (
              <article className="card" key={agent.id}>
                <div className="card-head">
                  <h3>{agent.id}</h3>
                  <span className={`badge status-${agent.status}`}>{agent.status}</span>
                </div>
                <p className="meta">
                  {agent.executor} · {agent.taskId ? `task ${agent.taskId}` : "idle"}
                </p>
              </article>
            ))}
            {agents.length === 0 ? <div className="empty-state">No agents registered.</div> : null}
          </div>

          <div className="panel-header split-top">
            <h2>Plugins</h2>
            <span>{plugins.length}</span>
          </div>
          <div className="stack plugin-stack">
            {plugins.map((plugin) => {
              const pluginConfig = pluginConfigs.find((config) => config.pluginId === plugin.id) ?? null;
              return (
                <button
                  className={`task-card ${selectedPluginId === plugin.id ? "task-card-selected" : ""}`}
                  key={plugin.id}
                  onClick={() => setSelectedPluginId(plugin.id)}
                  type="button"
                >
                  <div className="card-head">
                    <h3>{plugin.id}</h3>
                    <span className={`badge ${plugin.health.healthy ? "status-done" : "status-failed"}`}>
                      {plugin.health.healthy ? "healthy" : "unhealthy"}
                    </span>
                  </div>
                  <p className="meta">
                    {plugin.kind} · priority {pluginConfig?.priority ?? plugin.priority}
                  </p>
                </button>
              );
            })}
            {plugins.length === 0 ? <div className="empty-state">No plugins registered.</div> : null}
          </div>
          <article className="detail-card plugin-detail-card">
            <div className="subpanel-header">
              <h3>Plugin Detail</h3>
              {selectedPlugin ? (
                <span className={`badge ${selectedPlugin.health.healthy ? "status-done" : "status-failed"}`}>
                  {selectedPlugin.health.healthy ? "healthy" : "unhealthy"}
                </span>
              ) : null}
            </div>
            {selectedPlugin ? (
              <>
                <p className="timeline-title">{selectedPlugin.id}</p>
                <p className="meta">
                  {selectedPlugin.kind} · enabled {selectedPluginConfig ? String(selectedPluginConfig.enabled) : "default"} · priority{" "}
                  {selectedPluginConfig?.priority ?? selectedPlugin.priority}
                </p>
                <p>{selectedPlugin.health.message}</p>
                {selectedPlugin.id === "meegle" ? (
                  <div className="config-block">
                    <div className="subpanel-header">
                      <p className="eyebrow compact">Meegle Authorization</p>
                      <span className={`badge ${meegleAuth.status === "authenticated" || selectedPlugin.health.healthy ? "status-done" : "status-failed"}`}>
                        {meegleAuth.status === "idle" ? (selectedPlugin.health.healthy ? "authenticated" : "required") : meegleAuth.status}
                      </span>
                    </div>
                    <p className="meta">
                      {meegleAuth.message || (selectedPlugin.health.healthy
                        ? "Meegle CLI is ready."
                        : "Authorize Meegle before polling work items or writing comments.")}
                    </p>
                    {!selectedPlugin.health.healthy && meegleAuth.status !== "authenticated" ? (
                      <button
                        className="primary-button"
                        disabled={meegleAuth.status === "starting" || meegleAuth.status === "pending"}
                        onClick={() => void startMeegleAuthorization()}
                        type="button"
                      >
                        {meegleAuth.status === "starting" || meegleAuth.status === "pending" ? "Authorizing Meegle..." : "Authorize Meegle"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <p className="mono">{selectedPlugin.capabilities.join(", ") || "no capabilities"}</p>
                <div className="detail-metrics plugin-metrics">
                  <Metric
                    label="Required Kind"
                    value={String(readiness?.checks.plugins.requiredKinds[selectedPlugin.kind] ?? false)}
                  />
                  <Metric label="Readiness" value={readiness?.checks.plugins.message ?? "unknown"} />
                </div>
                <div className="config-block">
                  <p className="eyebrow compact">Config JSON</p>
                  <pre className="config-pre">{JSON.stringify(selectedPluginConfig?.config ?? {}, null, 2)}</pre>
                </div>
              </>
            ) : (
              <p className="meta">No plugin selected.</p>
            )}
          </article>
        </section>
      </main>
    </div>
  );
}

function StatCard(props: { title: string; value: number; detail: string }) {
  return (
    <article className="stat-card">
      <p className="eyebrow">{props.title}</p>
      <strong>{props.value}</strong>
      <span>{props.detail}</span>
    </article>
  );
}

function Metric(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="metric">
      <span className="eyebrow compact">{props.label}</span>
      <strong className={props.mono ? "mono" : undefined}>{props.value}</strong>
    </div>
  );
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return "none";
  }
  return entries.map(([key, value]) => `${key}:${value}`).join(" · ");
}

function groupTasksByStatus(tasks: Task[]): Record<string, number> {
  return tasks.reduce<Record<string, number>>((result, task) => {
    result[task.status] = (result[task.status] ?? 0) + 1;
    return result;
  }, {});
}

function groupEventsByCategory(events: EventItem[]): Record<string, number> {
  return events.reduce<Record<string, number>>((result, event) => {
    const category = categorizeEventType(event.eventType);
    result[category] = (result[category] ?? 0) + 1;
    return result;
  }, {});
}

function groupExecutionLogsByCategory(logs: ExecutionLog[]): Record<string, number> {
  return logs.reduce<Record<string, number>>((result, log) => {
    const category = categorizeEventType(log.eventType);
    result[category] = (result[category] ?? 0) + 1;
    return result;
  }, {});
}

function buildStatusFilters(counts: Record<string, number>): Array<{ value: string; label: string; count: number }> {
  const orderedStatuses = ["all", "queued", "running", "evaluating", "repairing", "needs_human", "done", "failed", "blocked"];
  return orderedStatuses
    .map((status) => ({
      value: status,
      label: status === "all" ? "All" : status,
      count: status === "all" ? Object.values(counts).reduce((sum, value) => sum + value, 0) : counts[status] ?? 0
    }))
    .filter((item) => item.value === "all" || item.count > 0);
}

function buildEventCategoryFilters(counts: Record<string, number>): Array<{ value: EventCategory; label: string; count: number }> {
  const orderedCategories: EventCategory[] = [
    "all",
    "execution",
    "task",
    "goal",
    "eval",
    "scheduler",
    "agent",
    "plugin",
    "governance",
    "environment",
    "other"
  ];
  return orderedCategories
    .map((category) => ({
      value: category,
      label: category === "all" ? "All" : category,
      count: category === "all" ? Object.values(counts).reduce((sum, value) => sum + value, 0) : counts[category] ?? 0
    }))
    .filter((item) => item.value === "all" || item.count > 0);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function safeParseEvent(raw: string): EventItem {
  try {
    return JSON.parse(raw) as EventItem;
  } catch {
    return {
      id: `raw-${raw.length}`,
      eventType: "unknown",
      traceId: "unknown"
    };
  }
}

function classifyEventTone(eventType: string): "info" | "warn" | "success" | "danger" {
  if (eventType.includes("blocked") || eventType.includes("failed") || eventType.includes("needs_human")) {
    return "danger";
  }
  if (eventType.includes("retry") || eventType.includes("requeued") || eventType.includes("repair")) {
    return "warn";
  }
  if (eventType.includes("done") || eventType.includes("completed") || eventType.includes("healthy")) {
    return "success";
  }
  return "info";
}

function categorizeEventType(eventType: string): EventCategory {
  if (eventType.startsWith("task.")) {
    return "task";
  }
  if (eventType.startsWith("execution.") || eventType.startsWith("executor.")) {
    return "execution";
  }
  if (eventType.startsWith("goal.")) {
    return "goal";
  }
  if (eventType.startsWith("eval.")) {
    return "eval";
  }
  if (eventType.startsWith("scheduler.")) {
    return "scheduler";
  }
  if (eventType.startsWith("agent.")) {
    return "agent";
  }
  if (eventType.startsWith("plugin.")) {
    return "plugin";
  }
  if (eventType.startsWith("governance.")) {
    return "governance";
  }
  if (eventType.startsWith("environment.")) {
    return "environment";
  }
  return "other";
}

function matchesEventCategory(eventType: string, filter: EventCategory): boolean {
  return filter === "all" || categorizeEventType(eventType) === filter;
}

function formatEventLabel(eventType: string): string {
  return eventType.replaceAll(".", " / ");
}

function eventSummary(event: EventItem): string {
  const correlation = readObject(event.data?.correlation);
  const taskId = typeof correlation.taskId === "string" ? correlation.taskId : event.taskId;
  const executionId = typeof correlation.executionId === "string" ? correlation.executionId : undefined;
  return [taskId ?? event.traceId, executionId].filter(Boolean).join(" · ");
}

function renderExecutionLogContext(log: ExecutionLog) {
  const attempt = log.data.attempt;
  const retryLimit = log.data.retryLimit;
  const stopReason = log.data.stopReason;
  const errorCategory = log.data.errorCategory;
  const timeoutCategory = log.data.timeoutCategory;
  const parts = [
    typeof attempt === "number" && typeof retryLimit === "number" ? `attempt ${attempt}/${retryLimit}` : null,
    typeof stopReason === "string" ? stopReason : null,
    typeof errorCategory === "string" && errorCategory !== "none" ? errorCategory : null,
    typeof timeoutCategory === "string" && timeoutCategory !== "none" ? timeoutCategory : null
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? <p className="mono event-context">{parts.join(" · ")}</p> : null;
}

function summarizeExecutionState(
  task: Task | null,
  details: TaskDetails,
  events: EventItem[]
): {
  tone: "neutral" | "warn" | "danger" | "success";
  headline: string;
  detail: string;
} {
  const latestRetryEvent = events.find((event) => event.eventType === "execution.retry_scheduled" || event.eventType === "environment.retry_scheduled");
  const latestBlockEvent = events.find((event) => event.eventType === "execution.blocked" || event.eventType === "environment.blocked");
  const latestRetryLog = details.observability.executionLogs.find(
    (log) => log.eventType === "execution.retry_scheduled" || log.eventType === "environment.retry_scheduled"
  );
  const latestBlockLog = details.observability.executionLogs.find(
    (log) => log.eventType === "execution.blocked" || log.eventType === "environment.blocked"
  );
  const latestDone = details.transitions.find((transition) => transition.to === "done");
  const latestEval = details.evalResults[0];

  if (task?.status === "done" && latestDone) {
    return {
      tone: "success",
      headline: "Task completed the controller loop.",
      detail: latestEval ? `Latest eval passed with score ${latestEval.score}.` : "Execution finished successfully."
    };
  }
  if (latestBlockEvent || latestBlockLog) {
    const payload = latestBlockEvent?.data ?? latestBlockLog?.data;
    return {
      tone: "danger",
      headline: "Automatic retry stopped and the task was blocked.",
      detail: buildRetryDetail(payload)
    };
  }
  if (latestRetryEvent || latestRetryLog) {
    const payload = latestRetryEvent?.data ?? latestRetryLog?.data;
    return {
      tone: "warn",
      headline: "Controller scheduled another automatic retry.",
      detail: buildRetryDetail(payload)
    };
  }
  if (task?.status === "repairing" || task?.status === "evaluating") {
    return {
      tone: "warn",
      headline: "Task is still converging through Goal Loop.",
      detail: latestEval ? `Latest eval score ${latestEval.score} with ${latestEval.riskLevel} risk.` : "Awaiting next evaluation result."
    };
  }
  return {
    tone: "neutral",
    headline: "No execution retry signal has been emitted.",
    detail: "The task has not produced timeout, launch-error, or block events in the current live window."
  };
}

function buildRetryDetail(data: Record<string, unknown> | undefined): string {
  const payload = readObject(data);
  const attempt = typeof payload.attempt === "number" ? payload.attempt : null;
  const retryLimit = typeof payload.retryLimit === "number" ? payload.retryLimit : null;
  const errorCategory = typeof payload.errorCategory === "string" ? payload.errorCategory : null;
  const timeoutCategory = typeof payload.timeoutCategory === "string" ? payload.timeoutCategory : null;
  const stage = typeof payload.stage === "string" ? payload.stage : null;
  const summary = [stage, errorCategory && errorCategory !== "none" ? errorCategory : null, timeoutCategory && timeoutCategory !== "none" ? timeoutCategory : null]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  if (attempt !== null && retryLimit !== null) {
    return `${summary || "retry budget"} · attempt ${attempt}/${retryLimit}`;
  }
  return summary || "Retry metadata unavailable.";
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
