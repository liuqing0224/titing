/** 将 execution log metadata 的 key 转为简短中文说明，便于扫读 */
const METADATA_LABELS: Record<string, string> = {
  executionEngine: "执行引擎",
  executionEngineRunnerClass: "运行器",
  stage: "阶段",
  exitCode: "退出码",
  timedOut: "是否超时",
  normalExit: "正常结束",
  branchCheckedOut: "分支已检出",
  codexStarted: "已进入主执行",
  repo: "仓库",
  branch: "分支",
  cloneUrl: "克隆地址",
  repoRoot: "仓库根目录",
  worktreePath: "Worktree",
  agentsMdPath: "AGENTS.md",
  workflowPromptsPath: "WORKFLOW_PROMPTS",
  node: "工作流节点",
  iteration: "迭代",
  loopCount: "循环次数",
  stream: "输出流",
  stdoutLength: "stdout 长度",
  stderrLength: "stderr 长度"
};

/** 优先展示的字段顺序（其余按字母序排在后面） */
const METADATA_KEY_PRIORITY: string[] = [
  "executionEngine",
  "executionEngineRunnerClass",
  "stage",
  "exitCode",
  "timedOut",
  "normalExit",
  "branchCheckedOut",
  "codexStarted",
  "branch",
  "repo",
  "cloneUrl",
  "worktreePath",
  "repoRoot",
  "agentsMdPath",
  "workflowPromptsPath",
  "node",
  "iteration",
  "loopCount",
  "stream",
  "stdoutLength",
  "stderrLength"
];

const STREAM_BODY_KEYS = new Set(["stdout", "stderr"]);

export function labelMetadataKey(key: string): string {
  return METADATA_LABELS[key] ?? key;
}

export function orderMetadataEntries(metadata: Record<string, unknown>): Array<[string, unknown]> {
  const entries = Object.entries(metadata).filter(
    ([key, value]) =>
      !STREAM_BODY_KEYS.has(key) && value !== null && value !== undefined && value !== ""
  );
  const pri = new Map(METADATA_KEY_PRIORITY.map((k, i) => [k, i]));
  return entries.sort(([a], [b]) => {
    const ia = pri.get(a);
    const ib = pri.get(b);
    if (ia !== undefined && ib !== undefined) {
      return ia - ib;
    }
    if (ia !== undefined) {
      return -1;
    }
    if (ib !== undefined) {
      return 1;
    }
    return a.localeCompare(b);
  });
}

/** 去掉编排层包的一层前缀，便于阅读 */
export function normalizeStreamText(text: string, kind: "stdout" | "stderr"): string {
  const trimmed = text.trimStart();
  const prefix = kind === "stderr" ? "execute stderr:" : "execute stdout:";
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length).replace(/^\s*\n/, "");
  }
  return text;
}

export function streamByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function formatStreamSummary(text: string): string {
  const lines = text.split(/\r?\n/).length;
  const bytes = streamByteLength(text);
  return `${lines} 行 · 约 ${bytes} 字节`;
}

const PREVIEW_CHARS = 6000;

export function shouldTruncateStream(text: string): boolean {
  return text.length > PREVIEW_CHARS;
}

export function previewStream(text: string): string {
  if (!shouldTruncateStream(text)) {
    return text;
  }
  return text.slice(0, PREVIEW_CHARS);
}

/** 从 stderr 里抽一行可读摘要（失败卡片用） */
export function inferFailureHint(stderr: string | null, status: string): string | null {
  if (status !== "failed" || !stderr) {
    return null;
  }
  const body = normalizeStreamText(stderr, "stderr");
  const auth = /Authentication required|CURSOR_API_KEY|cursor agent login/i;
  if (auth.test(body)) {
    return "Cursor CLI 需要鉴权：请在运行后端的环境执行 `cursor agent login`，或配置环境变量 `CURSOR_API_KEY`。";
  }
  const m = body.match(/(?:^|\n)(Error:\s*.+?)(?:\n|$)/i);
  if (m?.[1]) {
    return m[1].trim();
  }
  const first = body.split(/\r?\n/).find((l) => l.trim().length > 0);
  return first ? first.trim().slice(0, 280) : null;
}

export function formatMetadataPrimitive(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

export function statusTone(status: string): "failed" | "running" | "queued" | "done" | "neutral" {
  const s = status.toLowerCase();
  if (s === "failed") {
    return "failed";
  }
  if (s === "running") {
    return "running";
  }
  if (s === "queued" || s === "pending") {
    return "queued";
  }
  if (s === "done") {
    return "done";
  }
  return "neutral";
}
