import { useState } from "react";
import { listTaskLogs, retryTask, updateTaskExecutionFields } from "../api/tasks";
import { ExecutionLog, Task, TaskPriority, TaskStatus } from "../api/types";
import { ExecutionLogModal } from "../components/ExecutionLogModal";
import { TaskCard } from "../components/TaskCard";

type TasksPageProps = {
  tasks: Task[];
  refreshAll: () => Promise<void>;
};

const STATUSES: Array<"" | TaskStatus> = ["", "pending", "queued", "running", "done", "failed"];
const PRIORITIES: Array<"" | TaskPriority> = ["", "high", "medium", "low"];

export function TasksPage({ tasks, refreshAll }: TasksPageProps) {
  const [status, setStatus] = useState<"" | TaskStatus>("");
  const [priority, setPriority] = useState<"" | TaskPriority>("");
  const [logs, setLogs] = useState<ExecutionLog[] | null>(null);

  const filteredTasks = tasks.filter((task) => {
    return (!status || task.status === status) && (!priority || task.priority === priority);
  });

  return (
    <main>
      <h2>任务列表</h2>
      <div className="filters">
        <label>
          status
          <select value={status} onChange={(event) => setStatus(event.target.value as "" | TaskStatus)}>
            {STATUSES.map((value) => (
              <option key={value || "all"} value={value}>
                {value || "all"}
              </option>
            ))}
          </select>
        </label>
        <label>
          priority
          <select value={priority} onChange={(event) => setPriority(event.target.value as "" | TaskPriority)}>
            {PRIORITIES.map((value) => (
              <option key={value || "all"} value={value}>
                {value || "all"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="list">
        {filteredTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
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
      </section>
      {logs ? <ExecutionLogModal logs={logs} onClose={() => setLogs(null)} /> : null}
    </main>
  );
}
