import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  EvalResult,
  ExecutionResult,
  GovernanceRecord,
  NeedsHumanPayload,
  PreparedWorkspace,
  QualityResult,
  TitingTask
} from "@titing/plugin-api";

/**
 * Cross-cutting helpers for built-in plugins: subprocess/git/npm I/O, governance scans, quality heuristics,
 * executor log parsing, and Meegle CLI `--envelope` JSON normalization.
 */

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  summary: string;
  timedOut: boolean;
};

/** Limits applied by governance (command allow/block, prompt/output size, diff caps). */
export type GovernancePolicy = {
  allowCommandPrefixes: string[];
  blockCommandPatterns: string[];
  maxPromptChars: number;
  maxOutputChars: number;
  maxFilesChanged: number;
  maxDiffLines: number;
};

/** Redaction regexes mirrored in governance `redact()` / CLI output scrubbing; keep aligned with {@link scanSecrets}. */
export const SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /sk-[A-Za-z0-9]{20,}/g, replacement: "[redacted-secret]" },
  { regex: /ghp_[A-Za-z0-9]{20,}/g, replacement: "[redacted-secret]" },
  { regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "[redacted-secret]" },
  { regex: /(api[_-]?key\s*[=:]\s*)([^\s]+)/gi, replacement: "$1[redacted-secret]" },
  { regex: /(authorization:\s*bearer\s+)([^\s]+)/gi, replacement: "$1[redacted-secret]" }
];

/** Thrown from {@link runCheckedCommand} stages; carries retry hint for transient network/git failures. */
export class EnvironmentPreparationError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly detail: string,
    readonly retryable: boolean
  ) {
    super(`${stage}: ${message}${detail ? ` (${detail})` : ""}`);
    this.name = "EnvironmentPreparationError";
  }
}

/** Spawns `bin` under `cwd` with merged env; SIGKILL on timeout (`exitCode` 124) and bounded stdout/stderr collection. */
export function runCommand(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  envOverrides: Record<string, string> = {}
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...envOverrides } });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolveResult({
        exitCode: 124,
        stdout,
        stderr,
        summary: "Execution timed out",
        timedOut: true
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        exitCode: 127,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        summary: `Failed to launch ${basename(bin)}`,
        timedOut: false
      });
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        summary: exitCode === 0 ? "Execution completed" : "Execution failed",
        timedOut: false
      });
    });
  });
}

/** Wraps {@link runCommand}; non-zero exit → {@link EnvironmentPreparationError} tagged with logical `stage`. */
export async function runCheckedCommand(
  bin: string,
  args: string[],
  cwd: string,
  envOverrides: NodeJS.ProcessEnv,
  timeoutMs: number,
  stage: string
): Promise<void> {
  const result = await runCommand(bin, args, cwd, timeoutMs, stringifyEnv(envOverrides));
  if (result.exitCode !== 0) {
    throw new EnvironmentPreparationError(
      stage,
      result.summary,
      result.stderr || result.stdout,
      isRetryableEnvironmentStage(stage)
    );
  }
}

/** Resolves a local branch name inside a bare `--git-dir` mirror to origin/HEAD ref when present. */
export async function resolveBranchRef(cachePath: string, branch: string, timeoutMs: number): Promise<string> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  const localRef = `refs/heads/${branch}`;
  if (await gitRefExists(cachePath, remoteRef, timeoutMs)) {
    return remoteRef;
  }
  if (await gitRefExists(cachePath, localRef, timeoutMs)) {
    return localRef;
  }
  throw new EnvironmentPreparationError("checkout", `Branch ${branch} not found`, branch, false);
}

/** True when `git show-ref --verify ref` succeeds on the mirror. */
async function gitRefExists(cachePath: string, ref: string, timeoutMs: number): Promise<boolean> {
  const result = await runCommand("git", ["--git-dir", cachePath, "show-ref", "--verify", "--quiet", ref], cachePath, timeoutMs);
  return result.exitCode === 0;
}

/** Runs `npm install` in repo when package.json exists; honors workspace env overlays. */
export async function installDependenciesIfNeeded(
  repoPath: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<void> {
  if (!(await pathExists(join(repoPath, "package.json")))) {
    return;
  }
  const installCommand = await selectInstallCommand(repoPath);
  await runCheckedCommand(installCommand.bin, installCommand.args, repoPath, { ...process.env, ...env }, timeoutMs, "install");
}

/** Prefers npm when lockfile heuristics trigger (currently always npm). */
async function selectInstallCommand(repoPath: string): Promise<{ bin: string; args: string[] }> {
  if (await pathExists(join(repoPath, "package-lock.json"))) {
    return { bin: "npm", args: ["install"] };
  }
  return { bin: "npm", args: ["install"] };
}

/**
 * Executes well-known npm scripts when defined (lint/typecheck/test/build); missing scripts count as skipped passes.
 */
export async function runQualityScripts(workspace: PreparedWorkspace, timeoutMs: number) {
  const scripts = await readPackageScripts(workspace.repoPath);
  const scriptPlan = [
    { name: "lint", script: "lint" },
    { name: "typecheck", script: "typecheck" },
    { name: "unit-test", script: "test" },
    { name: "build", script: "build" }
  ];

  const results: Array<{ name: string; script: string; passed: boolean; detail: string; skipped: boolean }> = [];
  for (const item of scriptPlan) {
    if (!scripts[item.script]) {
      results.push({
        name: item.name,
        script: item.script,
        passed: true,
        detail: `Skipped: script "${item.script}" not defined`,
        skipped: true
      });
      continue;
    }

    const result = await runCommand("npm", ["run", item.script], workspace.repoPath, timeoutMs, workspace.env);
    results.push({
      name: item.name,
      script: item.script,
      passed: result.exitCode === 0,
      detail: result.exitCode === 0 ? `Passed via npm run ${item.script}` : `Failed via npm run ${item.script}: ${result.summary}`,
      skipped: false
    });
  }

  return results;
}

/** Builds diff stat + Porcelain short status count against `HEAD` for churn-aware quality scoring. */
export async function collectDiffRisk(workspace: PreparedWorkspace, timeoutMs: number) {
  const diffStat = await runCommand(
    "git",
    ["-C", workspace.repoPath, "diff", "--shortstat", "--find-renames", "HEAD"],
    workspace.repoPath,
    timeoutMs,
    workspace.env
  );
  const changedFiles = await runCommand(
    "git",
    ["-C", workspace.repoPath, "status", "--short"],
    workspace.repoPath,
    timeoutMs,
    workspace.env
  );
  const match = diffStat.stdout.match(/(\d+)\s+files? changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
  const filesChanged = changedFiles.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
  return {
    filesChanged,
    insertions: match?.[2] ? Number(match[2]) : 0,
    deletions: match?.[3] ? Number(match[3]) : 0,
    summary: diffStat.stdout.trim() || "No diff"
  };
}

/** Elevates risk on executor timeout, failed non-skipped checks, file count/churn thresholds. */
export function deriveRiskLevel(
  diffReport: { filesChanged: number; insertions: number; deletions: number },
  checks: Array<{ passed: boolean; skipped: boolean }>,
  timedOut: boolean
): QualityResult["riskLevel"] {
  if (timedOut || checks.some((check) => !check.passed && !check.skipped)) {
    return "high";
  }
  const churn = diffReport.insertions + diffReport.deletions;
  if (diffReport.filesChanged > 20 || churn > 400) {
    return "high";
  }
  if (diffReport.filesChanged > 8 || churn > 120) {
    return "medium";
  }
  return "low";
}

/** Weighted heuristic 0–100 from exit code + per-script passes + {@link deriveRiskLevel} adjustments. */
export function calculateQualityScore(
  exitCodePassed: boolean,
  checks: Array<{ passed: boolean; skipped: boolean }>,
  riskLevel: QualityResult["riskLevel"]
): number {
  let score = exitCodePassed ? 40 : 0;
  for (const check of checks) {
    if (check.skipped) {
      score += 5;
      continue;
    }
    score += check.passed ? 15 : 0;
  }
  if (riskLevel === "medium") {
    score -= 10;
  }
  if (riskLevel === "high") {
    score -= 30;
  }
  return Math.max(0, Math.min(100, score));
}

/** Reads `"scripts"` map from package.json; empty when file missing/unreadable. */
async function readPackageScripts(repoPath: string): Promise<Record<string, string>> {
  const packageJsonPath = join(repoPath, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return {};
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  return packageJson.scripts ?? {};
}

/** Reads UTF-8 file or returns `""` on ENOENT/other errors — used for optional CLI `-o` outputs. */
export async function readOptionalFile(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

/** Shrinks arbitrary task metadata `env` to stringifiable scalar map for subprocess env injection. */
export function normalizeWorkspaceEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1]))
      .map(([key, entryValue]) => [key, String(entryValue)])
  );
}

/** Drops `undefined` process env entries so spreads stay JSON-safe string maps. */
export function stringifyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]]))
  );
}

/** Lightweight `access` probe without swallowing rationale (boolean only). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Stable directory name suffix for cloning mirrors keyed by upstream repo URL. */
export function hashRepo(repo: string): string {
  return createHash("sha1").update(repo).digest("hex");
}

/** Stages where retry may succeed (clone/fetch/worktree/install) vs permanent checkout mismatches. */
function isRetryableEnvironmentStage(stage: string): boolean {
  return ["clone", "fetch", "worktree", "install", "cleanup"].includes(stage);
}

/** Maps raw {@link CommandResult} exit/timeout semantics into stable error buckets for dashboards. */
export function classifyExecutionError(result: CommandResult): ExecutionResult["errorCategory"] {
  if (result.timedOut) {
    return "timeout";
  }
  if (result.exitCode === 127) {
    return "launch_error";
  }
  if (result.exitCode !== 0) {
    return "command_failed";
  }
  return "none";
}

/** Finds first lowercase UUID-ish token anywhere in streamed CLI output. */
export function extractUuid(value: string): string | null {
  const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match?.[0] ?? null;
}

/** Scans newline-delimited JSON objects for Codex-flavored `session_id` / `sessionId` / `id` fields. */
export function extractJsonSessionId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const value = parsed.session_id ?? parsed.sessionId ?? parsed.id;
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Walks JSON lines in Cursor agent stdout for latest `text` / `message` assistant payload. */
export function extractCursorSummary(stdout: string): string | null {
  let summary: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.text === "string" && parsed.text.trim()) {
        summary = parsed.text.trim();
      }
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        summary = parsed.message.trim();
      }
    } catch {
      continue;
    }
  }
  return summary;
}

/** Shortens long argv tokens and scrubs obvious secret-shaped flags for logs/metadata. */
export function redactCommand(command: string[]): string[] {
  return command.map((part) => {
    if (part.length > 80) {
      return `${part.slice(0, 32)}...[redacted:${part.length}]`;
    }
    if (/api[-_]?key|token|secret/i.test(part)) {
      return "[redacted]";
    }
    return part;
  });
}

/** Normalizes prior `governance` metadata to an array and appends the newest plugin record. */
export function appendGovernanceEntry(existing: unknown, entry: Record<string, unknown>): Record<string, unknown>[] {
  const list = Array.isArray(existing)
    ? existing.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
  return [...list, entry];
}

/** Token-level secret heuristics (non-destructive); used pre/post command and around eval reports. */
export function scanSecrets(value: string): string[] {
  const findings: string[] = [];
  if (/sk-[A-Za-z0-9]{20,}/.test(value)) {
    findings.push("OpenAI-style secret detected");
  }
  if (/ghp_[A-Za-z0-9]{20,}/.test(value)) {
    findings.push("GitHub token detected");
  }
  if (/xox[baprs]-[A-Za-z0-9-]{10,}/.test(value)) {
    findings.push("Slack token detected");
  }
  if (/api[_-]?key\s*[=:]/i.test(value)) {
    findings.push("API key assignment detected");
  }
  if (/authorization:\s*bearer/i.test(value)) {
    findings.push("Bearer token detected");
  }
  return [...new Set(findings)];
}

/** Enforces governance allow/binary list, regex blocklist, and max argv length for prompts. */
export function scanCommandPolicy(command: string[], policy: GovernancePolicy): string[] {
  const findings: string[] = [];
  const binary = basename(command[0] ?? "").trim();
  const joined = command.join(" ");
  if (policy.allowCommandPrefixes.length > 0 && !policy.allowCommandPrefixes.includes(binary)) {
    findings.push(`Command binary "${binary || "unknown"}" is not on the allowlist`);
  }
  for (const pattern of policy.blockCommandPatterns) {
    try {
      if (new RegExp(pattern, "i").test(joined)) {
        findings.push(`Command matched blocked policy: ${pattern}`);
      }
    } catch {
      findings.push(`Invalid blocked command pattern: ${pattern}`);
    }
  }
  if (joined.length > policy.maxPromptChars) {
    findings.push(`Command payload exceeded maxPromptChars=${policy.maxPromptChars}`);
  }
  return findings;
}

/** Computes diff-size policy violations complementary to governance `afterEval` hard blocks. */
export function scanEvalRisk(
  diff: { filesChanged: number; changedLines: number },
  policy: GovernancePolicy
): string[] {
  const findings: string[] = [];
  if (diff.filesChanged > policy.maxFilesChanged) {
    findings.push(`filesChanged ${diff.filesChanged} exceeded limit ${policy.maxFilesChanged}`);
  }
  if (diff.changedLines > policy.maxDiffLines) {
    findings.push(`changedLines ${diff.changedLines} exceeded limit ${policy.maxDiffLines}`);
  }
  return findings;
}

/** Caps stored stdout/stderr blobs while preserving truncation marker for auditors. */
export function truncateWithMarker(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 20))}[truncated-output]`;
}

/** Reads `report.diff.{filesChanged, insertions, deletions}` from evaluator JSON into governance-friendly metrics. */
export function readDiffReport(report: Record<string, unknown>): { filesChanged: number; changedLines: number } {
  const diff = report.diff;
  if (!diff || typeof diff !== "object") {
    return { filesChanged: 0, changedLines: 0 };
  }
  const value = diff as Record<string, unknown>;
  const insertions = typeof value.insertions === "number" ? value.insertions : 0;
  const deletions = typeof value.deletions === "number" ? value.deletions : 0;
  return {
    filesChanged: typeof value.filesChanged === "number" ? value.filesChanged : 0,
    changedLines: insertions + deletions
  };
}

/** Recursive tree walk applying {@link SECRET_PATTERNS} to strings — safe-ish JSON export for UI/records. */
export function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern.regex, pattern.replacement), value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, sanitizeUnknown(entryValue)])
    );
  }
  return value;
}

/** Parses plugin config arrays, dropping empties while preserving fallback defaults. */
export function asPolicyStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Validates finite numeric thresholds from plugin JSON; substitutes defaults when absent/invalid. */
export function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Loads JSON array append-only persistence (Meegle `results.json` pattern); tolerant of missing files. */
export async function readJsonArray(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
  } catch {
    return [];
  }
}

/**
 * Strips Markdown link wrappers around clone URLs, e.g.
 * `[git@host](mailto:git@host):group/repo.git` → `git@host:group/repo.git`.
 */
export function normalizeRepoUrl(value: string | null | undefined): string {
  if (value == null) {
    return "";
  }
  const s = value.trim();
  if (!s) {
    return "";
  }

  const markdownTail = /^\[([^\]]+)\]\(([^)]+)\)\s*(:\S[\S]*)?$/;
  const match = s.match(markdownTail);
  if (!match) {
    return s;
  }

  const linkText = match[1].trim();
  const href = match[2].trim();
  const tail = (match[3] ?? "").trim();

  if (linkText.startsWith("git@")) {
    return tail.startsWith(":") ? `${linkText}${tail}` : linkText;
  }
  if (/^https?:\/\//i.test(href)) {
    return href;
  }
  if (/^https?:\/\//i.test(linkText)) {
    return linkText;
  }

  return linkText || s;
}

/** Canonical row → {@link TitingTask}: merges Chinese/English field aliases and seeds trace metadata defaults. */
export function mapMeegleTask(value: unknown, index: number, defaultExecutor = "codex"): TitingTask {
  const row = applyDescriptionFallback((value ?? {}) as Record<string, unknown>);
  const now = new Date();
  const externalId = asNonEmptyString(row.id)
    ?? asNonEmptyString(row.work_item_id)
    ?? asNonEmptyString(row["工作项ID"])
    ?? `meegle-${index + 1}`;
  const title = asNonEmptyString(row.title)
    ?? asNonEmptyString(row.标题)
    ?? asNonEmptyString(row.名称)
    ?? asNonEmptyString(row.name)
    ?? `Meegle task ${externalId}`;
  const instruction = asNonEmptyString(row.instruction)
    ?? asNonEmptyString(row.description)
    ?? asNonEmptyString(row.描述)
    ?? title;
  const repo = normalizeRepoUrl(asNonEmptyString(row.repo) ?? "");
  const branch = asNonEmptyString(row.branch) ?? "main";
  const executor = asNonEmptyString(row.executor) ?? defaultExecutor;
  const priority = asTaskPriority(row.priority);
  return {
    id: `meegle-${externalId}`,
    source: "meegle",
    externalId,
    title,
    instruction,
    repo,
    branch,
    priority,
    status: "created",
    executor,
    traceId: `meegle-${externalId}`,
    constraints: asStringArray(row.constraints),
    acceptanceCriteria: asStringArray(row.acceptanceCriteria),
    metadata: typeof row.metadata === "object" && row.metadata !== null ? row.metadata as Record<string, unknown> : {},
    retryCount: 0,
    repairCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

/** Formats bilingual Meegle comment body with status headline and bounded summary truncation. */
export function buildMeegleResultComment(task: TitingTask, summary: string): string {
  const status = task.status === "done"
    ? "completed"
    : task.status === "failed"
      ? "failed"
      : "updated";
  const headline = `AutoDev Agent ${status} task ${task.id}`;
  const body = summary.trim();
  return body ? `${headline}\n${truncateMeegleComment(body)}` : headline;
}

export function buildMeegleNeedsHumanComment(task: TitingTask, payload: NeedsHumanPayload): string {
  const lines = [
    `AutoDev Agent requires human input for task ${task.id}`,
    payload.reason,
    truncateMeegleComment(payload.summary.trim()),
    `[TITING_NEEDS_HUMAN requestId=${payload.requestId} taskId=${task.id} traceId=${task.traceId}]`,
    "Reply to this comment with the missing context to continue the task."
  ];
  return lines.filter(Boolean).join("\n");
}

/** Strict JSON.parse for CLI stdout; throws deterministic error when wrappers log noise before JSON payload. */
export function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Meegle CLI returned non-JSON output");
  }
}

/**
 * Accepts envelope arrays/nested `{ tasks/items/data/... }` shapes emitted by differing Meegle CLI versions → rows for {@link mapMeegleTask}.
 */
export function extractTaskListPayload(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeMeegleRecord(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.moql_field_list)) {
      return [normalizeMeegleRecord(record)];
    }
    const nested =
      record.tasks ??
      record.items ??
      record.data ??
      record.workItems ??
      record.work_items ??
      record.list ??
      record.records;
    if (Array.isArray(nested)) {
      return nested.map((item) => normalizeMeegleRecord(item));
    }
    if (nested && typeof nested === "object") {
      try {
        return extractTaskListPayload(nested);
      } catch {
        // Fall back to grouped array extraction for shapes like { "1": [...] }.
      }
      const groupedItems = Object.values(nested).filter(Array.isArray).flat();
      if (groupedItems.length > 0) {
        const records = groupedItems.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
        if (records.length > 0) {
          return records.map((item) => normalizeMeegleRecord(item));
        }
      }
    }
  }
  throw new Error("Meegle task list output does not contain tasks");
}

/**
 * Unwraps `{ data }` envelopes and expands `work_item_attribute`/`work_item_fields` records into flattened keys compatible with {@link normalizeMeegleRecord}.
 */
export function extractTaskDetailPayload(value: unknown): Record<string, unknown> {
  const detail = value && typeof value === "object" && (value as Record<string, unknown>).data && typeof (value as Record<string, unknown>).data === "object"
    ? (value as Record<string, unknown>).data
    : value;
  if (!detail || typeof detail !== "object") {
    return {};
  }
  const record = detail as Record<string, unknown>;

  if (record.work_item_attribute && typeof record.work_item_attribute === "object") {
    const attribute = record.work_item_attribute as Record<string, unknown>;
    const normalized: Record<string, unknown> = {
      work_item_id: attribute.work_item_id,
      name: attribute.work_item_name,
      priority: readNestedStatusName(attribute.work_item_status),
      project_key: attribute.owned_project && typeof attribute.owned_project === "object"
        ? (attribute.owned_project as Record<string, unknown>).key ?? (attribute.owned_project as Record<string, unknown>).simple_name
        : undefined
    };

    if (Array.isArray(record.work_item_fields)) {
      const fields: Record<string, unknown> = {};
      for (const field of record.work_item_fields) {
        if (!field || typeof field !== "object") {
          continue;
        }
        const fieldRecord = field as Record<string, unknown>;
        const key = unwrapScalar(fieldRecord.key) ?? unwrapScalar(fieldRecord.name);
        if (!key) {
          continue;
        }
        fields[key] = fieldRecord.value;
      }
      normalized.fields = fields;
    }

    return normalizeMeegleRecord(normalized);
  }

  return normalizeMeegleRecord(record);
}

/** Validates presence of canonical `id`, maps synonymous fields, prepares merge-friendly row for downstream tasks. */
function normalizeMeegleRecord(value: unknown): Record<string, unknown> {
  const normalizedValue = normalizeMoqlRecordIfNeeded(value);
  if (!normalizedValue || typeof normalizedValue !== "object") {
    throw new Error("Meegle task output is missing id");
  }
  const record = normalizedValue as Record<string, unknown>;
  const id = readMeegleString(record, ["id", "workItemId", "work_item_id", "workitem_id", "工作项ID", "工作项id"]);
  if (!id) {
    throw new Error("Meegle task output is missing id");
  }
  return {
    id,
    title: readMeegleString(record, ["title", "name", "名称"]) ?? "",
    description: readMeegleString(record, ["description", "desc", "描述"]),
    repo: normalizeRepoUrl(readMeegleString(record, ["repo", "repository", "代码库", "仓库"]) ?? undefined),
    branch: readMeegleString(record, ["branch", "分支"]),
    instruction: readMeegleString(record, ["instruction", "prompt", "指令"]),
    priority: readMeegleString(record, ["priority", "优先级", "status", "状态"]),
    projectKey: readMeegleString(record, ["projectKey", "project_key", "项目key", "空间key"])
  };
}

/** When CLI returns `{ moql_field_list: [...] }`, materializes keyed map + mirrored `fields` bag for parsers. */
function normalizeMoqlRecordIfNeeded(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).moql_field_list)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  for (const entry of (value as Record<string, unknown>).moql_field_list as unknown[]) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const key = unwrapScalar(record.key);
    const name = unwrapScalar(record.name);
    const fieldValue = record.value;
    if (key) {
      normalized[key] = fieldValue;
      fields[key] = fieldValue;
    }
    if (name) {
      normalized[name] = fieldValue;
      fields[name] = fieldValue;
    }
  }
  normalized.fields = fields;
  return normalized;
}

/** Joins sparse list-row with richer detail GET; metadata objects shallow-merged when both sides expose them. */
export function mergeMeegleTaskRecords(
  listItem: Record<string, unknown>,
  detail: Record<string, unknown>,
  projectKey?: string
): Record<string, unknown> {
  return {
    id: detail.id ?? listItem.id,
    title: detail.title || listItem.title,
    description: detail.description ?? listItem.description ?? null,
    repo: normalizeRepoUrl(asNonEmptyString(detail.repo ?? listItem.repo) ?? undefined) || null,
    branch: detail.branch ?? listItem.branch ?? null,
    instruction: detail.instruction ?? listItem.instruction ?? null,
    priority: detail.priority ?? listItem.priority ?? null,
    projectKey: detail.projectKey ?? listItem.projectKey ?? projectKey ?? null,
    metadata: {
      ...(typeof listItem.metadata === "object" && listItem.metadata !== null ? listItem.metadata as Record<string, unknown> : {}),
      ...(typeof detail.metadata === "object" && detail.metadata !== null ? detail.metadata as Record<string, unknown> : {})
    }
  };
}

/** When repo/instruction omitted, parses Meegle description block separated by `---` for Repo/Branch/LocalPath metadata. */
export function applyDescriptionFallback(task: Record<string, unknown>): Record<string, unknown> {
  const repo = asNonEmptyString(task.repo);
  const instruction = asNonEmptyString(task.instruction);
  if (repo && instruction) {
    return task;
  }
  const description = asNonEmptyString(task.description) ?? asNonEmptyString(task.描述);
  if (!description) {
    return task;
  }
  try {
    const parsed = parseDescriptionBlock(description);
    return {
      ...task,
      repo: normalizeRepoUrl(repo || parsed.localPath || parsed.repo || ""),
      branch: normalizeStoredBranch(asNonEmptyString(task.branch) || parsed.branch),
      instruction: instruction || parsed.instruction
    };
  } catch {
    return task;
  }
}

/** Looks up camel/snake/zh keys on Meegle objects, including nested `fields` blobs from detail APIs. */
function readMeegleString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const direct = unwrapScalar(value[key]);
    if (direct) {
      return direct;
    }
  }

  for (const containerKey of ["fields", "field_values", "fieldValues", "custom_fields", "customFields"]) {
    const container = value[containerKey];
    if (!container || typeof container !== "object") {
      continue;
    }
    const record = container as Record<string, unknown>;
    for (const key of keys) {
      const nested = unwrapScalar(record[key]);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

/** Coerces Meegle field wrapper objects (`value`, `display_value`, etc.) down to display strings. */
function unwrapScalar(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => unwrapScalar(item)).filter((item): item is string => Boolean(item));
    return items.length > 0 ? items.join(", ") : null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of [
    "value",
    "text",
    "label",
    "name",
    "display_value",
    "displayValue",
    "string_value",
    "long_value",
    "double_value",
    "float_value",
    "bool_value",
    "key_label_value_list"
  ]) {
    const nested = unwrapScalar(record[key]);
    if (nested) {
      return nested;
    }
  }
  return null;
}

/** Extracts human-readable status label from nested status objects in work item attributes. */
function readNestedStatusName(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return unwrapScalar(record.name) ?? unwrapScalar(record.status_name) ?? unwrapScalar(record.label);
}

/** Falls back to `main` when branch metadata blank after description parsing. */
function normalizeStoredBranch(branch?: string | null): string {
  return branch?.trim() || "main";
}

/** Detects legacy `task` subcommand missing on newer CLIs so {@link MeegleTaskIntegrationPlugin.tryPullLegacyCliTasks} can bail out. */
export function shouldFallbackToWorkitemCli(args: string[], result: CommandResult): boolean {
  const stderr = result.stderr || "";
  const stdout = result.stdout || "";
  return args[0] === "task" && /unknown command|command not found/i.test(`${stderr}\n${stdout}`);
}

/** Keeps Meegle comment API payloads within typical UI limits. */
function truncateMeegleComment(value: string): string {
  return value.length > 2000 ? `${value.slice(0, 2000)}\n...[truncated]` : value;
}

/** Parses `Repo:` / `Branch:` / `LocalPath:` preamble followed by `\n---\n` fenced instruction region. */
function parseDescriptionBlock(description: string): {
  repo: string;
  branch?: string;
  localPath?: string;
  instruction: string;
} {
  const normalized = description.replace(/\r\n/g, "\n").trim();
  const separator = normalized.match(/\n\s*---\s*\n/);
  if (!separator || separator.index === undefined) {
    throw new Error("description missing metadata separator");
  }
  const header = normalized.slice(0, separator.index).split("\n");
  const instruction = normalized.slice(separator.index + separator[0].length).trim();
  if (!instruction) {
    throw new Error("description missing instruction");
  }

  let repo: string | undefined;
  let branch: string | undefined;
  let localPath: string | undefined;

  for (const rawLine of header) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("Repo:")) {
      repo = normalizeRepoUrl(normalizeMetadataValue(line.slice("Repo:".length)));
      continue;
    }
    if (line.startsWith("Branch:")) {
      branch = normalizeMetadataValue(line.slice("Branch:".length)) || undefined;
      continue;
    }
    if (line.startsWith("LocalPath:")) {
      localPath = normalizeMetadataValue(line.slice("LocalPath:".length)) || undefined;
      continue;
    }
    if (line === "Constraints:" || line.startsWith("- ")) {
      continue;
    }
  }

  if (!repo) {
    throw new Error("description missing repo");
  }

  return {
    repo,
    branch,
    localPath: localPath ? resolve(localPath) : undefined,
    instruction
  };
}

/** Strips markdown link syntax so `Repo:` lines accept `[text](url)` style inputs. */
function normalizeMetadataValue(value: string): string {
  const trimmed = value.trim();
  const markdownLink = trimmed.match(/^\[(.+?)\]\((.+?)\)$/);
  if (markdownLink) {
    return markdownLink[2].trim();
  }
  return trimmed;
}

/** Null-safe trimming guard used across CLI field coercion. */
export function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Parses task constraint / acceptance bullet lists while dropping blanks. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

/** Normalizes textual/Pn-ish priority indicators into coarse high/medium/low buckets. */
function asTaskPriority(value: unknown): TitingTask["priority"] {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  if (normalized === "p0" || normalized === "p1") {
    return "high";
  }
  if (normalized === "p2" || normalized === "p3") {
    return "medium";
  }
  if (normalized && /^p[4-9]$/.test(normalized)) {
    return "low";
  }
  return "medium";
}
