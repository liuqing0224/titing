/**
 * Built-in Titing plugins: file logs, task integration, workspace prep, executors, quality, governance.
 * Order in {@link createBuiltinPlugins} is stable for listing; capability/priority selection uses `PluginRuntime`.
 */
import { ServerConfig } from "../config";
import { PluginKind, RuntimePlugin } from "@titing/plugin-api";
import { CodexExecutionPlugin, CursorExecutionPlugin } from "./execution";
import { LocalWorktreeEnvironmentPlugin } from "./environment";
import { DefaultObservabilityGovernancePlugin } from "./governance";
import { RootLogsPlugin } from "./log";
import { MeegleTaskIntegrationPlugin } from "./meegle";
import { DefaultQualityPlugin } from "./quality";

export { CodexExecutionPlugin, CursorExecutionPlugin } from "./execution";
export { EnvironmentPreparationError, LocalWorktreeEnvironmentPlugin } from "./environment";
export { DefaultObservabilityGovernancePlugin } from "./governance";
export { RootLogsPlugin } from "./log";
export { MeegleTaskIntegrationPlugin } from "./meegle";
export { DefaultQualityPlugin } from "./quality";
export { createSkeletonPlugins } from "./skeletons";

export type BuiltinPluginGroups = Record<
  "log" | "task-integration" | "environment" | "execution" | "quality" | "observability-governance",
  RuntimePlugin[]
>;

/**
 * Instantiates the default plugin stack grouped by kind so individual kinds can be overridden by external packages.
 * `governance` is passed into Codex/Cursor so `beforeCommand` / `afterCommand` wrap each CLI invocation.
 */
export function createBuiltinPluginGroups(config: ServerConfig): BuiltinPluginGroups {
  const governance = new DefaultObservabilityGovernancePlugin(config.governance);
  return {
    log: [new RootLogsPlugin()],
    "task-integration": [new MeegleTaskIntegrationPlugin(config)],
    environment: [new LocalWorktreeEnvironmentPlugin(config)],
    execution: [
      new CodexExecutionPlugin(config.plugins.execution.codexBin, config.goalRecovery.executionTimeoutMs, governance),
      new CursorExecutionPlugin(config.plugins.execution.cursorBin, config.goalRecovery.executionTimeoutMs, governance)
    ],
    quality: [new DefaultQualityPlugin(config.goalRecovery.qualityTimeoutMs)],
    "observability-governance": [governance]
  };
}

/**
 * Instantiates the default plugin stack: root logs → Meegle → env → Codex/Cursor → quality → governance.
 * `governance` is passed into Codex/Cursor so `beforeCommand` / `afterCommand` wrap each CLI invocation.
 */
export function createBuiltinPlugins(config: ServerConfig) {
  const groups = createBuiltinPluginGroups(config);
  return [
    ...groups.log,
    ...groups["task-integration"],
    ...groups.environment,
    ...groups.execution,
    ...groups.quality,
    ...groups["observability-governance"]
  ];
}
