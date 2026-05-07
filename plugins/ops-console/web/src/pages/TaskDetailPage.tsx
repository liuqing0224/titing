import { useEffect, useState } from "react";
import { connectEvents } from "../api/events";
import { listTaskLogs, retryTask, updateTaskExecutionFields } from "../api/tasks";
import { ExecutionLog, Task } from "../api/types";
import { ExecutionLogTimeline } from "../components/ExecutionLogTimeline";
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
  const [detailLogs, setDetailLogs] = useState<ExecutionLog[] | null>(null);
  const [logs, setLogs] = useState<ExecutionLog[] | null>(null);
  const [logLoadError, setLogLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetailLogs(null);
    setLogLoadError(null);

    void listTaskLogs(task.id)
      .then((nextLogs) => {
        if (!cancelled) {
          setDetailLogs(nextLogs);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLogLoadError(error instanceof Error ? error.message : "日志加载失败");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [task.id]);

  useEffect(() => {
    let refreshing = false;

    const reloadLogs = () => {
      if (refreshing) {
        return;
      }

      refreshing = true;
      void listTaskLogs(task.id)
        .then((nextLogs) => {
          setDetailLogs(nextLogs);
          setLogLoadError(null);
        })
        .catch((error: unknown) => {
          setLogLoadError(error instanceof Error ? error.message : "日志加载失败");
        })
        .finally(() => {
          refreshing = false;
        });
    };

    return connectEvents({
      refreshAll: () => undefined,
      onExecutionLog: (event) => {
        if (event.taskId === task.id) {
          reloadLogs();
        }
      }
    });
  }, [task.id]);

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
            setDetailLogs(await listTaskLogs(taskId));
          }}
          onSaveExecutionFields={async (taskId, input) => {
            await updateTaskExecutionFields(taskId, input);
            await refreshAll();
            setDetailLogs(await listTaskLogs(taskId));
          }}
        />
      </section>

      <div className="layout-split detail-split">
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
              <dt>Retry Count</dt>
              <dd>{task.retryCount}</dd>
            </div>
            <div>
              <dt>Agent ID</dt>
              <dd>{task.agentId ?? "-"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{task.status}</dd>
            </div>
          </dl>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">TASK PROMPT</p>
              <h3>执行指令</h3>
            </div>
          </div>
          <div className="text-panel">{task.instruction ?? "暂无执行指令"}</div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">EXECUTION LOGS</p>
            <h3>执行历史</h3>
          </div>
        </div>
        {detailLogs ? (
          <ExecutionLogTimeline logs={detailLogs} emptyText="当前任务还没有执行日志" />
        ) : logLoadError ? (
          <p className="muted-copy">执行日志加载失败：{logLoadError}</p>
        ) : (
          <p className="muted-copy">正在加载执行日志...</p>
        )}
      </section>
      {logs ? <ExecutionLogModal logs={logs} onClose={() => setLogs(null)} /> : null}
    </div>
  );
}
