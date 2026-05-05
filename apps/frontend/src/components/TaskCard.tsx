import { FormEvent, useState } from "react";
import { Task } from "../api/types";

type TaskCardProps = {
  task: Task;
  onViewLogs: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onSaveExecutionFields: (
    taskId: string,
    input: { repo: string; branch: string; instruction: string }
  ) => void;
};

export function TaskCard({
  task,
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
    <article className="card">
      <div className="row">
        <h3>{task.title}</h3>
        <span className={`badge ${task.status}`}>{task.status}</span>
      </div>
      <p>{task.description ?? "无描述"}</p>
      <p>
        {task.repo} · {task.branch}
      </p>
      <p>
        externalId: {task.externalId ?? "-"} · priority: {task.priority} · type: {task.taskType}
      </p>
      <p>
        agentId: {task.agentId ?? "-"} · retryCount: {task.retryCount} · updatedAt: {task.updatedAt}
      </p>
      <div className="actions">
        <button onClick={() => onViewLogs(task.id)}>查看日志</button>
        {canEdit ? <button onClick={() => setEditing((value) => !value)}>编辑执行字段</button> : null}
        {task.status === "failed" ? <button onClick={() => onRetry(task.id)}>重试</button> : null}
      </div>
      {editing ? (
        <form className="edit-form" onSubmit={handleSubmit}>
          <label>
            repo
            <input value={repo} onChange={(event) => setRepo(event.target.value)} />
          </label>
          <label>
            branch
            <input value={branch} onChange={(event) => setBranch(event.target.value)} />
          </label>
          <label>
            instruction
            <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} />
          </label>
          <button type="submit">保存</button>
        </form>
      ) : null}
    </article>
  );
}
