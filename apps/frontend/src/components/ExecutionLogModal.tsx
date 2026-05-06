import { ExecutionLog } from "../api/types";
import { formatShanghaiTime } from "../utils/time";

type ExecutionLogModalProps = {
  logs: ExecutionLog[];
  onClose: () => void;
};

export function ExecutionLogModal({ logs, onClose }: ExecutionLogModalProps) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Execution logs">
      <div className="modal">
        <div className="panel-header">
          <div>
            <p className="eyebrow">EXECUTION LOGS</p>
            <h2>ExecutionLog</h2>
          </div>
          <button className="ghost-button" onClick={onClose} type="button">
            关闭
          </button>
        </div>
        {logs.length === 0 ? (
          <p className="muted-copy">暂无日志</p>
        ) : (
          <ol className="timeline">
            {logs.map((log) => (
              <li className="timeline-item" key={log.id}>
                <div className="timeline-topline">
                  <strong>{log.status}</strong>
                  <small>{formatShanghaiTime(log.createdAt)}</small>
                </div>
                <p>{log.message}</p>
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
