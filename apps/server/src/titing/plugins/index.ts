/**
 * Built-in Titing plugins: task integration, workspace prep, executors, quality gate, governance.
 * Order in {@link createBuiltinPlugins} matters for discovery; governance is shared with executors for hooks.
 */
import { ServerConfig } from "../config";
import { CodexExecutionPlugin, CursorExecutionPlugin } from "./execution";
import { LocalWorktreeEnvironmentPlugin } from "./environment";
import { DefaultObservabilityGovernancePlugin } from "./governance";
import { MeegleTaskIntegrationPlugin } from "./meegle";
import { DefaultQualityPlugin } from "./quality";

export { CodexExecutionPlugin, CursorExecutionPlugin } from "./execution";
export { EnvironmentPreparationError, LocalWorktreeEnvironmentPlugin } from "./environment";
export { DefaultObservabilityGovernancePlugin } from "./governance";
export { MeegleTaskIntegrationPlugin } from "./meegle";
export { DefaultQualityPlugin } from "./quality";

/**
 * Instantiates the default plugin stack for a server run: Meegle → env → Codex/Cursor executors → quality → governance.
 * `governance` is passed into Codex/Cursor so `beforeCommand` / `afterCommand` wrap each CLI invocation.
 */
export function createBuiltinPlugins(config: ServerConfig) {
  const governance = new DefaultObservabilityGovernancePlugin(config.governance);
  return [
    new MeegleTaskIntegrationPlugin(config),
    new LocalWorktreeEnvironmentPlugin(config),
    new CodexExecutionPlugin(config.plugins.execution.codexBin, config.goalRecovery.executionTimeoutMs, governance),
    new CursorExecutionPlugin(config.plugins.execution.cursorBin, config.goalRecovery.executionTimeoutMs, governance),
    new DefaultQualityPlugin(config.goalRecovery.qualityTimeoutMs),
    governance
  ];
}
