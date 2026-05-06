import { useState } from "react";
import { listTaskLogs, retryTask, updateTaskExecutionFields } from "../api/tasks";
import { ExecutionLog, Task } from "../api/types";
import { ExecutionLogModal } from "../components/ExecutionLogModal";
import { TaskCard } from "../components/TaskCard";
import { formatShanghaiTime } from "../utils/time";

type TaskDetailPageProps = {
  task: Task;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
  refreshAll: () => Promise<void>;
};

export function TaskDetailPage({ task, onBack, onOpenTask, refreshAll }: TaskDetailPageProps) {
  const [logs, setLogs] = useState<ExecutionLog[] | null>(null);

  return (
    <div className="page-stack">
      <section className="hero-panel compact">
        <div>
          <p className="eyebrow">TASK DETAIL</p>
          <h3>{task.title}</h3>
          <p className="hero-copy">
            任务 ID {task.id} · 创建于 {formatShanghaiTime(task.createdAt)}
          </p>
        </div>
        <button className="ghost-button" onClick={onBack} type="button">
          返回任务列表
        </button>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">TASK SUMMARY</p>
            <h3>执行详情</h3>
          </div>
          <span className="terminal-chip">{task.status}</span>
        </div>
        <TaskCard
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
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">EXECUTION CONTEXT</p>
            <h3>补充信息</h3>
          </div>
        </div>
        <dl className="meta-grid">
          <div>
            <dt>External ID</dt>
            <dd>{task.externalId ?? "-"}</dd>
          </div>
          <div>
            <dt>Instruction</dt>
            <dd>{task.instruction ?? "-"}</dd>
          </div>
          <div>
            <dt>Retry Count</dt>
            <dd>{task.retryCount}</dd>
          </div>
          <div>
            <dt>Agent ID</dt>
            <dd>{task.agentId ?? "-"}</dd>
          </div>
        </dl>
      </section>
      {logs ? <ExecutionLogModal logs={logs} onClose={() => setLogs(null)} /> : null}
    </div>
  );
}
