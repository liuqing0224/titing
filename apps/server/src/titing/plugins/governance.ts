import {
  EvalResult,
  GovernanceRecord,
  ObservabilityGovernancePlugin,
  PluginConfig,
  PluginHealth
} from "@titing/plugin-api";
import {
  appendGovernanceEntry,
  asPolicyStringArray,
  asPositiveNumber,
  GovernancePolicy,
  readDiffReport,
  redactCommand,
  sanitizeUnknown,
  scanCommandPolicy,
  scanEvalRisk,
  scanSecrets,
  SECRET_PATTERNS,
  truncateWithMarker
} from "./shared";

/**
 * Central policy enforcement: blocks dangerous commands before run, redacts/truncates output after run,
 * and flags or fails eval reports when diff/size or secrets exceed limits. Maintains an in-memory record ring buffer.
 */
export class DefaultObservabilityGovernancePlugin implements ObservabilityGovernancePlugin {
  readonly id = "default-observability-governance";
  readonly kind = "observability-governance" as const;
  readonly priority = 100;
  readonly capabilities = ["default"];
  private readonly records: GovernanceRecord[] = [];
  private policy: GovernancePolicy;

  constructor(defaults?: Partial<GovernancePolicy>) {
    this.policy = {
      allowCommandPrefixes: defaults?.allowCommandPrefixes ?? [],
      blockCommandPatterns: defaults?.blockCommandPatterns ?? [
        "\\bgit\\s+push\\b",
        "\\brm\\s+-rf\\s+/",
        "\\bterraform\\s+destroy\\b",
        "\\baws\\s+iam\\b",
        "\\bssh\\b",
        "\\bscp\\b"
      ],
      maxPromptChars: defaults?.maxPromptChars ?? 16000,
      maxOutputChars: defaults?.maxOutputChars ?? 12000,
      maxFilesChanged: defaults?.maxFilesChanged ?? 20,
      maxDiffLines: defaults?.maxDiffLines ?? 400
    };
  }

  /** Merges optional plugin runtime config into defaults (allow/block lists, size caps). */
  async init(config: PluginConfig | null): Promise<void> {
    const next = config?.config ?? {};
    this.policy = {
      allowCommandPrefixes: asPolicyStringArray(next.allowCommandPrefixes),
      blockCommandPatterns: asPolicyStringArray(next.blockCommandPatterns, this.policy.blockCommandPatterns),
      maxPromptChars: asPositiveNumber(next.maxPromptChars, 16000),
      maxOutputChars: asPositiveNumber(next.maxOutputChars, 12000),
      maxFilesChanged: asPositiveNumber(next.maxFilesChanged, 20),
      maxDiffLines: asPositiveNumber(next.maxDiffLines, 400)
    };
  }

  /** Reports cumulative governance record count (capped internally). */
  async health(): Promise<PluginHealth> {
    return {
      healthy: true,
      message: `Default observability and governance plugin active (${this.records.length} records)`
    };
  }

  /**
   * Pre-flight: scan argv for secrets + policy (allowlist, block regexes, payload size).
   * On hit: append blocked record and throw → executor interprets as governance_blocked.
   */
  async beforeCommand(command: string[]): Promise<void> {
    const joined = command.join(" ");
    const findings = [
      ...scanSecrets(joined),
      ...scanCommandPolicy(command, this.policy)
    ];
    if (findings.length > 0) {
      this.pushRecord({
        phase: "before_command",
        outcome: "blocked",
        message: "Governance blocked command before execution",
        findings,
        metadata: {
          command: redactCommand(command),
          estimatedPromptChars: joined.length
        }
      });
      throw new Error(`Governance blocked command: ${findings.join("; ")}`);
    }
    this.pushRecord({
      phase: "before_command",
      outcome: "allowed",
      message: "Governance allowed command execution",
      findings: [],
      metadata: {
        command: redactCommand(command),
        estimatedPromptChars: joined.length
      }
    });
  }

  /**
   * Post-command: redact stdout/stderr/summary in place, truncate oversized streams, scan for secrets,
   * attach governance array on `result.metadata.governance`.
   */
  async afterCommand(command: string[], result: any): Promise<void> {
    result.stdout = this.redact(result.stdout);
    result.stderr = this.redact(result.stderr);
    result.summary = this.redact(result.summary);

    const findings = [
      ...scanSecrets(result.stdout),
      ...scanSecrets(result.stderr),
      ...scanSecrets(result.summary)
    ];
    const estimatedOutputChars = result.stdout.length + result.stderr.length + result.summary.length;
    let outputTruncated = false;
    if (result.stdout.length > this.policy.maxOutputChars) {
      result.stdout = truncateWithMarker(result.stdout, this.policy.maxOutputChars);
      outputTruncated = true;
    }
    if (result.stderr.length > this.policy.maxOutputChars) {
      result.stderr = truncateWithMarker(result.stderr, this.policy.maxOutputChars);
      outputTruncated = true;
    }

    const outcome = findings.length > 0 || outputTruncated ? "flagged" : "allowed";
    const message = outcome === "allowed"
      ? "Governance post-command checks passed"
      : "Governance sanitized command output";
    const governanceEntry: Omit<GovernanceRecord, "recordedAt"> = {
      pluginId: this.id,
      phase: "after_command",
      outcome,
      message,
      findings,
      metadata: {
        command: redactCommand(command),
        outputTruncated,
        estimatedOutputChars
      }
    };
    result.metadata = {
      ...result.metadata,
      governance: appendGovernanceEntry(result.metadata.governance, governanceEntry)
    };
    this.pushRecord(governanceEntry);
  }

  /**
   * Post-eval: sanitize report, derive diff metrics, flag secret/risk findings; hard-fails eval if diff exceeds policy caps.
   */
  async afterEval(result: EvalResult): Promise<void> {
    result.report = sanitizeUnknown(result.report) as Record<string, unknown>;
    const diff = readDiffReport(result.report);
    const findings = [
      ...scanSecrets(JSON.stringify(result.report)),
      ...scanEvalRisk(diff, this.policy)
    ];
    let outcome: GovernanceRecord["outcome"] = "allowed";
    let message = "Governance post-eval checks passed";
    if (findings.length > 0) {
      outcome = "flagged";
      message = "Governance flagged evaluation output";
    }
    if (diff.filesChanged > this.policy.maxFilesChanged || diff.changedLines > this.policy.maxDiffLines) {
      result.passed = false;
      result.riskLevel = "high";
      outcome = "blocked";
      message = "Governance blocked evaluation because diff risk exceeded policy";
    }
    result.report = {
      ...result.report,
      governance: appendGovernanceEntry(result.report.governance, {
        pluginId: this.id,
        phase: "after_eval",
        outcome,
        message,
        findings,
        metadata: {
          filesChanged: diff.filesChanged,
          changedLines: diff.changedLines,
          maxFilesChanged: this.policy.maxFilesChanged,
          maxDiffLines: this.policy.maxDiffLines
        }
      })
    };
    this.pushRecord({
      phase: "after_eval",
      outcome,
      message,
      findings,
      metadata: {
        filesChanged: diff.filesChanged,
        changedLines: diff.changedLines
      }
    });
  }

  /** Applies {@link SECRET_PATTERNS} replacements (used by executors too). */
  redact(value: string): string {
    return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern.regex, pattern.replacement), value);
  }

  /** Snapshot of recent governance entries (copy). */
  getRecords(): GovernanceRecord[] {
    return [...this.records];
  }

  /** Appends timestamped record and trims to last 200 entries. */
  private pushRecord(record: Omit<GovernanceRecord, "recordedAt">): void {
    this.records.push({
      ...record,
      recordedAt: new Date().toISOString()
    });
    if (this.records.length > 200) {
      this.records.splice(0, this.records.length - 200);
    }
  }
}
