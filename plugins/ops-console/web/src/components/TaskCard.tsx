import { FormEvent, useState } from "react";
import { Task } from "../api/types";
import { formatShanghaiTime } from "../utils/time";

type TaskCardProps = {
  task: Task;
  onOpenDetail: (taskId: string) => void;
  onViewLogs: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onSaveExecutionFields: (
    taskId: string,
    input: { repo: string; branch: string; instruction: string }
  ) => void;
};

export function TaskCard({
  task,
  onOpenDetail,
  onViewLogs,
  onRetry,
  onSaveExecutionFields
}: TaskCardProps) {
  const [editing, setEditing] = useState(false);
  const [repo, setRepo] = useState(task.repo);
  const [branch, setBranch] = useState(task.branch);
  const [instruction, setInstruction] = useState(task.instruction ?? "");
  const canEdit = ["pending", "queued", "failed"].includes(task.status);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSaveExecutionFields(task.id, { repo, branch, instruction });
    setEditing(false);
  };

  return (
    <article className="card task-card">
      <div className="card-topline">
        <span className="eyebrow">TASK {task.externalId ?? task.id}</span>
        <span className={`badge ${task.status}`}>{task.status}</span>
      </div>

      <div className="card-header">
        <div>
          <button className="card-title-button" onClick={() => onOpenDetail(task.id)} type="button">
            <h3>{task.title}</h3>
          </button>
          <p className="muted-copy">{task.description ?? "无描述"}</p>
        </div>
      </div>

      <dl className="meta-grid">
        <div>
          <dt>Repo</dt>
          <dd>{task.repo}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{task.branch}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{task.priority}</dd>
        </div>
        <div>
          <dt>Task ID</dt>
          <dd>{task.id}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{task.taskType}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{task.agentId ?? "-"}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatShanghaiTime(task.createdAt)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatShanghaiTime(task.updatedAt)}</dd>
        </div>
      </dl>

      <div className="actions">
        <button className="ghost-button" onClick={() => onOpenDetail(task.id)} type="button">
          查看详情
        </button>
        <button className="ghost-button" onClick={() => onViewLogs(task.id)} type="button">
          查看日志
        </button>
        {canEdit ? (
          <button className="ghost-button" onClick={() => setEditing((value) => !value)} type="button">
            {editing ? "收起编辑" : "编辑执行字段"}
          </button>
        ) : null}
        {task.status === "failed" ? (
          <button className="primary-button" onClick={() => onRetry(task.id)} type="button">
            重试
          </button>
        ) : null}
      </div>

      {editing ? (
        <form className="edit-form" onSubmit={handleSubmit}>
          <label className="field">
            <span>repo</span>
            <input value={repo} onChange={(event) => setRepo(event.target.value)} />
          </label>
          <label className="field">
            <span>branch</span>
            <input value={branch} onChange={(event) => setBranch(event.target.value)} />
          </label>
          <label className="field">
            <span>instruction</span>
            <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} />
          </label>
          <button className="primary-button" type="submit">
            保存
          </button>
        </form>
      ) : null}
    </article>
  );
}
