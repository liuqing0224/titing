import { ServerPluginManifest } from "@autodev-agent/plugin-api";
import { MeeglePluginModule } from "./meegle-plugin.module";
import { MeegleResultReporterPlugin } from "./meegle-result-reporter.plugin";
import { MeegleTaskSourcePlugin } from "./meegle-task-source.plugin";

export const meeglePluginManifest: ServerPluginManifest = {
  id: "meegle",
  priority: 100,
  kind: "composite",
  module: MeeglePluginModule,
  taskSources: [MeegleTaskSourcePlugin],
  resultReporters: [MeegleResultReporterPlugin]
};
