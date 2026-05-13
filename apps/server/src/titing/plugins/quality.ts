import { PluginHealth, PreparedWorkspace, QualityPlugin, QualityResult, TitingTask, ExecutionResult } from "@titing/plugin-api";
import { calculateQualityScore, collectDiffRisk, deriveRiskLevel, runQualityScripts } from "./shared";

/** Runs optional `package.json` scripts (lint/typecheck/test/build), diff stats, then derives pass/fail and score. */
export class DefaultQualityPlugin implements QualityPlugin {
  readonly id = "default-quality";
  readonly kind = "quality" as const;
  readonly priority = 100;
  readonly capabilities = ["default"];

  constructor(private readonly timeoutMs: number) {}

  /** Always healthy; messaging only. */
  async health(): Promise<PluginHealth> {
    return { healthy: true, message: "Script-based quality gate enabled" };
  }

  /**
   * Quality chain: npm scripts (if present) → git diff/size risk → combine with executor exitCode/timeout → `acceptanceCriteria` check row.
   * Pass requires clean exit, all non-skipped scripts OK, and risk not `high`.
   */
  async evaluate(input: { execution: ExecutionResult; task: TitingTask; workspace: PreparedWorkspace }): Promise<QualityResult> {
    const scriptCommands = await runQualityScripts(input.workspace, this.timeoutMs);
    const diffReport = await collectDiffRisk(input.workspace, this.timeoutMs);
    const exitCodePassed = input.execution.exitCode === 0;
    const commandChecks = scriptCommands.map((command) => ({
      name: command.name,
      passed: command.passed,
      detail: command.detail
    }));
    const riskLevel = deriveRiskLevel(diffReport, scriptCommands, input.execution.timedOut);
    const acceptancePassed = exitCodePassed && commandChecks.every((check) => check.passed) && riskLevel !== "high";
    const passed = acceptancePassed;

    return {
      passed,
      score: calculateQualityScore(exitCodePassed, scriptCommands, riskLevel),
      riskLevel,
      checks: [
        {
          name: "executor-exit-code",
          passed: exitCodePassed,
          detail: exitCodePassed ? "Executor exited cleanly" : `Exit code ${input.execution.exitCode}`
        },
        ...commandChecks,
        {
          name: "diff-risk",
          passed: riskLevel !== "high",
          detail: `files=${diffReport.filesChanged}, insertions=${diffReport.insertions}, deletions=${diffReport.deletions}, risk=${riskLevel}`
        },
        {
          name: "acceptance-criteria",
          passed: acceptancePassed,
          detail: input.task.acceptanceCriteria.length > 0
            ? `Inferred from automation: ${input.task.acceptanceCriteria.join("; ")}`
            : "No explicit acceptance criteria"
        }
      ],
      report: {
        timedOut: input.execution.timedOut,
        scripts: scriptCommands,
        diff: diffReport
      }
    };
  }
}
