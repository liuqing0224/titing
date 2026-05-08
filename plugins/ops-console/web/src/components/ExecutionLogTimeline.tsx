import { useState } from "react";
import { ExecutionLog } from "../api/types";
import {
  formatMetadataPrimitive,
  formatStreamSummary,
  inferFailureHint,
  labelMetadataKey,
  normalizeStreamText,
  orderMetadataEntries,
  previewStream,
  shouldTruncateStream,
  statusTone
} from "../utils/executionLogView";
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
      {logs.map((log) => (
        <ExecutionLogEntry key={log.id} log={log} />
      ))}
    </ol>
  );
}

function ExecutionLogEntry({ log }: { log: ExecutionLog }) {
  const meta = log.metadata ?? {};
  const rawStdout = typeof meta.stdout === "string" ? meta.stdout : null;
  const rawStderr = typeof meta.stderr === "string" ? meta.stderr : null;
  const stdout = rawStdout ? normalizeStreamText(rawStdout, "stdout") : null;
  const stderr = rawStderr ? normalizeStreamText(rawStderr, "stderr") : null;
  const summaryEntries = orderMetadataEntries(meta as Record<string, unknown>);
  const tone = statusTone(log.status);
  const hint = inferFailureHint(rawStderr, log.status);

  return (
    <li className={`timeline-item log-entry log-entry--${tone}`}>
      <div className="timeline-topline">
        <span className={`log-status-pill log-status-pill--${tone}`}>{log.status}</span>
        <small>{formatShanghaiTime(log.createdAt)}</small>
      </div>
      <p className="log-entry-message">{log.message}</p>
      {hint ? (
        <div className="log-failure-hint" role="status">
          <strong>原因摘要</strong>
          <p>{hint}</p>
        </div>
      ) : null}
      {summaryEntries.length > 0 ? (
        <dl className="log-meta-grid">
          {summaryEntries.map(([key, value]) => (
            <div key={key}>
              <dt title={key}>{labelMetadataKey(key)}</dt>
              <dd>{formatMetadataPrimitive(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {stdout ? <StreamBlock kind="stdout" text={stdout} /> : null}
      {stderr ? <StreamBlock kind="stderr" text={stderr} defaultOpen={!stdout} /> : null}
    </li>
  );
}

function StreamBlock({
  kind,
  text,
  defaultOpen
}: {
  kind: "stdout" | "stderr";
  text: string;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const truncated = shouldTruncateStream(text);
  const display = expanded || !truncated ? text : previewStream(text);
  const label = kind === "stdout" ? "标准输出 (stdout)" : "标准错误 (stderr)";
  const openByDefault = defaultOpen !== false && text.length < 4000;

  return (
    <details className={`log-output log-output--${kind}`} open={openByDefault}>
      <summary>
        {label}
        <span className="log-output-meta">{formatStreamSummary(text)}</span>
        {truncated ? (
          <span className="log-output-meta"> · 内容较长，默认折叠尾部</span>
        ) : null}
      </summary>
      <pre>{display}</pre>
      {truncated && !expanded ? (
        <button
          type="button"
          className="log-output-expand"
          onClick={() => setExpanded(true)}
        >
          展开全文（{text.length.toLocaleString()} 字符）
        </button>
      ) : null}
    </details>
  );
}
