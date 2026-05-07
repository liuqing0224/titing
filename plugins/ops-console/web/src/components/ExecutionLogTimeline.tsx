import { ExecutionLog } from "../api/types";
import { formatShanghaiTime } from "../utils/time";

type ExecutionLogTimelineProps = {
  logs: ExecutionLog[];
  emptyText?: string;
};

export function ExecutionLogTimeline({
  logs,
  emptyText = "暂无日志"
}: ExecutionLogTimelineProps) {
  if (logs.length === 0) {
    return <p className="muted-copy">{emptyText}</p>;
  }

  return (
    <ol className="timeline">
      {logs.map((log) => {
        const stdout = typeof log.metadata?.stdout === "string" ? log.metadata.stdout : null;
        const stderr = typeof log.metadata?.stderr === "string" ? log.metadata.stderr : null;
        const summaryEntries = Object.entries(log.metadata ?? {}).filter(
          ([key, value]) =>
            !["stdout", "stderr"].includes(key) && value !== null && value !== undefined && value !== ""
        );

        return (
          <li className="timeline-item" key={log.id}>
            <div className="timeline-topline">
              <strong>{log.status}</strong>
              <small>{formatShanghaiTime(log.createdAt)}</small>
            </div>
            <p>{log.message}</p>
            {summaryEntries.length > 0 ? (
              <dl className="log-meta-grid">
                {summaryEntries.map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{formatMetadataValue(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {stdout ? (
              <details open>
                <summary>stdout</summary>
                <pre>{stdout}</pre>
              </details>
            ) : null}
            {stderr ? (
              <details open={Boolean(!stdout)}>
                <summary>stderr</summary>
                <pre>{stderr}</pre>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
