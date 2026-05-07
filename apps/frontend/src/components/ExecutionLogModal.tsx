import { ExecutionLog } from "../api/types";
import { ExecutionLogTimeline } from "./ExecutionLogTimeline";

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
        <ExecutionLogTimeline logs={logs} />
      </div>
    </div>
  );
}
