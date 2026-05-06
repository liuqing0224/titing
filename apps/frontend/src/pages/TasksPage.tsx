import { useState } from "react";
import { listTaskLogs, retryTask, updateTaskExecutionFields } from "../api/tasks";
import { ExecutionLog, Task, TaskPriority, TaskStatus } from "../api/types";
import { ExecutionLogModal } from "../components/ExecutionLogModal";
import { TaskCard } from "../components/TaskCard";

type TasksPageProps = {
  tasks: Task[];
  refreshAll: () => Promise<void>;
  onOpenTask: (taskId: string) => void;
};

const STATUSES: Array<"" | TaskStatus> = ["", "pending", "queued", "running", "done", "failed"];
const PRIORITIES: Array<"" | TaskPriority> = ["", "high", "medium", "low"];

export function TasksPage({ tasks, refreshAll, onOpenTask }: TasksPageProps) {
  const [status, setStatus] = useState<"" | TaskStatus>("");
  const [priority, setPriority] = useState<"" | TaskPriority>("");
  const [logs, setLogs] = useState<ExecutionLog[] | null>(null);

  const filteredTasks = tasks.filter((task) => {
    return (!status || task.status === status) && (!priority || task.priority === priority);
  });

  return (
    <div className="page-stack">
      <section className="hero-panel compact">
        <div>
          <p className="eyebrow">TASK OPERATIONS</p>
          <h3>任务列表</h3>
          <p className="hero-copy">
            用状态和优先级快速切片任务池，把查看日志、编辑执行字段和失败重试收敛到同一张卡片。
          </p>
        </div>
        <button className="ghost-button" onClick={() => void refreshAll()} type="button">
          重新拉取
        </button>
      </section>

      <section className="panel">
        <div className="filters filter-bar">
          <label className="field">
            <span>status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as "" | TaskStatus)}>
              {STATUSES.map((value) => (
                <option key={value || "all"} value={value}>
                  {value || "all"}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>priority</span>
            <select value={priority} onChange={(event) => setPriority(event.target.value as "" | TaskPriority)}>
              {PRIORITIES.map((value) => (
                <option key={value || "all"} value={value}>
                  {value || "all"}
                </option>
              ))}
            </select>
          </label>
          <div className="filter-summary-block">
            <div className="filter-summary">
              <span className="terminal-chip">{filteredTasks.length} visible</span>
            </div>
            <p className="muted-copy">先筛出任务集合，再进入单条详情做日志、编辑和重试。</p>
          </div>
        </div>
      </section>

      <section className="list">
        {filteredTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onOpenDetail={onOpenTask}
            onViewLogs={async (taskId) => setLogs(await listTaskLogs(taskId))}
            onRetry={async (taskId) => {
              await retryTask(taskId);
              await refreshAll();
            }}
            onSaveExecutionFields={async (taskId, input) => {
              await updateTaskExecutionFields(taskId, input);
              await refreshAll();
            }}
          />
        ))}
        {filteredTasks.length === 0 ? <article className="panel muted-copy">没有符合当前筛选条件的任务。</article> : null}
      </section>
      {logs ? <ExecutionLogModal logs={logs} onClose={() => setLogs(null)} /> : null}
    </div>
  );
}
