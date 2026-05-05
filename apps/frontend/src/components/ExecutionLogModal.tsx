import { ExecutionLog } from "../api/types";

type ExecutionLogModalProps = {
  logs: ExecutionLog[];
  onClose: () => void;
};

export function ExecutionLogModal({ logs, onClose }: ExecutionLogModalProps) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Execution logs">
      <div className="modal">
        <div className="row">
          <h2>ExecutionLog</h2>
          <button onClick={onClose}>关闭</button>
        </div>
        {logs.length === 0 ? (
          <p>暂无日志</p>
        ) : (
          <ol className="timeline">
            {logs.map((log) => (
              <li key={log.id}>
                <strong>{log.status}</strong>
                <p>{log.message}</p>
                <small>{log.createdAt}</small>
                {log.metadata ? (
                  <details>
                    <summary>metadata</summary>
                    <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
